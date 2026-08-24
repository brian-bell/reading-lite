// `ops corpus migrate-founder` — plan and execute the founder-corpus
// migration (reading-lite-s1k.6.1): copy the global R2 layout under
// `u/{tenantId}/…` and re-upsert every ready reading's vector into the tenant
// namespace as `{tenantId}:{readingId}` (ADR 0002), retaining all legacy
// state. Plan-first: the default mode prints the exact plan — every copy,
// every vector upsert, every retained legacy object, every problem — and,
// because plan status derives from live listings, re-planning after an
// execute IS the reconciliation check. --execute (with --sole-writer) copies
// and upserts resumably: progress checkpoints into a tenant-stamped state
// file whose per-object sha256 entries are the hash half of the
// reconciliation contract. Nothing is ever deleted; rollback before the gate
// flip is simply "do not set TENANT_DATA_PLANE" (ADR 0001, founder data
// cutover).

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { ListIndexSchema } from "../../../src/schemas/api";
import { LIST_INDEX_KEY } from "../../../src/modules/stores/layout";
import { resolveBucket } from "../../corpus-lib/config";
import {
  isFullyMigrated,
  planFounderMigration,
  type FounderMigrationPlan,
} from "../../corpus-lib/founder-migration";
import {
  loadMigrationState,
  newMigrationState,
  saveMigrationState,
  type MigrationState,
} from "../../corpus-lib/migration-state";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import type { ListItem } from "../../corpus-lib/types";
import type {
  R2InventoryClient,
  StoredVector,
  VectorizeAdminClient,
  VectorizeUpsertVector,
} from "../../lib/cf-clients";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

const GET_BY_IDS_CHUNK = 50;
const CHECKPOINT_EVERY = 25;
// Vectorize mutations are asynchronous: an upsert enqueues and only becomes
// visible to get_by_ids once the index processes it. Reconciliation therefore
// retries with a delay while the only deficiency is vectors this pass just
// wrote, instead of failing a successful migration for propagation lag.
const RECONCILE_RETRIES = 6;
const RECONCILE_DELAY_MS = 5_000;

export interface MigrateFounderClients {
  r2: Pick<R2InventoryClient, "listObjects" | "getBytes" | "get" | "put">;
  // The upsert side is constructed WITH the tenant namespace, so every vector
  // written through it lands namespaced; getByIds is namespace-agnostic.
  vectorize: Pick<VectorizeAdminClient, "getByIds" | "upsert">;
}

export interface CorpusMigrateFounderDeps extends BaseDeps {
  // Resolves credentials (throwing when absent) and returns the two clients.
  // Called in both modes — plan mode only ever reads through them (the run
  // wraps the write seams with throwing stubs before any traffic).
  makeClients: (opts: {
    bucket: string;
    vectorize: string;
    namespace: string;
  }) => Promise<MigrateFounderClients>;
  loadState: (path: string) => Promise<MigrationState | null>;
  saveState: (path: string, state: MigrationState) => Promise<void>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
}

interface Args {
  tenant?: string;
  bucket: string;
  vectorize: string;
  state: string;
  execute: boolean;
  soleWriter: boolean;
  limit: number;
}

function parseMigrateArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tenant: { type: "string" },
        bucket: { type: "string" },
        vectorize: { type: "string" },
        state: { type: "string" },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
        limit: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  let limit = Infinity;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError("--limit must be a positive integer");
    }
  }
  const bucket = resolveBucket(values.bucket);
  return {
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    bucket,
    vectorize: values.vectorize ?? bucket,
    state: values.state ?? "./founder-migration.state.json",
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
    limit,
  };
}

