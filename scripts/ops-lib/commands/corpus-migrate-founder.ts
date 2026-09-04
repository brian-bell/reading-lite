// `ops corpus migrate-founder` — plan and execute the founder-corpus
// migration (reading-lite-s1k.6.1): copy the global R2 layout under
// `u/{tenantId}/…` and re-upsert every ready reading's vector into the tenant
// namespace as `{tenantId}:{readingId}` (ADR 0002), retaining all legacy
// state. Plan-first: the default mode prints the exact plan — every copy,
// every vector upsert, every retained legacy object, every problem — and,
// because plan status derives from live state (listings, per-row manifest and
// pointer content, vector contents), re-planning after an execute IS the
// reconciliation check. --execute (with --sole-writer) copies
// and upserts resumably: progress checkpoints into a tenant-stamped state
// file whose per-object sha256 entries are the hash half of the
// reconciliation contract. Nothing is ever deleted; rollback before the gate
// flip is simply "do not set TENANT_DATA_PLANE" (ADR 0001, founder data
// cutover).

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { ListIndexSchema, type ListIndexItem } from "../../../src/schemas/api";
import { ByUrlPointerSchema, ManifestSchema } from "../../../src/schemas/manifest";
import { manifestToIndexItem } from "../../../src/modules/stores/list-index";
import {
  BY_ID_PREFIX,
  BY_URL_PREFIX,
  LIST_INDEX_KEY,
  MANIFEST_FILE,
} from "../../../src/modules/stores/layout";
import { resolveBucket } from "../../corpus-lib/config";
import {
  executeBlockingProblems,
  isFullyMigrated,
  certificationProblems,
  planFounderMigration,
  type ByUrlSlotEvidence,
  type FounderMigrationInput,
  type FounderMigrationPlan,
  type RowEvidence,
} from "../../corpus-lib/founder-migration";
import {
  loadMigrationState,
  newMigrationState,
  saveMigrationState,
  type CachedByUrlPointer,
  type CachedRowEvidence,
  type MigrationState,
} from "../../corpus-lib/migration-state";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import type {
  R2InventoryClient,
  R2ObjectMeta,
  StoredVector,
  VectorizeAdminClient,
  VectorizeUpsertVector,
} from "../../lib/cf-clients";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import { operatorVectorLedger } from "../../account-lib/operator-ledger";
import type { VectorLedger } from "../../../src/control-plane/vector-ledger";

const GET_BY_IDS_CHUNK = 20; // Vectorize get_by_ids max; 50 trips 40007
const CHECKPOINT_EVERY = 25;
// Evidence gathering is two GETs per list row on every plan, preflight, and
// reconciliation pass, so it runs concurrently rather than serially.
const EVIDENCE_CONCURRENCY = 8;
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
  /**
   * The durable vector-id ledger (issue #195 S3). Every migrated reading id is
   * recorded before its vector is upserted, so this offline writer can no
   * longer leave a vector stranded in a tenant whose wipe is already past its
   * vectors phase. Resolved per run because the control plane it writes to is a
   * function of `--bucket`, and because plan mode gets the no-op.
   */
  makeLedger: (opts: { tenant: OperatorTenant; bucket: string; execute: boolean }) => VectorLedger;
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
): { rows: ListIndexItem[]; error?: string } {
  if (body === null) return { rows: [] };
  try {
    return { rows: ListIndexSchema.parse(JSON.parse(body)).items };
  } catch (e) {
    return {
      rows: [],
      error: `${LIST_INDEX_KEY} did not parse as the version-1 list-index contract: ${
        e instanceof Error ? e.message.split("\n")[0] : String(e)
      }`,
    };
  }
}

