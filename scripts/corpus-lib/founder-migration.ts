// Founder-corpus migration planning (reading-lite-s1k.6.1). Pure functions:
// given one bucket listing, the source list index, what each row's manifest
// and by-id pointer actually contain (RowEvidence), and which tenant vectors
// already exist, derive the EXACT migration plan — every R2 copy, every
// vector upsert, every retained legacy object, and every problem that must be
// resolved before cutover. No I/O; the command wires clients around this.
//
// The migration itself is a re-rooting, not a transformation (layout.ts):
// stored key_prefix values, pointers, and list rows are root-relative, so
// every global-layout object copies byte-identically to `u/{tenantId}/{key}`.
// The plan therefore covers the WHOLE global layout — a key the vocabulary
// does not recognize is still planned for copy (zero lost objects, per the
// s1k.6 acceptance criteria) but reported as a problem to investigate.
//
// Vectors do not copy across namespaces: a legacy vector's values are read by
// id and re-upserted as `{tenantId}:{readingId}` (tenantVectorId, ADR 0002)
// in the tenant namespace with a `tenant_id` metadata stamp. Legacy bare-id
// vectors are retained; ADR 0001's cutover deletes legacy state only after
// rehearsal, reconciliation, observation, and sign-off.
//
// Because plan status derives from live state (dest presence with equal
// size+etag; tenant-vector values, metadata and stamp; each row's manifest and
// pointer content), re-planning after an execute IS the reconciliation: a
// fully migrated corpus plans zero pending work and zero problems
// (isFullyMigrated).

import {
  ATTEMPTS_PREFIX,
  BY_ID_PREFIX,
  BY_URL_PREFIX,
  EXTRACTED_FILE,
  LIST_INDEX_KEY,
  MANIFEST_FILE,
  RAW_PREFIX,
  READINGS_PREFIX,
} from "../../src/modules/stores/layout";
import { tenantVectorId } from "../../src/modules/stores/similarity-store";
import type { ListIndexItem } from "../../src/schemas/api";
import type { R2ObjectMeta, StoredVector } from "../lib/cf-clients";
import { urlHash } from "./url-hash";

// Any tenant data-plane root, not just this migration's destination: source
// classification must never mistake another tenant's objects for global ones.
const TENANT_ROOT_PREFIX = "u/";

export type CopyCategory =
  | "manifest"
  | "extracted"
  | "raw"
  | "attempt"
  | "by_id"
  | "by_url"
  | "list_index"
  | "unrecognized";

export interface PlannedCopy {
  from: string;
  to: string;
  category: CopyCategory;
  size: number;
  etag: string;
  // "copied": the destination object exists with equal size and etag.
  status: "pending" | "copied";
}

export interface PlannedVector {
  reading_id: string;
  legacy_id: string;
  tenant_vector_id: string;
  status: "pending" | "upserted";
}

export interface MigrationProblem {
  kind:
    | "foreign_tenant_object"
    | "unrecognized_key"
    | "destination_mismatch"
    | "row_missing_manifest"
    | "row_missing_by_id_pointer"
    | "row_missing_by_url_pointer"
    | "row_manifest_unreadable"
    | "row_manifest_mismatch"
    | "row_by_id_pointer_invalid"
    | "by_url_pointer_invalid"
    | "manifest_not_in_list_index"
    | "missing_list_index"
    | "invalid_list_index"
    | "missing_legacy_vector"
    | "unverified_tenant_vector";
  detail: string;
}

export interface FounderMigrationPlan {
  tenant: string;
  key_root: string;
  copies: PlannedCopy[];
  vectors: PlannedVector[];
  problems: MigrationProblem[];
  counts: {
    source_objects: number;
    retained_legacy: number;
    pending_copies: number;
    copied: number;
    by_category: Record<CopyCategory, number>;
    list_rows: number;
    ready_rows: number;
    pending_vectors: number;
    upserted_vectors: number;
  };
}

