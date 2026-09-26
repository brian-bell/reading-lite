// `ops corpus purge-legacy` — delete one tenant's manifest-era R2 objects that
// no PostgreSQL row references (reading-lite-gh351.5).
//
// Since the 2026-09-24 cutover the rows are the record and nothing reads the
// old layout: each reading's manifest.json, attempts/ logs and processing/
// checkpoints, index/list.json,
// the by-url and by-id pointers, the purge tombstones, the operator's
// refresh-state.json, legacy-spelled content a reprocess superseded, and
// prefixes with no row at all. scripts/corpus-lib/legacy-objects.ts decides
// which object is which; anything it does not recognise stays.
//
// Order is most of the safety argument. The listing comes first and the rows
// second, so every listed object whose reading has a row is seen with that
// row. Execute builds its own plan the same way, then re-checks each
// reading's keys, or its absence, immediately before deleting per-reading
// objects, and finally lists again to prove nothing classified as legacy is
// left.
//
// Order cannot settle an orphan prefix. An import writes its revision objects
// to R2 before claimUrl commits the row that points at them (captureArtifacts),
// so a prefix with no row may be a claim in flight, and no listing or re-check
// can tell it from a dead one. Deleting orphan prefixes therefore requires
// --sole-writer: the operator asserts the realtime writer is paused and
// drained. Everything else the sweep removes is a key no live writer creates,
// so a run with no orphan prefixes needs no pause.
//
// Pointed at the wrong database, every prefix would look orphaned. A tenant
// whose rows are missing therefore trips --max-orphan-prefixes before any
// delete, rather than losing its content to a pairing mistake.

import { parseArgs } from "node:util";
import type { R2ObjectMeta } from "../../lib/cf-clients";
import { loadDotVars } from "../../lib/dotvars";
import { mapWithConcurrency } from "../../lib/concurrency";
import { resolveBucket } from "../../corpus-lib/config";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { classifyLegacyObjects, type LegacyPlan, type LegacyReading, type Removal } from "../../corpus-lib/legacy-objects";
import { operatorKeyRoot } from "../../corpus-lib/tenant";
import { DATABASE_URL_ENV_FLAG_HELP, openOperatorSql, type OpenOperatorSql } from "../../pg-lib/operator-db";
import { contentKeysFor, requireTenantRows, withOperatorCorpus } from "../../pg-lib/operator-corpus";
import type { PgReadingStore } from "../../../src/modules/stores/postgres/reading-store";
import type { SqlQuery } from "../../../src/modules/db/sql";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant, TENANT_FLAG_HELP } from "../tenant-flag";

export interface LegacyStorage {
  listObjects(prefix: string): Promise<R2ObjectMeta[]>;
  delete(key: string): Promise<void>;
}

export interface CorpusPurgeLegacyDeps extends BaseDeps {
  createStorage: (bucket: string) => Promise<LegacyStorage>;
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
}

const DEFAULT_MAX_ORPHAN_PREFIXES = 25;
const DELETE_CONCURRENCY = 8;

interface Args {
  bucket: string;
  tenant: string | undefined;
  databaseUrlEnv: string | undefined;
  execute: boolean;
  soleWriter: boolean;
  maxOrphanPrefixes: number;
}

function parsePurgeArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        tenant: { type: "string" },
        "database-url-env": { type: "string" },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        "max-orphan-prefixes": { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const max = values["max-orphan-prefixes"] ?? String(DEFAULT_MAX_ORPHAN_PREFIXES);
  if (!/^\d+$/.test(max)) throw new UsageError("--max-orphan-prefixes takes a non-negative integer");
  return {
    bucket: resolveBucket(values.bucket),
    tenant: values.tenant,
    databaseUrlEnv: values["database-url-env"],
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    maxOrphanPrefixes: Number(max),
  };
}

interface Snapshot {
  plan: LegacyPlan;
  readings: number;
  orphanPrefixes: string[];
}