function firstLine(e: unknown): string {
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

export type RowEvidenceCache = Record<string, CachedRowEvidence>;

// The content half of the per-row expectations (RowEvidence): read and
// STRICTLY parse each row's manifest and by-id pointer against the worker's
// own contracts, so the plan can require them to agree with the row rather
// than merely exist. Only rows whose objects the listing has are read —
// absence is already row_missing_manifest / row_missing_by_id_pointer, and
// must not surface twice under a content kind.
//
// Reads are skipped for objects the listing shows at the etag a previous pass
// already parsed (`cache`), which is what makes repeat plan and reconciliation
// passes over an unmoved corpus nearly free. Only successful parses are
// cached: a malformed object is rare, blocks anyway, and is not worth a
// negative-cache entry. The returned cache is rebuilt from the CURRENT rows,
// so entries for rows the index no longer has drop out rather than accumulate.
async function gatherRowEvidence(
  r2: Pick<R2InventoryClient, "get">,
  rows: ListIndexItem[],
  present: ReadonlyMap<string, string>,
  cache: RowEvidenceCache,
): Promise<{
  evidence: Map<string, RowEvidence>;
  cache: RowEvidenceCache;
  reads: number;
  hits: number;
}> {
  const evidence = new Map<string, RowEvidence>();
  const nextCache: RowEvidenceCache = {};
  let reads = 0;
  let hits = 0;
  let next = 0;
  const readOne = async (key: string): Promise<unknown> => {
    reads++;
    const body = await r2.get(key);
    if (body === null) throw new Error("listed but unreadable");
    return JSON.parse(body);
  };
  const worker = async (): Promise<void> => {
    for (let i = next++; i < rows.length; i = next++) {
      const row = rows[i]!;
      const cached = cache[row.id];
      const ev: RowEvidence = {};
      const fresh: CachedRowEvidence = {};

      const manifestKey = `${row.key_prefix}/${MANIFEST_FILE}`;
      const manifestEtag = present.get(manifestKey);
      if (manifestEtag !== undefined) {
        if (cached?.manifest?.etag === manifestEtag) {
          hits++;
          const { etag: _etag, ...projection } = cached.manifest;
          ev.manifest = projection;
          fresh.manifest = cached.manifest;
        } else {
          try {
            const m = ManifestSchema.parse(await readOne(manifestKey));
            // The writer's own projection, in full — certification compares
            // every projected field against the row, not just id/url/status.
            const { key_prefix: _keyPrefix, ...projection }: ListIndexItem =
              manifestToIndexItem(m, row.key_prefix);
            ev.manifest = projection;
            fresh.manifest = { etag: manifestEtag, ...projection };
          } catch (e) {
            ev.manifest_error = firstLine(e);
          }
        }
      }

      const pointerKey = `${BY_ID_PREFIX}${row.id}`;
      const pointerEtag = present.get(pointerKey);
      if (pointerEtag !== undefined) {
        if (cached?.pointer?.etag === pointerEtag) {
          hits++;
          const { id, key_prefix } = cached.pointer;
          ev.pointer = { id, key_prefix };
          fresh.pointer = cached.pointer;
        } else {
          try {
            ev.pointer = ByUrlPointerSchema.parse(await readOne(pointerKey));
            fresh.pointer = { etag: pointerEtag, ...ev.pointer };
          } catch (e) {
            ev.pointer_error = firstLine(e);
          }
        }
      }

      evidence.set(row.id, ev);
      if (fresh.manifest !== undefined || fresh.pointer !== undefined) {
        nextCache[row.id] = fresh;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(EVIDENCE_CONCURRENCY, rows.length) }, worker),
  );
  return { evidence, cache: nextCache, reads, hits };
}

export type ByUrlPointerCache = Record<string, CachedByUrlPointer>;

// The content half of the per-slot by-url expectations: strictly parse every
// by-url slot the listing has, so certification can require each slot to
// target a row that owns its URL rather than merely exist (a malformed slot
// throws in resolveOwner before any repair runs — no self-heal). Same
// etag-addressed cache discipline as gatherRowEvidence: one read per slot on
// the first pass, nearly free afterwards.
async function gatherByUrlEvidence(
  r2: Pick<R2InventoryClient, "get">,
  present: ReadonlyMap<string, string>,
  cache: ByUrlPointerCache,
): Promise<{
  evidence: Map<string, ByUrlSlotEvidence>;
  cache: ByUrlPointerCache;
  reads: number;
  hits: number;
}> {
  const slots = [...present.keys()].filter((key) => key.startsWith(BY_URL_PREFIX)).sort();
  const evidence = new Map<string, ByUrlSlotEvidence>();
  const nextCache: ByUrlPointerCache = {};
  let reads = 0;
  let hits = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < slots.length; i = next++) {
      const key = slots[i]!;
      const hash = key.slice(BY_URL_PREFIX.length);
      const etag = present.get(key)!;
      const cached = cache[hash];
      if (cached?.etag === etag) {
        hits++;
        const { id, key_prefix } = cached;
        evidence.set(hash, { pointer: { id, key_prefix } });
        nextCache[hash] = cached;
        continue;
      }
      try {
        reads++;
        const body = await r2.get(key);
        if (body === null) throw new Error("listed but unreadable");
        const pointer = ByUrlPointerSchema.parse(JSON.parse(body));
        evidence.set(hash, { pointer });
        nextCache[hash] = { etag, ...pointer };
      } catch (e) {
        evidence.set(hash, { pointer_error: firstLine(e) });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(EVIDENCE_CONCURRENCY, slots.length) }, worker),
  );
  return { evidence, cache: nextCache, reads, hits };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Everything the plan needs from R2: the bucket listing, the source list