export interface FounderMigrationInput {
  tenantId: string;
  // The full bucket listing, absolute keys (both roots).
  objects: R2ObjectMeta[];
  // Parsed source index/list.json rows. Callers must parse the document
  // STRICTLY (the worker's own ListIndexSchema) and report a failure via
  // listIndexError instead of passing [] — a silently-empty row set would
  // plan zero vectors and reconcile a half-migrated corpus as complete.
  listRows: ListIndexItem[];
  // Why the list index could not be trusted (unparseable, schema drift,
  // listed-but-unreadable). Blocks the plan.
  listIndexError?: string;
  // Stored vectors keyed by PREFIXED id, confirmed in the tenant namespace.
  tenantVectors: ReadonlyMap<string, StoredVector>;
  // Stored legacy (un-namespaced) vectors keyed by bare reading id.
  legacyVectors: ReadonlyMap<string, StoredVector>;
  // What reading each row's manifest and by-id pointer actually CONTAIN,
  // keyed by row id. See RowEvidence.
  rowEvidence: ReadonlyMap<string, RowEvidence>;
  // What each by-url slot actually CONTAINS, keyed by the slot's url hash.
  // See ByUrlSlotEvidence.
  byUrlEvidence: ReadonlyMap<string, ByUrlSlotEvidence>;
}

// The content half of the per-row expectations. Key presence in the listing
// proves an object exists; it cannot prove the object says what the list index
// claims — and every downstream consequence of the migration reads content:
// the vector plan reads `status`, detail/content lookups hop through the by-id
// pointer's `key_prefix`, and the list rows themselves are what GET
// /api/readings serves. A row whose manifest is actually `ready` while the
// row says `failed` would migrate with no vector planned and still certify, so
// the plan requires the manifest's COMPLETE list projection
// (manifestToIndexItem — every field, not just id/url/status: a row with a
// stale title or tldr copies byte-identically and would otherwise certify out
// of sync with its manifest) and the pointer's target to agree with the row
// before certifying.
//
// Callers gather this by reading and STRICTLY parsing both objects, and only
// for rows whose objects the listing actually has — absence is already
// row_missing_manifest / row_missing_by_id_pointer, and must not be reported
// twice under a second kind.
export interface RowEvidence {
  // The manifest's full list projection (manifestToIndexItem minus the
  // key_prefix, which names where the manifest was read from rather than what
  // it contains), or why it could not be read/parsed.
  manifest?: ManifestListProjection;
  manifest_error?: string;
  // The parsed by-id pointer ({id, key_prefix}), or why it could not be
  // read/parsed.
  pointer?: { id: string; key_prefix: string };
  pointer_error?: string;
}

export type ManifestListProjection = Omit<ListIndexItem, "key_prefix">;

// The content half of the per-slot by-url expectations, keyed by url hash.
// Presence alone cannot certify a slot: `ReadingClaim.resolveOwner` parses the
// pointer before any repair logic runs, so a malformed slot throws on every
// submit and lookup for that URL with no self-heal — and it would copy
// verbatim into the tenant root. Callers gather this by strictly parsing each
// by-url object the listing has (absence is already
// row_missing_by_url_pointer).
export interface ByUrlSlotEvidence {
  pointer?: { id: string; key_prefix: string };
  pointer_error?: string;
}

// A migrated vector is only trusted when it carries the same embedding as the
// legacy vector it claims to migrate, the ADR 0002 tenant_id stamp, AND all of
// the legacy metadata. The metadata is not decorative: SimilarityStore.query
// reads url/title/tldr/tags/created_at straight off the matched vector, so a
// copy that kept the embedding but dropped or staled its metadata answers
// namespaced queries with nameless neighbours and starves the summarizer's
// context — while reconciling as migrated. This is exactly what the execute
// path writes ({...legacy.metadata, tenant_id}), so anything less is a stale
// earlier attempt or a partial write, repaired by re-planning it as pending —
// the re-upsert overwrites it.
function sameMetadataValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

