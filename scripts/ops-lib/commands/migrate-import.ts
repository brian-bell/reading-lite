// `ops migrate import` — load a snapshot from `ops migrate export` into an
// empty PostgreSQL database (reading-lite-gh348).
//
// Plan-first. A mode-less run verifies the snapshot's digests, plans every
// row, and inspects the target read-only (migrations, pgvector, emptiness);
// it writes nothing. --execute loads everything in one transaction and
// verifies it by reading it back before COMMIT (import-library.ts).
//
// The target is NAMED, never given: --target-env is the name of an
// environment variable holding a direct connection string (for example
// NEON_REHEARSAL_DATABASE_URL from ~/.config/reading-lite/neon.env), so no
// connection string reaches the command line or the process list. There is
// no default. A name the operator seam pairs with a deployed environment must
// match the snapshot's source: a staging snapshot cannot load into
// production's database, or the reverse.

import { parseArgs } from "node:util";
import { OPERATOR_DATABASES, openOperatorSql, withOperatorSql, type OpenOperatorSql } from "../../pg-lib/operator-db";
import {
  describeAcceptance,
  executeImport,
  ImportPlanError,
  ImportVerificationError,
  inspectTarget,
  planImport,
  targetRefusals,
  type ImportReport,
} from "../../migrate-lib/import-library";
import { ACCEPTABLE_CODES, countByCode, type BlockingCode } from "../../migrate-lib/library-checks";
import { canonicalJson, readSnapshot, SnapshotError, type Snapshot } from "../../migrate-lib/snapshot";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";

export interface MigrateImportDeps extends BaseDeps {
  env: Record<string, string | undefined>;
  readSnapshot: (dir: string) => Snapshot;
  openSql: OpenOperatorSql;
}