// rows, and each row's manifest/pointer content. Read-only.
//
// Held separately from the vector probe because the two move on different
// clocks. R2 is authoritative the moment a copy returns, while Vectorize
// mutations are asynchronous — so reconciliation re-probes vectors several
// times while the bucket sits still underneath it (nothing writes to the
// SOURCE layout during a migration: copies only ever write under the tenant
// root, and --execute requires the realtime writer paused). Re-deriving this
// half per retry would re-list and re-read the whole corpus to learn nothing.
interface R2Inventory {
  objects: R2ObjectMeta[];
  rows: ListIndexItem[];
  listIndexError?: string;
  rowEvidence: Map<string, RowEvidence>;
  evidenceCache: RowEvidenceCache;
  byUrlEvidence: Map<string, ByUrlSlotEvidence>;
  byUrlCache: ByUrlPointerCache;
  evidenceReads: number;
  evidenceHits: number;
}

// Both halves of the state file's etag-addressed evidence cache.
export interface EvidenceCaches {
  rows: RowEvidenceCache;
  byUrl: ByUrlPointerCache;
}

async function gatherR2Inventory(
  clients: MigrateFounderClients,
  caches: EvidenceCaches,
): Promise<R2Inventory> {
  const objects = await clients.r2.listObjects();
  const body = await clients.r2.get(LIST_INDEX_KEY);
  let { rows, error } = parseListRows(body);
  if (body === null && objects.some((o) => o.key === LIST_INDEX_KEY)) {
    error = `${LIST_INDEX_KEY} is listed but unreadable`;
  }
  const source = new Map(
    objects.filter((o) => !o.key.startsWith("u/")).map((o) => [o.key, o.etag]),
  );
  const gathered = await gatherRowEvidence(clients.r2, rows, source, caches.rows);
  const byUrl = await gatherByUrlEvidence(clients.r2, source, caches.byUrl);
  return {
    objects,
    rows,
    ...(error === undefined ? {} : { listIndexError: error }),
    rowEvidence: gathered.evidence,
    evidenceCache: gathered.cache,
    byUrlEvidence: byUrl.evidence,
    byUrlCache: byUrl.cache,
    evidenceReads: gathered.reads + byUrl.reads,
    evidenceHits: gathered.hits + byUrl.hits,
  };
}