// Structural equality over the JSON-shaped values a list projection carries
// (strings, arrays, nested error/attempt/similarity objects). Field order is
// irrelevant; presence is not — a field only one side carries is drift.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length &&
      aKeys.every((key, i) =>
        bKeys[i] === key &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      );
  }
  return false;
}

// Which projected fields disagree between the manifest's list projection and
// the row, over the union of both sides' fields — the row serves whatever it
// stored, so a field the manifest dropped is as stale as one it changed.
function projectionDrift(projection: ManifestListProjection, row: ListIndexItem): string[] {
  const { key_prefix: _ignored, ...rowFields } = row;
  const keys = [...new Set([...Object.keys(projection), ...Object.keys(rowFields)])].sort();
  const drift: string[] = [];
  for (const key of keys) {
    const manifestValue = (projection as Record<string, unknown>)[key];
    if (deepEqual(manifestValue, (rowFields as Record<string, unknown>)[key])) continue;
    drift.push(
      typeof manifestValue === "string"
        ? `${key} ${manifestValue}`
        : manifestValue === undefined
          ? `${key} absent from the manifest`
          : `${key} ${JSON.stringify(manifestValue)}`,
    );
  }
  return drift;
}

function migratedVectorMatches(
  tenantVec: StoredVector,
  legacyVec: StoredVector,
  tenantId: string,
): boolean {
  if (tenantVec.metadata?.tenant_id !== tenantId) return false;
  if (tenantVec.values.length !== legacyVec.values.length) return false;
  if (!tenantVec.values.every((v, i) => v === legacyVec.values[i])) return false;
  // Equality, not containment: a field the legacy vector no longer carries is
  // just as stale as a dropped one — query would return it, and the re-upsert
  // (legacy metadata + stamp, nothing else) is what removes it. tenant_id is
  // excluded from both sides because the migration adds it; its value is
  // already checked above.
  const legacyMeta = legacyVec.metadata ?? {};
  const tenantMeta = tenantVec.metadata ?? {};
  const migratedKeys = (meta: Record<string, unknown>): string[] =>
    Object.keys(meta).filter((key) => key !== "tenant_id").sort();
  const legacyKeys = migratedKeys(legacyMeta);
  const tenantKeys = migratedKeys(tenantMeta);
  if (legacyKeys.length !== tenantKeys.length) return false;
  return legacyKeys.every(
    (key, i) => tenantKeys[i] === key && sameMetadataValue(tenantMeta[key], legacyMeta[key]),
  );
}

export function founderKeyRoot(tenantId: string): string {
  return `${TENANT_ROOT_PREFIX}${tenantId}/`;
}

function categorize(key: string): CopyCategory {
  if (key === LIST_INDEX_KEY) return "list_index";
  if (key.startsWith(BY_ID_PREFIX)) return "by_id";
  if (key.startsWith(BY_URL_PREFIX)) return "by_url";
  if (key.startsWith(READINGS_PREFIX)) {
    if (key.endsWith(`/${MANIFEST_FILE}`)) return "manifest";
    if (key.endsWith(`/${EXTRACTED_FILE}`)) return "extracted";
    if (key.includes(`/${ATTEMPTS_PREFIX}`)) return "attempt";
    const base = key.slice(key.lastIndexOf("/") + 1);
    if (base.startsWith(RAW_PREFIX)) return "raw";
  }
  return "unrecognized";
}