// Strict parse of the source list index against the WORKER's own contract
// (ListIndexSchema): the vector plan derives entirely from these rows, so a
// truncated or drifted document — including a row whose status is outside the
// manifest status enum, which the planner would silently treat as non-ready
// and never plan a vector for — must BLOCK the plan (invalid_list_index)
// rather than read as an empty or smaller corpus.
function parseListRows(
  body: string | null,
): { rows: ListItem[]; error?: string } {
  if (body === null) return { rows: [] };
  try {
    return { rows: ListIndexSchema.parse(JSON.parse(body)).items as ListItem[] };
  } catch (e) {
    return {
      rows: [],
      error: `${LIST_INDEX_KEY} did not parse as the version-1 list-index contract: ${
        e instanceof Error ? e.message.split("\n")[0] : String(e)
      }`,
    };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// One inventory pass: bucket listing, source list rows, and which vectors
// (legacy bare-id and tenant-prefixed) the index already holds for the ready
// rows. Read-only; runs identically for plan, execute preflight, and the
// post-execute reconciliation.
async function gatherPlan(
  clients: MigrateFounderClients,
  tenantId: string,
): Promise<{ plan: FounderMigrationPlan; rows: ListItem[] }> {
  const objects = await clients.r2.listObjects();
  const body = await clients.r2.get(LIST_INDEX_KEY);
  let { rows, error } = parseListRows(body);
  if (body === null && objects.some((o) => o.key === LIST_INDEX_KEY)) {
    error = `${LIST_INDEX_KEY} is listed but unreadable`;
  }
  const readyIds = rows.filter((r) => r.status === "ready").map((r) => r.id);
  const probeIds = readyIds.flatMap((id) => [id, `${tenantId}:${id}`]);
  const stored: StoredVector[] = [];
  for (const ids of chunk(probeIds, GET_BY_IDS_CHUNK)) {
    stored.push(...(await clients.vectorize.getByIds(ids)));
  }
  const plan = planFounderMigration({
    tenantId,
    objects,
    listRows: rows,
    ...(error === undefined ? {} : { listIndexError: error }),
    tenantVectors: new Map(
      stored.filter((v) => v.namespace === tenantId).map((v) => [v.id, v]),
    ),
    legacyVectors: new Map(
      stored.filter((v) => v.namespace === undefined).map((v) => [v.id, v]),
    ),
  });
  return { plan, rows };
}

function printSummary(io: CommandIo, plan: FounderMigrationPlan, mode: string): void {
  const c = plan.counts;
  io.stderr(
    `${mode}: ${c.source_objects} source objects (${c.copied} copied, ${c.pending_copies} pending), ` +
      `${c.ready_rows}/${c.list_rows} ready rows, ` +
      `${c.upserted_vectors} vectors migrated, ${c.pending_vectors} pending, ` +
      `${c.retained_legacy} legacy objects retained.`,
  );
  for (const problem of plan.problems) {
    io.stderr(`  ! ${problem.kind}: ${problem.detail}`);
  }
}

function printPrerequisites(io: CommandIo): void {
  io.stderr(
    "Cutover prerequisites (ADR 0001 founder data cutover; ADR 0002):\n" +
      "  1. Pause/drain the realtime writer; --execute requires --sole-writer.\n" +
      "  2. Copy and reconcile fully (this command, until it reports fully migrated)\n" +
      "     BEFORE setting TENANT_DATA_PLANE=1 anywhere.\n" +
      "  3. Deploy worker-side tenant vector-id support (tenantVectorId compose/strip\n" +
      "     in SimilarityStore) and x-expected-tenant enforcement before the gate flips.\n" +
      "Rollback (pre-flip): nothing to undo — this command never deletes or mutates\n" +
      "legacy state; simply leave TENANT_DATA_PLANE unset. Rollback (post-flip):\n" +
      "unset the gate and redeploy the prior worker; legacy objects and vectors are\n" +
      "retained through the observation window and deleted only after sign-off.",
  );
}

async function runCorpusMigrateFounder(
  argv: string[],
  deps: CorpusMigrateFounderDeps,
): Promise<number> {
  const args = parseMigrateArgs(argv);
  const tenant = requireOperatorTenant(args.tenant);
  if (tenant.kind !== "tenant") {
    throw new UsageError(
      "--tenant must be the destination usr_… tenant id; the source is always the pre-tenant global layout",
    );
  }
  const tenantId = tenant.tenantId;
  const { io } = deps;

  io.stderr(`Bucket: ${args.bucket}`);
  io.stderr(`Vectorize: ${args.vectorize} (namespace ${tenantId})`);
  io.stderr(`Mode: ${args.execute ? "EXECUTE" : "PLAN"}\n`);

  const clients = await deps.makeClients({
    bucket: args.bucket,
    vectorize: args.vectorize,
    namespace: tenantId,
  });
  if (!args.execute) {
    clients.r2 = {
      ...clients.r2,
      put: async () => {
        throw new Error("internal error: plan mode attempted an R2 write");
      },
    };
    clients.vectorize = {
      ...clients.vectorize,
      upsert: async () => {
        throw new Error("internal error: plan mode attempted a Vectorize write");
      },
    };
  }

  const { plan } = await gatherPlan(clients, tenantId);

  if (!args.execute) {
    io.stdout(JSON.stringify({ mode: "plan", bucket: args.bucket, vectorize: args.vectorize, ...plan }, null, 2));
    printSummary(io, plan, "PLAN");
    printPrerequisites(io);
    if (isFullyMigrated(plan)) {
      io.stderr("Fully migrated: reconciliation holds; safe to proceed with the gate-flip prerequisites.");
    } else if (plan.problems.length === 0) {
      io.stderr("Rerun with --execute --sole-writer to copy (writes the resumable state file).");
    } else {
      io.stderr("Resolve the problems above before executing.");
    }
    return plan.problems.length > 0 ? 1 : 0;
  }

  const verdict = soleWriterGuard({
    execute: true,
    acknowledged: args.soleWriter,
    tool: "corpus migrate-founder",
  });
  if (verdict.message) io.stderr(verdict.message);
  if (!verdict.proceed) return 2;

  // Execute enforces its own preflight: every problem except
  // destination_mismatch (which the copy loop itself repairs by overwriting
  // the destination with the source bytes) means the inventory or vector plan
  // cannot be trusted, and copying thousands of objects on a broken premise
  // helps nobody. Abort before any remote or state write.
  const fatal = plan.problems.filter((p) => p.kind !== "destination_mismatch");
  if (fatal.length > 0) {
    for (const p of fatal) io.stderr(`  ! ${p.kind}: ${p.detail}`);
    io.stderr("Preflight failed: resolve the problems above, then re-run. Nothing was written.");
    return 1;
  }

  let state = await deps.loadState(args.state);
  if (state) {
    if (state.tenant !== tenantId || state.bucket !== args.bucket || state.vectorize !== args.vectorize) {
      io.stderr(
        `state file ${args.state} belongs to tenant '${state.tenant}' bucket '${state.bucket}' ` +
          `vectorize '${state.vectorize}'; refusing to resume it as tenant '${tenantId}' ` +
          `bucket '${args.bucket}' vectorize '${args.vectorize}'.`,
      );
      return 1;
    }
    io.stderr(`Resuming from ${args.state} (${Object.keys(state.copies).length} copies recorded).`);
  } else {
    state = newMigrationState({
      tenant: tenantId,
      bucket: args.bucket,
      vectorize: args.vectorize,
      startedAt: deps.now(),
    });
  }

  let errors = 0;

  // Ledger backfill: a crash in the window between a successful remote write
  // and its next checkpoint leaves the object (or vector) live but absent
  // from the ledger — the plan marks it done, the resume filter skips it, and
  // the sha256/vector record would be missing forever. Rebuild those entries
  // from the destination objects before continuing, so a resumed run's ledger
  // is as complete as the corpus it certifies.
  let backfilled = 0;
  for (const copy of plan.copies) {
    if (copy.status !== "copied" || state.copies[copy.to] !== undefined) continue;
    const got = await clients.r2.getBytes(copy.to);
    if (got === null) {
      errors++;
      io.stderr(`  ! destination vanished during ledger backfill: ${copy.to}`);
      continue;
    }
    state.copies[copy.to] = {
      from: copy.from,
      sha256: createHash("sha256").update(got.body).digest("hex"),
      size: got.body.length,
      copied_at: deps.now(),
    };
    backfilled++;
  }
  for (const v of plan.vectors) {
    if (v.status !== "upserted" || state.vectors[v.reading_id] !== undefined) continue;
    state.vectors[v.reading_id] = {
      tenant_vector_id: v.tenant_vector_id,
      upserted_at: deps.now(),
    };
    backfilled++;
  }
  if (backfilled > 0) {
    io.stderr(`Backfilled ${backfilled} ledger entr${backfilled === 1 ? "y" : "ies"} for writes that predate their checkpoint.`);
    await deps.saveState(args.state, state);
  }

  let copiedNow = 0;
  let sinceCheckpoint = 0;
  const pendingCopies = plan.copies.filter((c) => c.status === "pending").slice(0, args.limit);
  for (const copy of pendingCopies) {
    const got = await clients.r2.getBytes(copy.from);
    if (got === null) {
      errors++;
      io.stderr(`  ! source vanished during copy: ${copy.from}`);
      continue;
    }
    await clients.r2.put(copy.to, got.body, {
      ...(got.contentType === null ? {} : { contentType: got.contentType }),
    });
    state.copies[copy.to] = {
      from: copy.from,
      sha256: createHash("sha256").update(got.body).digest("hex"),
      size: got.body.length,
      copied_at: deps.now(),
    };
    copiedNow++;
    if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
      await deps.saveState(args.state, state);
      sinceCheckpoint = 0;
    }
  }
  await deps.saveState(args.state, state);

  let upsertedNow = 0;
  const pendingVectors = plan.vectors.filter((v) => v.status === "pending").slice(0, args.limit);
  for (const group of chunk(pendingVectors, GET_BY_IDS_CHUNK)) {
    const fetched = new Map(
      (await clients.vectorize.getByIds(group.map((v) => v.legacy_id)))
        .filter((v) => v.namespace === undefined)
        .map((v) => [v.id, v]),
    );
    const upserts: VectorizeUpsertVector[] = [];
    const written: string[] = [];
    for (const v of group) {
      const legacy = fetched.get(v.legacy_id);
      if (!legacy) {
        errors++;
        io.stderr(`  ! legacy vector vanished during migration: ${v.legacy_id}`);
        continue;
      }
      upserts.push({
        id: v.tenant_vector_id,
        values: legacy.values,
        // Retain the legacy metadata and add the ADR 0002 audit stamp.
        metadata: {
          ...(legacy.metadata ?? {}),
          tenant_id: tenantId,
        } as VectorizeUpsertVector["metadata"],
      });
      written.push(v.reading_id);
    }
    await clients.vectorize.upsert(upserts);
    for (const readingId of written) {
      state.vectors[readingId] = {
        tenant_vector_id: `${tenantId}:${readingId}`,
        upserted_at: deps.now(),
      };
    }
    upsertedNow += written.length;
    await deps.saveState(args.state, state);
  }

  io.stderr(`Copied ${copiedNow} objects, migrated ${upsertedNow} vectors this pass.`);

  // Reconcile from live state, not from this run's bookkeeping: re-list and
  // re-probe, then re-derive the plan. Fully migrated means zero pending and
  // zero problems against the actual bucket and index contents. Freshly
  // upserted vectors may lag get_by_ids visibility (asynchronous mutations),
  // so when that is the only deficiency, wait and re-probe before concluding.
  let reconciled: FounderMigrationPlan;
  for (let attempt = 0; ; attempt++) {
    ({ plan: reconciled } = await gatherPlan(clients, tenantId));
    const onlyVectorLag =
      upsertedNow > 0 &&
      !isFullyMigrated(reconciled) &&
      reconciled.problems.length === 0 &&
      reconciled.counts.pending_copies === 0 &&
      reconciled.counts.pending_vectors > 0;
    if (!onlyVectorLag || attempt >= RECONCILE_RETRIES) break;
    io.stderr(
      `  ${reconciled.counts.pending_vectors} vector(s) not yet visible — Vectorize mutations ` +
        `are asynchronous; re-probing in ${RECONCILE_DELAY_MS / 1000}s`,
    );
    await deps.sleep(RECONCILE_DELAY_MS);
  }
  // reconciled_at certifies the ledger as well as the corpus: every copied
  // object must carry its sha256 entry and every migrated vector its record.
  // The backfill above makes this hold; the guard keeps a future gap from
  // silently certifying an incomplete ledger.
  const ledgerComplete =
    reconciled.copies.every((c) => c.status !== "copied" || state.copies[c.to] !== undefined) &&
    reconciled.vectors.every((v) => v.status !== "upserted" || state.vectors[v.reading_id] !== undefined);
  const certified = isFullyMigrated(reconciled) && ledgerComplete;
  if (certified) {
    state.reconciled_at = deps.now();
  } else {
    if (isFullyMigrated(reconciled)) {
      io.stderr("  ! corpus reconciles but the ledger is missing entries — rerun to backfill them.");
    }
    // The certificate must never outlive the state it certified: a resumed
    // pass that finds new work (e.g. the global writer ran since the last
    // reconciliation) revokes any earlier stamp until it re-earns it.
    delete state.reconciled_at;
  }
  await deps.saveState(args.state, state);

  io.stdout(
    JSON.stringify(
      { mode: "execute", bucket: args.bucket, vectorize: args.vectorize, ...reconciled, fully_migrated: isFullyMigrated(reconciled) },
      null,
      2,
    ),
  );
  printSummary(io, reconciled, "RECONCILE");
  if (certified && errors === 0) {
    io.stderr("Fully migrated and reconciled. Legacy state retained; see the cutover prerequisites before flipping the gate.");
    return 0;
  }
  io.stderr(
    upsertedNow > 0 && reconciled.problems.length === 0 && reconciled.counts.pending_copies === 0
      ? "Vectors may still be propagating (asynchronous mutations) — rerun plan mode later to confirm reconciliation."
      : args.limit === Infinity && errors === 0
        ? "Not yet fully migrated — rerun to continue (the state file resumes this run)."
        : "Pass incomplete — rerun to continue (the state file resumes this run).",
  );
  return 1;
}

function defaultDeps(io: CommandIo): CorpusMigrateFounderDeps {
  return {
    io,
    makeClients: async ({ bucket, vectorize, namespace }) => {
      // Lazy imports keep `ops --help` and unit tests from loading client
      // modules or resolving credentials.
      const { makeR2Client, makeVectorizeClient } = await import("../../lib/cf-clients");
      const { loadDotVars } = await import("../../lib/dotvars");
      const vars: Record<string, string | undefined> = {
        ...loadDotVars(".corpus.vars"),
        ...process.env,
      };
      const required = (names: string[]): string => {
        for (const name of names) {
          const value = vars[name];
          if (value) return value;
        }
        throw new Error(`missing credential: ${names.join(" or ")} (env or .corpus.vars)`);
      };
      return {
        r2: makeR2Client(
          {
            accountId: required(["CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]),
            accessKeyId: required(["CORPUS_R2_ACCESS_KEY"]),
            secretAccessKey: required(["CORPUS_R2_SECRET_KEY"]),
            bucket,
          },
          globalThis.fetch,
        ),
        vectorize: makeVectorizeClient(
          {
            accountId: required(["CORPUS_VECTORIZE_ACCOUNT_ID", "CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]),
            apiToken: required(["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]),
            index: vectorize,
            namespace,
          },
          globalThis.fetch,
        ),
      };
    },
    loadState: loadMigrationState,
    saveState: saveMigrationState,
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export const corpusMigrateFounderCommand: CommandDefinition<CorpusMigrateFounderDeps> = {
  group: "corpus",
  name: "migrate-founder",
  summary: "Plan and execute the founder corpus migration into its tenant namespace",
  safety: "plan-first",
  helpText: `Copies the entire pre-tenant global layout under u/{tenantId}/… and
re-upserts every ready reading's vector into the tenant namespace as
{tenantId}:{readingId} with tenant_id metadata (ADR 0002). Copy, not move:
legacy objects and vectors are always retained; this command never deletes.

Plan (default) prints the exact migration as JSON on stdout — every copy with
size and etag, every vector upsert, every retained legacy object, and every
problem — plus the cutover/rollback prerequisites. It writes nothing, locally
or remotely. Because copy/vector status derives from live listings, rerunning
plan after an execute is the reconciliation check: "fully migrated" means
every source object exists at its tenant key with equal size and etag and
every ready row's vector exists in the tenant namespace.

--execute (requires --sole-writer) copies pending objects (computing each
object's sha256 into the state file — the hash record for reconciliation) and
migrates pending vectors by reading legacy values and re-upserting, then
reconciles against fresh listings. Idempotent and resumable: rerunning skips
everything already in place; the tenant-stamped state file refuses resumes
under a different tenant/bucket/index.

Options:
  --tenant <usr_…>   REQUIRED: destination founder tenant id (the source is
                     always the global layout; 'global' is rejected).
  --bucket <name>    R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --vectorize <idx>  Vectorize index. Default: the bucket name.
  --state <path>     Resumable state file. Default: ./founder-migration.state.json.
  --limit <n>        Cap copies and vector upserts this pass (rehearsing
                     interrupted-run resume).
  --execute          Copy and upsert (plan is the default).
  --sole-writer      Required with --execute: assert the realtime writer is
                     paused/drained.
  --help             Show this message.

Credentials (env or .corpus.vars): CORPUS_R2_ACCOUNT_ID, CORPUS_R2_ACCESS_KEY,
CORPUS_R2_SECRET_KEY, and CORPUS_CF_API_TOKEN / CLOUDFLARE_API_TOKEN — needed
in plan mode too (plan reads live listings and vector state).

Run to full reconciliation BEFORE setting TENANT_DATA_PLANE=1 anywhere, and
see docs/operations.md for the full cutover ordering (worker vector-id support
and x-expected-tenant enforcement must be deployed before the flip).`,
  defaultDeps,
  run: runCorpusMigrateFounder,
};