// Which vectors (legacy bare-id and tenant-prefixed) the index holds for the
// ready rows. The half that reconciliation retries.
async function probeVectors(
  clients: MigrateFounderClients,
  tenantId: string,
  rows: ListIndexItem[],
): Promise<Pick<FounderMigrationInput, "tenantVectors" | "legacyVectors">> {
  const readyIds = rows.filter((r) => r.status === "ready").map((r) => r.id);
  const probeIds = readyIds.flatMap((id) => [id, `${tenantId}:${id}`]);
  const stored: StoredVector[] = [];
  for (const ids of chunk(probeIds, GET_BY_IDS_CHUNK)) {
    stored.push(...(await clients.vectorize.getByIds(ids)));
  }
  return {
    tenantVectors: new Map(
      stored.filter((v) => v.namespace === tenantId).map((v) => [v.id, v]),
    ),
    legacyVectors: new Map(
      stored.filter((v) => v.namespace === undefined).map((v) => [v.id, v]),
    ),
  };
}

// One full pass: R2 inventory plus a vector probe.
async function gatherPlan(
  clients: MigrateFounderClients,
  tenantId: string,
  caches: EvidenceCaches,
): Promise<{ plan: FounderMigrationPlan; inventory: R2Inventory }> {
  const inventory = await gatherR2Inventory(clients, caches);
  const plan = planFromInventory(
    tenantId,
    inventory,
    await probeVectors(clients, tenantId, inventory.rows),
  );
  return { plan, inventory };
}

function planFromInventory(
  tenantId: string,
  inventory: R2Inventory,
  vectors: Pick<FounderMigrationInput, "tenantVectors" | "legacyVectors">,
): FounderMigrationPlan {
  return planFounderMigration({
    tenantId,
    objects: inventory.objects,
    listRows: inventory.rows,
    rowEvidence: inventory.rowEvidence,
    byUrlEvidence: inventory.byUrlEvidence,
    ...(inventory.listIndexError === undefined
      ? {}
      : { listIndexError: inventory.listIndexError }),
    ...vectors,
  });
}

// A read-only peek at the state file, purely for the evidence cache. Never
// throws and never refuses: a missing, unreadable, or foreign state file just
// means no cache and every row is read fresh. The execute path loads the same
// file again for the actual resume, where those cases ARE hard failures —
// keeping the two apart is what lets plan mode stay a command that reads.
async function peekEvidenceCache(
  deps: CorpusMigrateFounderDeps,
  args: Args,
  tenantId: string,
): Promise<EvidenceCaches> {
  const empty: EvidenceCaches = { rows: {}, byUrl: {} };
  let state: MigrationState | null;
  try {
    state = await deps.loadState(args.state);
  } catch {
    return empty;
  }
  if (!state) return empty;
  const sameTarget =
    state.tenant === tenantId &&
    state.bucket === args.bucket &&
    state.vectorize === args.vectorize;
  return sameTarget
    ? { rows: state.evidence ?? {}, byUrl: state.by_url ?? {} }
    : empty;
}