interface Opts {
  snapshot: string;
  targetEnv: string;
  accept: Set<BlockingCode>;
  json: boolean;
  execute: boolean;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function parseOpts(argv: string[]): Opts {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        snapshot: { type: "string" },
        "target-env": { type: "string" },
        accept: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values;
  if (v.snapshot === undefined) throw new UsageError("--snapshot <dir> is required");
  const targetEnv = v["target-env"];
  if (targetEnv === undefined) throw new UsageError("--target-env <NAME> is required; there is no default target");
  if (targetEnv.includes("://") || targetEnv.includes("@")) {
    throw new UsageError("--target-env takes the NAME of an environment variable, never a connection string");
  }
  if (!ENV_NAME.test(targetEnv)) throw new UsageError(`--target-env ${JSON.stringify(targetEnv)} is not an environment variable name`);
  const accept = new Set<BlockingCode>();
  for (const code of v.accept ?? []) {
    if (!(ACCEPTABLE_CODES as string[]).includes(code)) {
      throw new UsageError(`--accept ${code}: not an acceptable finding. Acceptable: ${ACCEPTABLE_CODES.join(", ")}`);
    }
    accept.add(code as BlockingCode);
  }
  return { snapshot: v.snapshot, targetEnv, accept, json: v.json ?? false, execute: v.execute ?? false };
}

function resolveTarget(opts: Opts, snapshot: Snapshot, env: Record<string, string | undefined>): string {
  const paired = Object.values(OPERATOR_DATABASES).find((target) => target.databaseUrlEnvs.includes(opts.targetEnv));
  if (paired && paired.env !== snapshot.meta.source.env) {
    throw new UsageError(
      `--target-env ${opts.targetEnv} names the ${paired.env} database, but the snapshot is from ${snapshot.meta.source.env}`,
    );
  }
  const url = env[opts.targetEnv]?.trim();
  if (!url) throw new UsageError(`${opts.targetEnv} is not set; it must hold a direct PostgreSQL connection string`);
  if (!/^postgres(ql)?:\/\//.test(url)) throw new UsageError(`${opts.targetEnv} does not hold a postgres:// connection string`);
  return url;
}

function printVerification(io: BaseDeps["io"], say: (line: string) => void, report: ImportReport): void {
  const v = report.verification;
  say(`Rows: ${Object.entries(report.rows).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  say(
    `Verified: ${v.readings_checked} reading(s) read back, ${v.manifest_mismatches.length} mismatched; ` +
      `field totals ${v.field_totals_match ? "match" : "DIFFER"}; ${v.embeddings_checked} embedding(s), ` +
      `${v.embedding_mismatches.length} mismatched; control plane ${v.control_plane_mismatches.length === 0 ? "matches" : "DIFFERS"}.`,
  );
  for (const m of v.manifest_mismatches) io.stderr(`  ✗ ${m.id}: ${m.fields.join(", ")}`);
  for (const id of v.embedding_mismatches) io.stderr(`  ✗ embedding ${id}`);
  for (const m of v.control_plane_mismatches) io.stderr(`  ✗ ${m.table}: ${m.detail}`);
}

async function runMigrateImport(argv: string[], deps: MigrateImportDeps): Promise<number> {
  const opts = parseOpts(argv);
  const { io } = deps;
  // With --json, stdout carries the report alone so it can be redirected to a
  // file and parsed; the human lines move to stderr.
  const say = opts.json ? io.stderr : io.stdout;
  let snapshot: Snapshot;
  try {
    snapshot = deps.readSnapshot(opts.snapshot);
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error;
    io.stderr(`✗ ${error.message}`);
    return 1;
  }
  const url = resolveTarget(opts, snapshot, deps.env);

  let plan;
  try {
    plan = planImport(snapshot, opts.accept);
  } catch (error) {
    if (!(error instanceof ImportPlanError)) throw error;
    io.stderr(`✗ ${error.message}`);
    return 1;
  }

  const meta = snapshot.meta;
  say(`Snapshot: ${opts.snapshot} (${meta.source.env}, exported ${meta.exported_at})`);
  say(`Tenant: ${meta.tenant_id}`);
  say(`Target: ${opts.targetEnv}`);
  say(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);
  const tables = Object.entries(plan.controlPlane).filter(([, rows]) => rows.length > 0);
  say(`Readings: ${plan.readings.length} to import, ${plan.skipped.length} skipped`);
  say(`Control plane: ${tables.map(([t, rows]) => `${t} ${rows.length}`).join(", ") || "no rows"}`);
  for (const s of plan.skipped) say(`  · skipping ${s.id} (${s.code})  ${s.key_prefix}`);
  const findings = Object.entries(countByCode(plan.findings));
  if (findings.length > 0) say(`Findings: ${findings.map(([code, n]) => `${code} ${n}`).join(", ")}`);
  if (plan.blocking.length > 0) {
    say("\nBlocking findings:");
    for (const d of plan.blocking) {
      const accepted = opts.accept.has(d.code as BlockingCode);
      say(`  ${accepted ? "✓ accepted" : "✗"} ${d.code}${d.id ? `  ${d.id}` : ""}${d.detail ? `  — ${d.detail}` : ""}`);
    }
    for (const code of new Set(plan.unaccepted.map((d) => d.code as BlockingCode))) {
      say(`    ${code}: ${describeAcceptance(code)}${(ACCEPTABLE_CODES as string[]).includes(code) ? ` (--accept ${code})` : ""}`);
    }
  }

  return withOperatorSql(
    url,
    async (sql) => {
      const state = await inspectTarget(sql);
      const refusals = targetRefusals(state);
      say(`\nTarget: pgvector ${state.vectorExtension ?? "absent"}, migrations ${state.pendingMigrations.length === 0 && !state.drift ? "current" : "NOT current"}`);
      for (const refusal of refusals) io.stderr(`✗ REFUSED: ${refusal}`);
      if (plan.unaccepted.length > 0) io.stderr(`✗ REFUSED: ${plan.unaccepted.length} blocking finding(s) not accepted`);
      if (refusals.length > 0 || plan.unaccepted.length > 0) return 1;

      if (!opts.execute) {
        say("\nPlan only: nothing written. Re-run with --execute to import.");
        return 0;
      }
      try {
        const report = await executeImport(sql, snapshot, plan);
        printVerification(io, say, report);
        say("\nImported and verified; committed.");
        if (opts.json) io.stdout(canonicalJson(report));
        return 0;
      } catch (error) {
        if (!(error instanceof ImportVerificationError)) throw error;
        printVerification(io, say, error.report);
        io.stderr(`✗ ${error.message}`);
        if (opts.json) io.stdout(canonicalJson(error.report));
        return 1;
      }
    },
    deps.openSql,
  );
}

export const migrateImportCommand: CommandDefinition<MigrateImportDeps> = {
  group: "migrate",
  name: "import",
  summary: "Load an export snapshot into an empty PostgreSQL database and verify it",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- migrate import --snapshot <dir> --target-env <NAME>
                                  [--accept <code>]... [--json] [--execute]

Loads a snapshot written by \`ops migrate export\` into an EMPTY database: the
db/migrations schema applied and the vector extension installed, with no row
in any application table. Anything else is refused; this is a one-shot load,
not a resumable migration.

Plan mode checks the snapshot's digests, plans every row, inspects the target
read-only, and lists the blocking findings. --execute loads the control plane
and the library in one transaction, reads every reading, embedding and
control-plane row back, and commits only if all of it matches the snapshot;
otherwise it rolls back and exits 1.

Blocking findings refuse --execute until accepted one code at a time:
${ACCEPTABLE_CODES.map((code) => `  ${code.padEnd(20)} ${describeAcceptance(code)}`).join("\n")}
duplicate_reading_id, tenant_account_missing, unfinished_wipe and
invalid_control_plane_row cannot be accepted: fix the source and export again.

Options:
  --snapshot <dir>     A snapshot directory from \`ops migrate export\`. Required.
  --target-env <NAME>  Environment variable holding the target's DIRECT
                       connection string (never Hyperdrive, never the string
                       itself). Required; there is no default. A deployed
                       environment's variable must match the snapshot's source.
  --accept <code>      Accept one blocking finding code (repeatable).
  --json               Also print the machine-readable import report.
  --execute            Import and verify.`,
  defaultDeps: (io) => ({ io, env: process.env, readSnapshot, openSql: openOperatorSql }),
  run: runMigrateImport,
};