export function planFounderMigration(input: FounderMigrationInput): FounderMigrationPlan {
  const keyRoot = founderKeyRoot(input.tenantId);
  const problems: MigrationProblem[] = [];

  const source: R2ObjectMeta[] = [];
  const dest = new Map<string, R2ObjectMeta>();
  for (const obj of input.objects) {
    if (obj.key.startsWith(keyRoot)) {
      dest.set(obj.key.slice(keyRoot.length), obj);
    } else if (obj.key.startsWith(TENANT_ROOT_PREFIX)) {
      problems.push({
        kind: "foreign_tenant_object",
        detail: `object under another tenant root: ${obj.key}`,
      });
    } else {
      source.push(obj);
    }
  }

  const byCategory: Record<CopyCategory, number> = {
    manifest: 0,
    extracted: 0,
    raw: 0,
    attempt: 0,
    by_id: 0,
    by_url: 0,
    list_index: 0,
    unrecognized: 0,
  };
  const sourceKeys = new Set<string>();
  const copies: PlannedCopy[] = [];
  for (const obj of source) {
    sourceKeys.add(obj.key);
    const category = categorize(obj.key);
    byCategory[category]++;
    if (category === "unrecognized") {
      problems.push({
        kind: "unrecognized_key",
        detail: `key outside the layout vocabulary (still copied): ${obj.key}`,
      });
    }
    const existing = dest.get(obj.key);
    let status: PlannedCopy["status"] = "pending";
    if (existing) {
      if (existing.size === obj.size && existing.etag === obj.etag) {
        status = "copied";
      } else {
        problems.push({
          kind: "destination_mismatch",
          detail:
            `${keyRoot}${obj.key} exists but differs from the source ` +
            `(size ${existing.size} vs ${obj.size}, etag ${existing.etag} vs ${obj.etag}); ` +
            "re-copy will overwrite it with the source bytes",
        });
      }
    }
    copies.push({
      from: obj.key,
      to: `${keyRoot}${obj.key}`,
      category,
      size: obj.size,
      etag: obj.etag,
      status,
    });
  }

  // Expectations from the list index, both directions: every row resolves to
  // a manifest and a by-id pointer in the source set, and every source
  // manifest is represented by a row — a manifest the index omits would copy
  // fine but never get a vector planned, so it must block instead of letting
  // reconciliation pass a corpus the index under-describes. (by-url pointers
  // are copied wholesale from the listing — ownership does not change under a
  // re-rooting.)
  if (input.listIndexError !== undefined) {
    problems.push({ kind: "invalid_list_index", detail: input.listIndexError });
  }
  if (!sourceKeys.has(LIST_INDEX_KEY)) {
    problems.push({ kind: "missing_list_index", detail: `${LIST_INDEX_KEY} not in the source layout` });
  }
  const rowKeyPrefixes = new Set(input.listRows.map((row) => row.key_prefix));
  const manifestSuffix = `/${MANIFEST_FILE}`;
  for (const key of sourceKeys) {
    if (!key.startsWith(READINGS_PREFIX) || !key.endsWith(manifestSuffix)) continue;
    const keyPrefix = key.slice(0, -manifestSuffix.length);
    if (!rowKeyPrefixes.has(keyPrefix)) {
      problems.push({
        kind: "manifest_not_in_list_index",
        detail: `${key} has no ${LIST_INDEX_KEY} row (rebuild the list index first: corpus rebuild-list --tenant global)`,
      });
    }
  }
  for (const row of input.listRows) {
    const evidence = input.rowEvidence.get(row.id);
    const manifestKey = `${row.key_prefix}/${MANIFEST_FILE}`;
    if (!sourceKeys.has(manifestKey)) {
      problems.push({
        kind: "row_missing_manifest",
        detail: `list row ${row.id} has no ${manifestKey}`,
      });
    } else if (evidence?.manifest === undefined) {
      problems.push({
        kind: "row_manifest_unreadable",
        detail: `${manifestKey} could not be read as a manifest: ${
          evidence?.manifest_error ?? "not read"
        }`,
      });
    } else {
      // The vector plan reads `status` off the ROW, and the list rows are
      // what readers are served; a row that misprojects its manifest silently
      // drops (or invents) that reading's vector — or serves a stale
      // title/tldr forever — so any disagreement across the FULL projection
      // must block until the index is rebuilt.
      const drift = projectionDrift(evidence.manifest, row);
      if (drift.length > 0) {
        problems.push({
          kind: "row_manifest_mismatch",
          detail:
            `list row ${row.id} (url ${row.url}, status ${row.status}) disagrees with ` +
            `${manifestKey}: ${drift.join(", ")} — the vector plan follows the row, so ` +
            "rebuild the list index first (corpus rebuild-list --tenant global)",
        });
      }
    }
    const pointerKey = `${BY_ID_PREFIX}${row.id}`;
    if (!sourceKeys.has(pointerKey)) {
      problems.push({
        kind: "row_missing_by_id_pointer",
        detail: `list row ${row.id} has no ${pointerKey}`,
      });
    } else if (evidence?.pointer === undefined) {
      problems.push({
        kind: "row_by_id_pointer_invalid",
        detail: `${pointerKey} could not be read as a by-id pointer: ${
          evidence?.pointer_error ?? "not read"
        }`,
      });
    } else if (
      evidence.pointer.id !== row.id ||
      evidence.pointer.key_prefix !== row.key_prefix
    ) {
      // The pointer copies verbatim under the tenant root, so a pointer aimed
      // at the wrong reading resolves the wrong manifest — or none — for every
      // detail and content lookup after cutover.
      problems.push({
        kind: "row_by_id_pointer_invalid",
        detail:
          `${pointerKey} targets ${evidence.pointer.id} at ${evidence.pointer.key_prefix}, ` +
          `not list row ${row.id} at ${row.key_prefix}`,
      });
    }
    // Duplicate-URL rows legitimately share one pointer owned by whichever
    // copy claimed it, so the per-row check is only that the row's URL slot
    // exists at all — a URL with no pointer anywhere would break lookup and
    // dedup identically after cutover, and must be repaired (a submit
    // re-claims it) before the corpus is certified. What the slot CONTAINS is
    // certified once per slot below.
    if (!sourceKeys.has(`${BY_URL_PREFIX}${urlHash(row.url)}`)) {
      problems.push({
        kind: "row_missing_by_url_pointer",
        detail: `list row ${row.id} has no ${BY_URL_PREFIX}{sha256} pointer for ${row.url}`,
      });
    }
  }

  // Every by-url slot the source has must parse and target a list row whose
  // URL actually hashes to that slot (ANY such row — duplicate-URL rows share
  // one owner). The slot copies verbatim, and resolveOwner parses it before
  // any repair logic runs, so a malformed slot throws on every submit and
  // lookup for its URL after cutover with no self-heal — while a mis-targeted
  // or dangling slot is stray ownership state the operator must disposition
  // (re-claim via submit, or drop) before the corpus is certified. Content is
  // only checked for slots the listing has: absence is already
  // row_missing_by_url_pointer.
  const rowsByUrlHash = new Map<string, ListIndexItem[]>();
  for (const row of input.listRows) {
    const hash = urlHash(row.url);
    const group = rowsByUrlHash.get(hash);
    if (group) group.push(row);
    else rowsByUrlHash.set(hash, [row]);
  }
  for (const key of [...sourceKeys].sort()) {
    if (!key.startsWith(BY_URL_PREFIX)) continue;
    const hash = key.slice(BY_URL_PREFIX.length);
    const evidence = input.byUrlEvidence.get(hash);
    if (evidence?.pointer === undefined) {
      problems.push({
        kind: "by_url_pointer_invalid",
        detail: `${key} could not be read as a by-url pointer: ${
          evidence?.pointer_error ?? "not read"
        }`,
      });
      continue;
    }
    const pointer = evidence.pointer;
    const owners = rowsByUrlHash.get(hash) ?? [];
    if (owners.some((row) => row.id === pointer.id && row.key_prefix === pointer.key_prefix)) {
      continue;
    }
    problems.push({
      kind: "by_url_pointer_invalid",
      detail:
        owners.length === 0
          ? `${key} targets ${pointer.id} at ${pointer.key_prefix}, but no list row's URL ` +
            "hashes to this slot — a dangling ownership pointer"
          : `${key} targets ${pointer.id} at ${pointer.key_prefix}, not any list row owning ` +
            `${owners[0]!.url}`,
    });
  }

  // Ready rows own the corpus's vectors (non-ready rows never completed an
  // upsert-bearing attempt); each migrates by re-upsert under the prefixed id.
  const vectors: PlannedVector[] = [];
  for (const row of input.listRows) {
    if (row.status !== "ready") continue;
    const prefixed = tenantVectorId(input.tenantId, row.id);
    const tenantVec = input.tenantVectors.get(prefixed);
    const legacyVec = input.legacyVectors.get(row.id);
    if (!tenantVec && !legacyVec) {
      problems.push({
        kind: "missing_legacy_vector",
        detail:
          `ready row ${row.id} has no legacy vector to migrate — ` +
          "restore it first (corpus backfill-vectors --tenant global)",
      });
      continue;
    }
    // "upserted" is a CONTENT verdict, not an id-presence one: with the
    // legacy vector still available the migrated copy must carry the same
    // values and the tenant_id stamp, else it re-plans as pending and the
    // next execute overwrites it. After the legacy vector is deleted
    // (post-observation cleanup) the values can no longer be compared, but
    // the tenant_id stamp is still required — a stampless prefixed vector is
    // an unverified artifact of some earlier partial write, and with no
    // source left to re-migrate from it blocks rather than certifies.
    if (tenantVec !== undefined && legacyVec === undefined) {
      if (tenantVec.metadata?.tenant_id === input.tenantId) {
        vectors.push({
          reading_id: row.id,
          legacy_id: row.id,
          tenant_vector_id: prefixed,
          status: "upserted",
        });
      } else {
        problems.push({
          kind: "unverified_tenant_vector",
          detail:
            `tenant vector ${prefixed} lacks its tenant_id stamp and its legacy source is gone — ` +
            "restore the source first (corpus backfill-vectors --tenant global), then re-migrate",
        });
      }
      continue;
    }
    const upserted =
      tenantVec !== undefined &&
      legacyVec !== undefined &&
      migratedVectorMatches(tenantVec, legacyVec, input.tenantId);
    vectors.push({
      reading_id: row.id,
      legacy_id: row.id,
      tenant_vector_id: prefixed,
      status: upserted ? "upserted" : "pending",
    });
  }

  const copied = copies.filter((c) => c.status === "copied").length;
  const upserted = vectors.filter((v) => v.status === "upserted").length;
  return {
    tenant: input.tenantId,
    key_root: keyRoot,
    copies,
    vectors,
    problems,
    counts: {
      source_objects: source.length,
      // Copy, not move: every source object is retained through the
      // observation window regardless of copy status.
      retained_legacy: source.length,
      pending_copies: copies.length - copied,
      copied,
      by_category: byCategory,
      list_rows: input.listRows.length,
      ready_rows: input.listRows.filter((r) => r.status === "ready").length,
      pending_vectors: vectors.length - upserted,
      upserted_vectors: upserted,
    },
  };
}