// Listing first, rows second: see the header.
async function snapshot(
  storage: LegacyStorage,
  sql: SqlQuery,
  store: PgReadingStore,
  tenantId: string,
  keyRoot: string,
): Promise<Snapshot> {
  const listed = await storage.listObjects(keyRoot);
  const keys = listed
    .map((object) => object.key)
    .filter((key) => key.startsWith(keyRoot))
    .map((key) => key.slice(keyRoot.length))
    .sort();
  const rows = await sql.query<{ id: string; key_prefix: string }>(
    "SELECT id, key_prefix FROM readings WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );
  const readings: LegacyReading[] = [];
  for (const row of rows) {
    readings.push({
      id: row.id,
      keyPrefix: row.key_prefix,
      referenced: new Set(await contentKeysFor(sql, store, tenantId, row.id)),
    });
  }
  const plan = classifyLegacyObjects(keys, readings);
  const orphanPrefixes = [
    ...new Set(plan.remove.filter((r) => r.reason === "orphan_prefix").map((r) => r.prefix!)),
  ].sort();
  return { plan, readings: readings.length, orphanPrefixes };
}

function countBy<T extends string>(items: { reason: T }[]): [T, number][] {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function report(io: CommandIo, snap: Snapshot): void {
  const { plan } = snap;
  io.stdout(`Readings (rows): ${snap.readings}`);
  io.stdout(`Objects listed: ${plan.remove.length + plan.keep.length}`);
  io.stdout(`\nTo delete (${plan.remove.length}):`);
  for (const [reason, n] of countBy(plan.remove)) io.stdout(`  ${reason.padEnd(20)} ${n}`);
  io.stdout(`To keep (${plan.keep.length}):`);
  for (const [reason, n] of countBy(plan.keep)) io.stdout(`  ${reason.padEnd(20)} ${n}`);

  // Named one by one: the removals that are content rather than bookkeeping,
  // and everything kept for a reason the operator should look at.
  const superseded = plan.remove.filter((r) => r.reason === "superseded_content");
  if (superseded.length) {
    io.stdout("\nSuperseded legacy content (no row references it):");
    for (const r of superseded) io.stdout(`  ${r.key}`);
  }
  if (snap.orphanPrefixes.length) {
    io.stdout("\nOrphan prefixes (no reading row):");
    for (const prefix of snap.orphanPrefixes) {
      const n = plan.remove.filter((r) => r.prefix === prefix && r.reason === "orphan_prefix").length;
      io.stdout(`  ${prefix}/  ${n} object(s)`);
    }
  }
  const odd = plan.keep.filter((k) => k.reason === "unrecognized" || k.reason === "prefix_id_mismatch");
  if (odd.length) {
    io.stdout("\nKept, not recognised as legacy (inspect by hand):");
    for (const k of odd) io.stdout(`  ${k.reason}  ${k.key}`);
  }
}

// Immediately before deleting a reading's objects, re-ask the database. A
// superseded key the reading references again stays; an orphan prefix that
// has gained a row stays whole.
async function stillRemovable(
  sql: SqlQuery,
  store: PgReadingStore,
  tenantId: string,
  group: Removal[],
): Promise<Set<string>> {
  const first = group[0]!;
  if (first.reason === "orphan_prefix") {
    const rows = await sql.query<{ id: string }>(
      "SELECT id FROM readings WHERE tenant_id = $1 AND (id = $2 OR key_prefix = $3)",
      [tenantId, first.readingId!, first.prefix!],
    );
    return new Set(rows.length === 0 ? group.map((r) => r.key) : []);
  }
  const referenced = new Set(await contentKeysFor(sql, store, tenantId, first.readingId!));
  const [row] = await sql.query<{ key_prefix: string }>(
    "SELECT key_prefix FROM readings WHERE tenant_id = $1 AND id = $2",
    [tenantId, first.readingId!],
  );
  if (!row || row.key_prefix !== first.prefix) return new Set();
  return new Set(group.filter((r) => !referenced.has(r.key)).map((r) => r.key));
}

async function runCorpusPurgeLegacy(argv: string[], deps: CorpusPurgeLegacyDeps): Promise<number> {
  const args = parsePurgeArgs(argv);
  const { io } = deps;
  const selector = requireOperatorTenant(args.tenant);
  requireTenantRows(selector);
  const keyRoot = operatorKeyRoot(selector, false);

  return withOperatorCorpus(
    { bucket: args.bucket, tenant: selector, databaseUrlEnv: args.databaseUrlEnv },
    deps.env,
    deps.openSql,
    async ({ sql, tenantId, store }) => {
      const storage = await deps.createStorage(args.bucket);
      io.stdout(`Bucket: ${args.bucket}`);
      io.stdout(`Tenant: ${tenantId}  (root ${keyRoot})`);
      io.stdout(`Mode: ${args.execute ? "EXECUTE" : "PLAN"}`);

      const snap = await snapshot(storage, sql, store, tenantId, keyRoot);
      report(io, snap);

      if (snap.orphanPrefixes.length > args.maxOrphanPrefixes) {
        io.stderr(
          `\n✗ ${snap.orphanPrefixes.length} orphan prefixes exceeds --max-orphan-prefixes ${args.maxOrphanPrefixes}. ` +
            "A tenant whose rows are missing looks like this: check that the bucket and database are the same " +
            "environment before raising the limit. Nothing was deleted.",
        );
        return 1;
      }
      if (!args.execute) {
        const flags = snap.orphanPrefixes.length ? "--execute --sole-writer (writer paused)" : "--execute";
        io.stdout(`\nPLAN — nothing changed. Re-run with ${flags} to delete.`);
        return 0;
      }
      // An orphan prefix may be an import between its R2 writes and its claim:
      // see the header.
      if (snap.orphanPrefixes.length > 0) {
        const verdict = soleWriterGuard({
          execute: true,
          acknowledged: args.soleWriter,
          tool: "ops corpus purge-legacy (orphan prefixes)",
        });
        if (verdict.message) io.stderr(`\n${verdict.message}`);
        if (!verdict.proceed) {
          io.stderr("Nothing was deleted.");
          return 1;
        }
      }

      // Bookkeeping objects first (nothing a row resolves), then each
      // reading's content under its own re-check.
      const perReading = new Map<string, Removal[]>();
      const bookkeeping: Removal[] = [];
      for (const removal of snap.plan.remove) {
        if (removal.reason === "superseded_content" || removal.reason === "orphan_prefix") {
          const group = perReading.get(removal.prefix!) ?? [];
          group.push(removal);
          perReading.set(removal.prefix!, group);
        } else bookkeeping.push(removal);
      }
      const failed: string[] = [];
      let deleted = 0;
      const remove = (keys: string[]) =>
        mapWithConcurrency(keys, DELETE_CONCURRENCY, async (key) => {
          try {
            await storage.delete(`${keyRoot}${key}`);
            deleted++;
          } catch {
            failed.push(key);
          }
        });
      await remove(bookkeeping.map((r) => r.key));
      let skipped = 0;
      for (const group of perReading.values()) {
        const removable = await stillRemovable(sql, store, tenantId, group);
        skipped += group.length - removable.size;
        await remove(group.filter((r) => removable.has(r.key)).map((r) => r.key));
      }
      io.stdout(`\nDeleted: ${deleted}`);
      if (skipped) io.stdout(`Skipped after re-check (a row references them now): ${skipped}`);
      for (const key of failed.sort()) io.stderr(`  ! delete error  ${key}`);

      const after = await snapshot(storage, sql, store, tenantId, keyRoot);
      if (after.plan.remove.length === 0 && failed.length === 0) {
        io.stdout("Verified: a fresh listing finds no legacy objects under the tenant root.");
        return 0;
      }
      io.stderr(
        `\n✗ ${after.plan.remove.length} legacy object(s) remain after execute` +
          (failed.length ? `, ${failed.length} delete error(s)` : "") +
          ". Re-run to plan them again.",
      );
      return 1;
    },
  );
}

export const corpusPurgeLegacyCommand: CommandDefinition<CorpusPurgeLegacyDeps> = {
  group: "corpus",
  name: "purge-legacy",
  summary: "Delete a tenant's manifest-era R2 objects that no row references",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus purge-legacy --tenant <usr_…> [options]

Lists the tenant's R2 root, reads its reading rows, and classifies every
object. Deletes only objects with a legacy reason: manifest.json, attempts/
logs, processing/ checkpoints, index/list.json, index/refresh-state.json, by-url/by-id pointers,
purge tombstones, superseded legacy-spelled raw.{ext}/extracted.md, and
prefixes with no reading row. Keeps every key a row can resolve, every
revisions/ object, index/refresh-cursor.json, and anything unrecognised.

Options:
  ${TENANT_FLAG_HELP}
                   'global' is refused: the pre-tenant layout has no rows.
  --bucket <name>  R2 bucket; selects the database. Default: READING_LITE_BUCKET / reading-lite.
  ${DATABASE_URL_ENV_FLAG_HELP}
  --max-orphan-prefixes <n>
                   Refuse when more prefixes than this have no row (default ${DEFAULT_MAX_ORPHAN_PREFIXES}).
  --execute        Delete, re-checking each reading first, then list again to verify.
  --sole-writer    Required with --execute when the plan has orphan prefixes: assert
                   the realtime writer is paused and drained. An import writes its
                   content before its row commits, so a rowless prefix may be in flight.
  --help           Show this message.`,
  defaultDeps: (io: CommandIo): CorpusPurgeLegacyDeps => ({
    io,
    openSql: openOperatorSql,
    env: process.env,
    createStorage: async (bucket) => {
      const { r2InventoryClientFromVars } = await import("../../lib/cf-clients");
      const vars = { ...loadDotVars(".corpus.vars"), ...process.env };
      const client = r2InventoryClientFromVars(vars, bucket);
      return {
        listObjects: (prefix) => client.listObjects(prefix),
        delete: (key) => client.delete(key),
      };
    },
  }),
  run: runCorpusPurgeLegacy,
};
