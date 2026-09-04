// `ops corpus seed-vector-ledger` — walk one tenant's corpus and write a
// `vector_ledger` row for every reading id it can derive.
//
// Why it exists (issue #195 slice S3). From this slice on, the account wipe
// terminates on "no ledger rows remain for this tenant" rather than "the R2
// prefix is empty", and it submits `deleteByIds` only for ids the ledger names.
// Every vector written from now on is ledgered before its upsert — but a corpus
// that already exists has vectors and no rows. Running the ledger-based wipe
// against such a corpus would find an empty ledger, submit nothing, empty R2,
// and report a clean wipe with the whole embedding corpus intact. Seeding is
// what closes that gap, and it must run before the first ledger-based wipe on
// any environment with existing data.
//
// Why it lives in the `corpus` group and not `account`. It reads corpus data
// and its unit of work is a reading — the same walk `corpus backfill-vectors`
// and the retired `collectReadingIds` performed, over the same three id sources
// under a `--tenant` key root. The `account` group is account-deletion
// housekeeping: the wipe pipeline's own bucket-root state and, later, residue
// scanning. A one-off migration of corpus rows is corpus work that the deletion
// pipeline happens to consume.
//
// WHY IT OVER-SEEDS ON PURPOSE. It ledgers every reading id derivable from the
// corpus, not only readings whose vector it has confirmed. The two errors are
// not symmetric:
//
//   - A row for a reading with no vector costs one `deleteByIds` call for an id
//     Vectorize does not hold — a no-op — and the row then clears on the first
//     confirmation pass.
//   - A missing row is a vector with no id source. Once the wipe empties R2
//     there is nothing left to derive one from, and it is unaddressable
//     forever. That is review finding F3, the whole reason the ledger exists.
//
// So the walk is deliberately the widest one available (`index/list.json` plus
// `index/by-id/` plus the `readings/` key layout), and it never confirms a
// vector before writing a row. Confirming would cost `ceil(n / 20)` Vectorize
// requests to make the answer narrower in the one direction that hurts.
//
// IDS ARE READ, NEVER GENERATED. `parseReadingId` enforces the Crockford
// alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ` — no I, L, O, U), and the walk
// runs every candidate through `readingIdFromRelativeKey`, which applies it.
// S6's staging drill lost a whole seeding pass to generating ids from a full
// base32 alphabet: `collectReadingIds` silently skipped them, the wipe emptied
// their objects, and their vectors were stranded — a perfect synthetic
// reproduction of the failure this ledger exists to prevent (report
// rl-195-s6-staging-gate, observation O1).

import { parseArgs } from "node:util";
import { readingIdFromRelativeKey } from "../../../src/account-wipe";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import { ListIndexSchema } from "../../../src/schemas/api";
import { parseReadingId } from "../../../src/services";
import type { VectorLedger } from "../../../src/control-plane/vector-ledger";
import { loadDotVars } from "../../lib/dotvars";
import { resolveBucket } from "../../corpus-lib/config";
import { requireOperatorTenant } from "../tenant-flag";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import { operatorVectorLedger } from "../../account-lib/operator-ledger";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

/** The corpus reads this command needs, as a seam tests can supply. */
export interface SeedLedgerStorage {
  /** Object keys under a prefix; absolute, including the tenant key root. */
  listObjectKeys(prefix: string): Promise<string[]>;
  /** An object's text, or null when absent. */
  get(key: string): Promise<string | null>;
}

export interface CorpusSeedVectorLedgerDeps extends BaseDeps {
  createStorage: (bucket: string) => Promise<SeedLedgerStorage>;
  makeLedger: (opts: { tenant: OperatorTenant; bucket: string; execute: boolean }) => VectorLedger;
  now: () => number;
}

interface Args {
  bucket: string;
  tenant?: string;
  execute: boolean;
  limit?: number;
}

/** Ledger writes go out in batches this size, to bound one D1 statement run. */
export const SEED_LEDGER_BATCH = 100;

function parseSeedArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        tenant: { type: "string" },
        execute: { type: "boolean", default: false },
        limit: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const args: Args = {
    bucket: resolveBucket(values.bucket),
    execute: values.execute === true,
  };
  if (values.tenant !== undefined) args.tenant = values.tenant;
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError("--limit must be a positive integer");
    }
    args.limit = limit;
  }
  return args;
}

/**
 * Every reading id derivable from one tenant's corpus, sorted.
 *
 * The three sources are the ones the retired `collectReadingIds` used, and they
 * are unioned rather than preferred: `index/list.json` can be stale or corrupt,
 * `index/by-id/` can be missing an entry a partial purge left behind, and the
 * `readings/` key layout carries the id in a path the other two never touch. A
 * corrupt list index is not a failure here — it just contributes nothing.
 */
export async function collectCorpusReadingIds(
  storage: SeedLedgerStorage,
  keyRoot: string,
): Promise<string[]> {
  const layout = r2KeyLayout(keyRoot);
  const ids = new Set<string>();
  const listRaw = await storage.get(layout.listIndexKey());
  if (listRaw !== null) {
    try {
      const parsed = ListIndexSchema.safeParse(JSON.parse(listRaw));
      if (parsed.success) {
        for (const item of parsed.data.items) {
          // Through parseReadingId, like every other id in this walk: a stored
          // list row is not a trusted id source.
          const id = parseReadingId(item.id);
          if (id) ids.add(id);
        }
      }
    } catch {
      // Corrupt list index contributes nothing; the two R2 walks still run.
    }
  }
  for (const prefix of [layout.byIdKey(""), layout.readingsPrefix()]) {
    for (const key of await storage.listObjectKeys(prefix)) {
      const id = readingIdFromRelativeKey(layout.relativeKey(key));
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

async function runCorpusSeedVectorLedger(
  argv: string[],
  deps: CorpusSeedVectorLedgerDeps,
): Promise<number> {
  const args = parseSeedArgs(argv);
  const { io } = deps;
  const tenant = requireOperatorTenant(args.tenant);
  if (tenant.kind !== "tenant") {
    // Not a usability nicety. `vector_ledger.tenant_id` references `users(id)`,
    // the pre-tenant corpus has no such id, and no account wipe addresses it —
    // it is outside every tenant key root and its vectors are un-namespaced.
    // Seeding it would write rows for a tenant that does not exist.
    throw new UsageError(
      "--tenant must be a usr_… tenant id: the pre-tenant global corpus has no tenant to key " +
        "ledger rows by, and no account wipe addresses it (see the legacy-data note in CLAUDE.md).",
    );
  }

  io.stdout(`Bucket: ${args.bucket}`);
  io.stdout(`Tenant: ${tenant.tenantId}`);
  io.stdout(`Key root: ${tenant.keyRoot}`);
  io.stdout(`Mode: ${args.execute ? "EXECUTE" : "PLAN"}`);

  // Resolved before the walk, in both modes. An unrecognised --bucket has no
  // known control plane, and this command must refuse that before it lists a
  // single object rather than after — the operator's next step on a successful
  // plan is `--execute`, and a plan that only fails at the end teaches them
  // nothing until they have already committed.
  const ledger = deps.makeLedger({ tenant, bucket: args.bucket, execute: args.execute });

  const storage = await deps.createStorage(args.bucket);
  const all = await collectCorpusReadingIds(storage, tenant.keyRoot);
  const ids = args.limit === undefined ? all : all.slice(0, args.limit);

  io.stdout(`\nReading ids derived from the corpus: ${all.length}`);
  if (args.limit !== undefined && all.length > ids.length) {
    io.stdout(`Limited to the first ${ids.length} by --limit.`);
  }
  for (const id of ids) io.stdout(`  ${id}`);

  if (ids.length === 0) {
    io.stdout(
      "\nNothing to seed. If this tenant is expected to have readings, check --bucket and --tenant\n" +
        "before concluding the corpus is empty: an empty walk here and a genuinely empty corpus look\n" +
        "identical, and seeding nothing is exactly the state that makes a wipe report a false clean.",
    );
    return 0;
  }

  if (!args.execute) {
    io.stdout(
      `\nPLAN — nothing was written. Re-run with --execute to write ${ids.length} vector_ledger row(s).\n` +
        "Re-running is safe: each row is an upsert keyed by (tenant_id, reading_id).",
    );
    return 0;
  }

  let written = 0;
  for (let offset = 0; offset < ids.length; offset += SEED_LEDGER_BATCH) {
    const batch = ids.slice(offset, offset + SEED_LEDGER_BATCH);
    await ledger.markLive(batch, deps.now());
    written += batch.length;
    io.stdout(`seeded ${written}/${ids.length}`);
  }
  io.stdout(
    `\nSeeded ${written} vector_ledger row(s) as 'live'.\n` +
      "Rows for readings that turn out to have no vector are harmless: the wipe submits one\n" +
      "deleteByIds for an id Vectorize does not hold, and the row clears on the first confirmation.",
  );
  return 0;
}

export const corpusSeedVectorLedgerCommand: CommandDefinition<CorpusSeedVectorLedgerDeps> = {
  group: "corpus",
  name: "seed-vector-ledger",
  summary: "Back-fill vector_ledger rows for an existing corpus before the first ledger-based wipe",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus seed-vector-ledger --tenant <usr_…> [options]

Walks one tenant's corpus and writes a D1 'vector_ledger' row, state 'live', for
every reading id it can derive — from index/list.json, from index/by-id/, and
from the readings/ key layout, unioned.

WHY YOU MUST RUN THIS. From issue #195 slice S3 on, the account wipe's
termination condition is "no vector_ledger rows remain for this tenant", and it
submits deleteByIds only for ids the ledger names. Every vector written after
that slice is ledgered before its upsert, but a corpus that already exists has
vectors and no rows. Wiping such a tenant would submit nothing, empty R2, and
report a clean wipe with the embeddings intact and unaddressable. Seed every
environment that has data BEFORE the first ledger-based wipe runs there.

It over-seeds on purpose: a row for a reading with no vector costs one no-op
deleteByIds and then clears, while a MISSING row is a vector nothing can ever
address once R2 is empty. Ids are read from the corpus and validated through
parseReadingId's Crockford alphabet (no I, L, O, U) — never generated.

Idempotent: rows are upserts keyed by (tenant_id, reading_id). Re-running after
a partial run finishes the job, and re-running after new readings have landed
adds them (they are also ledgered by the Worker at publish time).

--tenant global is refused: the pre-tenant corpus has no tenant id to key rows
by, and no account wipe addresses it.

The control-plane database is chosen from --bucket:
  reading-lite          -> reading-lite-control          (--env production)
  reading-lite-staging  -> reading-lite-control-staging  (--env staging)
An unrecognised bucket is refused rather than defaulted.

Options:
  --tenant <usr_…>  Required. The tenant whose corpus to walk.
  --bucket <name>   R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --limit <n>       Seed at most n ids (a rehearsal aid; a partial seed is NOT
                    enough to make a wipe safe).
  --execute         Write the rows. Without it, nothing is written.
  --help            Show this message.`,
  defaultDeps: (io: CommandIo): CorpusSeedVectorLedgerDeps => ({
    io,
    createStorage: async (bucket) => {
      const { r2InventoryClientFromVars } = await import("../../lib/cf-clients");
      const vars = { ...loadDotVars(".corpus.vars"), ...process.env };
      const client = r2InventoryClientFromVars(vars, bucket);
      return {
        listObjectKeys: async (prefix) =>
          (await client.listObjects(prefix)).map((object) => object.key),
        get: (key) => client.get(key),
      };
    },
    makeLedger: (opts) => operatorVectorLedger(opts),
    now: () => Date.now(),
  }),
  run: runCorpusSeedVectorLedger,
};