// Certification reads two objects per row, so say what that cost — and what
// the state file's cache saved. A run reporting many reads on an unchanged
// corpus means the cache is not being reused (no state file, a different
// --state path, or a foreign one).
function printEvidenceCost(io: CommandIo, inventory: R2Inventory): void {
  if (inventory.rows.length === 0) return;
  io.stderr(
    `Verified ${inventory.rows.length} row(s) against their manifest, by-id pointer, and by-url slot ` +
      `(${inventory.evidenceReads} object read${inventory.evidenceReads === 1 ? "" : "s"}, ` +
      `${inventory.evidenceHits} served from the state file's etag cache).`,
  );
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
  // Resolved up front so an unrecognised --bucket (no known control plane)
  // stops the run before it copies or upserts anything. Plan mode gets the
  // no-op: plan mode writes nothing to Vectorize either.
  const ledger = deps.makeLedger({ tenant, bucket: args.bucket, execute: args.execute });

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

  const { plan, inventory } = await gatherPlan(
    clients,
    tenantId,
    await peekEvidenceCache(deps, args, tenantId),
  );
  printEvidenceCost(io, inventory);

  if (!args.execute) {
    io.stdout(JSON.stringify({ mode: "plan", bucket: args.bucket, vectorize: args.vectorize, ...plan }, null, 2));
    printSummary(io, plan, "PLAN");
    printPrerequisites(io);
    if (isFullyMigrated(plan)) {
      io.stderr("Fully migrated: reconciliation holds; safe to proceed with the gate-flip prerequisites.");
      return 0;
    }
    const blocking = executeBlockingProblems(plan);
    if (blocking.length > 0) {
      io.stderr("Resolve the problems above before executing.");
      return 1;
    }
    const remaining = certificationProblems(plan);
    if (remaining.length > 0) {
      // Execute-handled problems: mismatched destinations are overwritten
      // with the source bytes, and unrecognized keys are still copied (zero
      // lost objects) — though stray keys block certification until
      // dispositioned. Informational problems (other tenants in the bucket)
      // were printed above and do not change this advice.
      io.stderr(
        "The problems above are handled by --execute: destination mismatches are re-copied, " +
          "and unrecognized keys are still copied. Rerun with --execute --sole-writer.",
      );
      return remaining.some((p) => p.kind === "unrecognized_key") ? 1 : 0;
    }
    io.stderr("Rerun with --execute --sole-writer to copy (writes the resumable state file).");
    return 0;
  }

  const verdict = soleWriterGuard({
    execute: true,
    acknowledged: args.soleWriter,
    tool: "corpus migrate-founder",
  });
  if (verdict.message) io.stderr(verdict.message);
  if (!verdict.proceed) return 2;

  // Execute enforces its own preflight: an execute-blocking problem means the
  // inventory or vector plan cannot be trusted, and copying thousands of
  // objects on a broken premise helps nobody. Abort before any remote or
  // state write. (Mismatched destinations and unrecognized keys are HANDLED
  // by executing — see executeBlockingProblems.)
  const fatal = executeBlockingProblems(plan);
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
  // Carry this pass's verification forward even if the run is interrupted
  // before reconciliation: the next one re-reads only what actually moved.
  state.evidence = inventory.evidenceCache;
  state.by_url = inventory.byUrlCache;

  let errors = 0;

  // Ledger backfill, for entries that are missing OR stale. Missing: a crash
  // in the window between a successful remote write and its next checkpoint
  // leaves the object (or vector) live but absent from the ledger — the plan
  // marks it done, the resume filter skips it, and the sha256/vector record
  // would be missing forever. Stale: an entry whose recorded etag is not the
  // etag the destination lists NOW describes older bytes (source and
  // destination rewritten outside this command between runs, or an entry
  // predating the etag field) — certifying it would advertise a hash ledger
  // of bytes that no longer exist. Rebuild both classes from the destination
  // objects before continuing, so a resumed run's ledger is as complete and
  // current as the corpus it certifies. (`copy.etag` is the source etag; a
  // "copied" status already proves the destination lists the same etag.)
  let backfilled = 0;
  for (const copy of plan.copies) {
    if (copy.status !== "copied" || state.copies[copy.to]?.etag === copy.etag) continue;
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
      etag: copy.etag,
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
    io.stderr(`Backfilled ${backfilled} ledger entr${backfilled === 1 ? "y" : "ies"} missing or stale in the checkpoint.`);
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
      etag: copy.etag,
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
    // Ledger BEFORE the upsert, on the BARE reading ids (issue #195 S3). This
    // command has never checked `users.status` and does not start now: it is an
    // offline migration and the tenant it writes for may be mid-wipe. Recording
    // the id first is what keeps a vector it upserts after the wipe's vectors
    // phase addressable instead of stranded.
    await ledger.markLive(written, Date.parse(deps.now()) || Date.now());
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
  //
  // The R2 half is gathered ONCE for the whole loop. Only Vectorize is
  // eventually consistent here — the bucket is quiescent (source objects are
  // never written, destinations were written synchronously above, and the
  // realtime writer is paused), so re-listing and re-reading the corpus per
  // retry would burn the whole inventory to re-learn an unchanged answer.
  const reconInventory = await gatherR2Inventory(clients, {
    rows: inventory.evidenceCache,
    byUrl: inventory.byUrlCache,
  });
  printEvidenceCost(io, reconInventory);
  state.evidence = reconInventory.evidenceCache;
  state.by_url = reconInventory.byUrlCache;
  let reconciled: FounderMigrationPlan;
  for (let attempt = 0; ; attempt++) {
    reconciled = planFromInventory(
      tenantId,
      reconInventory,
      await probeVectors(clients, tenantId, reconInventory.rows),
    );
    const onlyVectorLag =
      upsertedNow > 0 &&
      !isFullyMigrated(reconciled) &&
      certificationProblems(reconciled).length === 0 &&
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
  // object must carry a sha256 entry recorded AT the etag the destination
  // lists now — presence alone would let an entry from an earlier run certify
  // a hash of older bytes — and every migrated vector its record. The
  // backfill above makes this hold; the guard keeps a future gap from
  // silently certifying an incomplete or stale ledger. (`c.etag` is the
  // source etag, which a "copied" status proves the destination shares.)
  const ledgerComplete =
    reconciled.copies.every((c) => c.status !== "copied" || state.copies[c.to]?.etag === c.etag) &&
    reconciled.vectors.every((v) => v.status !== "upserted" || state.vectors[v.reading_id] !== undefined);
  const certified = isFullyMigrated(reconciled) && ledgerComplete;
  if (certified) {
    state.reconciled_at = deps.now();
  } else {
    if (isFullyMigrated(reconciled)) {
      io.stderr("  ! corpus reconciles but the ledger has missing or stale entries — rerun to backfill them.");
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
    reconciled.counts.pending_copies > 0 || reconciled.counts.pending_vectors > 0
      ? upsertedNow > 0 && reconciled.counts.pending_copies === 0
        ? "Vectors may still be propagating (asynchronous mutations) — rerun plan mode later to confirm reconciliation."
        : args.limit === Infinity && errors === 0
          ? "Not yet fully migrated — rerun to continue (the state file resumes this run)."
          : "Pass incomplete — rerun to continue (the state file resumes this run)."
      : certificationProblems(reconciled).length > 0
        ? "Certification blocked by the problems above — resolve them, then re-plan to certify."
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
      const { makeVectorizeClient, r2InventoryClientFromVars } = await import("../../lib/cf-clients");
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
        r2: r2InventoryClientFromVars(vars, bucket, globalThis.fetch),
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
    makeLedger: (opts) => operatorVectorLedger(opts),
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
or remotely (it reads the --state file for its evidence cache, never writes it). Because copy/vector status derives from live listings, rerunning
plan after an execute is the reconciliation check: "fully migrated" means
every source object exists at its tenant key with equal size and etag, every
ready row's tenant-namespace vector carries the legacy embedding and metadata
plus its tenant_id stamp, and every row agrees with the manifest and by-id
pointer it names (a stale list row would silently skip that reading's vector,
so it blocks — repair with corpus rebuild-list --tenant global).

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
  --state <path>     Resumable state file, and the etag cache for the per-row
                     manifest/pointer checks. Pass the same path to plan and
                     execute so repeat passes re-read only what moved; plan
                     reads it and never writes it.
                     Default: ./founder-migration.state.json.
  --limit <n>        Cap copies and vector upserts this pass (rehearsing
                     interrupted-run resume).
  --execute          Copy and upsert (plan is the default).
  --sole-writer      Required with --execute: assert the realtime writer is
                     paused/drained.
  --help             Show this message.

Credentials (env or .corpus.vars): CORPUS_R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID,
plus either CORPUS_R2_ACCESS_KEY+CORPUS_R2_SECRET_KEY (S3) or
CLOUDFLARE_API_TOKEN / CORPUS_CF_API_TOKEN (R2 REST — what cloud-agent
environments have). Vectorize uses the same API token. Needed in plan mode
too (plan reads live listings and vector state).

Run to full reconciliation BEFORE setting TENANT_DATA_PLANE=1 anywhere, and
see docs/founder-cutover.md for the production cutover (worker vector-id
support and x-expected-tenant enforcement must already be deployed).`,
  defaultDeps,
  run: runCorpusMigrateFounder,
};