// Problems come in two classes. Execute-blocking problems mean the inventory
// or vector plan cannot be trusted, so an execute must abort before writing.
// The other two kinds are handled BY executing: a destination_mismatch is
// repaired when the copy loop overwrites the destination with the source
// bytes, and an unrecognized_key is still copied (zero lost objects) — though
// both remain problems for certification (isFullyMigrated) until the corpus
// matches and the operator has dispositioned any stray keys.
const EXECUTE_HANDLED_PROBLEMS: ReadonlySet<MigrationProblem["kind"]> = new Set([
  "destination_mismatch",
  "unrecognized_key",
]);

export function executeBlockingProblems(plan: FounderMigrationPlan): MigrationProblem[] {
  return plan.problems.filter((p) => !EXECUTE_HANDLED_PROBLEMS.has(p.kind));
}

// The reconciliation verdict: re-planning after an execute must show nothing
// pending and nothing wrong. This is the s1k.6 "counts and hashes reconcile
// with zero lost readings" gate in plan form — etag equality per object plus
// per-row expectations plus per-ready-row tenant vectors.
export function isFullyMigrated(plan: FounderMigrationPlan): boolean {
  return (
    plan.problems.length === 0 &&
    plan.counts.pending_copies === 0 &&
    plan.counts.pending_vectors === 0 &&
    plan.counts.source_objects > 0
  );
}
