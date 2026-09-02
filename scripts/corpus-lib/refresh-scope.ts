// What a tier-1 refresh pass has to measure, and the run marker that decides it.
//
// `corpus refresh-neighbours` re-measures every ready reading on every run.
// Vectorize is deterministic for an unchanged index, so a nightly pass over an
// unchanged corpus spends its whole wall clock re-deriving snapshots it already
// holds: run A's immediate rerun measured 553 readings in 16 minutes and wrote
// zero of them.
//
// The only neighbourhoods that can have moved since the last run are the ones
// near a vector that was added, replaced, or removed. This module decides that
// set from the list index and a run marker, as a pure function of data the
// caller has already fetched:
//
//   changed   rows created or reprocessed since the marker (`created_at` /
//             `updated_at`), whatever their status
//   citers    rows that cite a changed id — connections, tensions, or the
//             neighbourhood the last judgement considered
//   reverse   the reverse neighbourhood of each changed reading's own vector:
//             a topK-100 query, keeping ids at or above REVERSE_SCORE_BOUND
//
// The bound is deliberately far below SIMILARITY_FLOOR (0.5): a reading whose
// nearest neighbour scores 0.45 cannot cross the floor because one vector
// changed, so it cannot gain or lose a floored neighbour. Where that reasoning
// runs out — a hundred results all at or above the bound, meaning the query was
// truncated and the real reverse set is unknown — the answer is not a narrower
// scope but a full sweep.
//
// The scope is a nightly economy, not a correctness claim, and it is the weekly
// `--full` sweep that makes the trade safe. Three things a nightly pass can
// miss, all of them deliberate:
//
//   - a flag that persists on a reading nobody touched (the backfill's
//     `connection_below_floor` rows) stays invisible until that reading enters
//     scope or the next full sweep;
//   - a reprocess that moves a vector far enough to LEAVE a stranger's floored
//     neighbourhood: the reverse query runs against the vector's new position,
//     and the old one is gone. Where the stranger had already judged it, the
//     citation union catches it; where it had not, only the sweep does — and
//     what goes stale there is not just a deferred re-judgement but the
//     stranger's stored `similarity` snapshot and list row, which the API and
//     the SPA serve;
//   - a purge, unless it shrinks the list: the check is a row count, so a day
//     that purges as many readings as it ingests does not escalate, and the
//     readings that silently lost a neighbour wait for the sweep. Recording a
//     digest of ids instead of a cardinality would close this; it has not been
//     done, so the weekly sweep is load-bearing.
//   - a Vectorize-only write. `corpus backfill-vectors` restores vectors with
//     R2 read-only, so neither the row timestamps nor the list ETag move while
//     neighbourhoods do. Run a `--full` pass after one.
//
// `--full` stays the default until the staging proof lands.
//
// Pure by construction: the reverse-neighbour queries are performed by the
// command and handed in as data, so every rule here is unit-testable without a
// Vectorize index.

import type { RefreshRow } from "./refresh-neighbours";

/** topK for a reverse-neighbour query. */
export const REVERSE_TOP_K = 100;

/**
 * The score at or above which a reverse match is taken into scope. Below the
 * similarity floor by a wide margin, because the question is not "is this a
 * neighbour" but "could this reading's floored neighbourhood have moved".
 */
export const REVERSE_SCORE_BOUND = 0.45;

/** The per-tenant run marker, stored at `index/refresh-state.json`. */
export interface RefreshState {
  version: 1;
  /** When the last pass that advanced the marker ran. */
  last_run_at: string;
  /** When the last FULL pass ran; absent until one has. */
  last_full_run_at?: string;
  /** `index/list.json` row count at that moment — a purge shrinks it. */
  list_row_count: number;
  /** `index/list.json` ETag, when the storage path exposes one. */
  list_etag?: string;
}

/**
 * One reverse-neighbour query result: the matches of a topK-REVERSE_TOP_K query
 * on that reading's own vector, score-descending, or `null` when the reading
 * owns no vector to query.
 */
export type ReverseMatches = readonly { id: string; score: number }[] | null;

export interface FullScope {
  kind: "full";
  /** Why the pass could not be narrowed, for the header and the report. */
  reason: string;
}

export interface IncrementalScope {
  kind: "incremental";
  reason: string;
  /** The marker timestamp the scope was computed against. */
  since: string;
  /** Every id to measure, sorted. A subset of the ids present in the list. */
  ids: string[];
  /** The changed ids the rest of the scope was derived from, sorted. */
  changed: string[];
}

export type RefreshScope = FullScope | IncrementalScope;

/**
 * Parses a stored run marker. Anything unusable — absent, wrong shape,
 * unparseable timestamp — is `null`, which every caller reads as "no marker",
 * and a missing marker means a full sweep. A damaged marker must never narrow a
 * pass.
 */
export function parseRefreshState(raw: unknown): RefreshState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1) return null;
  if (!isTimestamp(rec.last_run_at)) return null;
  if (typeof rec.list_row_count !== "number" || !Number.isInteger(rec.list_row_count)) return null;
  if (rec.list_row_count < 0) return null;
  const state: RefreshState = {
    version: 1,
    last_run_at: rec.last_run_at,
    list_row_count: rec.list_row_count,
  };
  if (isTimestamp(rec.last_full_run_at)) state.last_full_run_at = rec.last_full_run_at;
  if (typeof rec.list_etag === "string" && rec.list_etag !== "") state.list_etag = rec.list_etag;
  return state;
}

/**
 * The marker to store after a pass that measured everything in its scope and
 * wrote what drifted. `last_full_run_at` only advances for a full pass — it is
 * what a weekly-sweep policy is judged against, so an incremental run must not
 * make the corpus look freshly swept.
 */
export function buildRefreshState(opts: {
  previous: RefreshState | null;
  runAt: string;
  full: boolean;
  listRowCount: number;
  listEtag?: string;
}): RefreshState {
  const lastFull = opts.full ? opts.runAt : opts.previous?.last_full_run_at;
  const state: RefreshState = {
    version: 1,
    last_run_at: opts.runAt,
    list_row_count: opts.listRowCount,
  };
  if (lastFull !== undefined) state.last_full_run_at = lastFull;
  if (opts.listEtag !== undefined && opts.listEtag !== "") state.list_etag = opts.listEtag;
  return state;
}

export interface ChangedSince {
  kind: "incremental";
  since: string;
  changed: string[];
  /** True when the list index is byte-identical to the one the marker saw. */
  listUnchanged: boolean;
}

/**
 * The rows whose own state moved since the marker, and therefore whose vectors
 * may have been added, replaced, or removed. `full` when the marker cannot
 * support the question at all.
 *
 * Exported because the command needs the changed ids BEFORE it can run the
 * reverse-neighbour queries that `incrementalScope` consumes; both derive the
 * set from the same call, so they cannot disagree.
 */
export function changedSince(
  list: readonly RefreshRow[],
  marker: RefreshState | null,
  listEtag?: string,
): FullScope | ChangedSince {
  if (marker === null) return { kind: "full", reason: "no usable run marker" };
  // A purge removes a row and leaves nothing behind to date: neither the gone
  // reading nor the readings that silently lost a neighbour can be named from
  // the list alone, so a shrunk corpus is the one change only a full sweep
  // covers. (A grown corpus is fully explained by created_at.)
  if (list.length < marker.list_row_count) {
    return {
      kind: "full",
      reason: `${marker.list_row_count - list.length} list row(s) removed since the last run`,
    };
  }
  const sinceMs = Date.parse(marker.last_run_at);
  // The ETag is the strongest statement available: an unchanged document means
  // no row was created, reprocessed, purged, or re-flushed, so nothing can have
  // moved. Only equality is informative — every --execute flush rewrites the
  // document, so a differing ETag says nothing on its own.
  const listUnchanged =
    listEtag !== undefined && marker.list_etag !== undefined && listEtag === marker.list_etag;
  const changed = listUnchanged
    ? []
    : list.filter((row) => rowChangedSince(row, sinceMs)).map((row) => row.id);
  return {
    kind: "incremental",
    since: marker.last_run_at,
    changed: [...new Set(changed)].sort(),
    listUnchanged,
  };
}

/**
 * The ids a run must measure, given the list, the run marker, and one
 * reverse-neighbour query result per changed id (`null` for a reading that owns
 * no vector). A changed id with no entry in the map is a query that was never
 * made or failed: the scope cannot be trusted to be complete, so the pass
 * escalates rather than quietly measuring less.
 */
export function incrementalScope(
  list: readonly RefreshRow[],
  marker: RefreshState | null,
  reverseNeighbours: ReadonlyMap<string, ReverseMatches>,
  listEtag?: string,
): RefreshScope {
  const base = changedSince(list, marker, listEtag);
  if (base.kind === "full") return base;

  const known = new Set(list.map((row) => row.id));
  const changed = new Set(base.changed);
  const scope = new Set<string>(base.changed);

  for (const id of base.changed) {
    if (!reverseNeighbours.has(id)) {
      return { kind: "full", reason: `no reverse-neighbour result for ${id}` };
    }
    const matches = reverseNeighbours.get(id) ?? null;
    if (matches === null) continue;
    if (isSaturated(matches)) {
      return {
        kind: "full",
        reason:
          `reverse neighbourhood of ${id} is saturated ` +
          `(${REVERSE_TOP_K} matches at or above ${REVERSE_SCORE_BOUND})`,
      };
    }
    for (const match of matches) {
      if (match.score < REVERSE_SCORE_BOUND) continue;
      if (known.has(match.id)) scope.add(match.id);
    }
  }

  // A reading that cites a changed id has a stale citation, a below-floor
  // citation, or a candidate that moved — all of them tier-1 flags that the
  // reverse query cannot see, because the citation may score below the bound.
  for (const row of list) {
    if (scope.has(row.id)) continue;
    if (citesAny(row, changed)) scope.add(row.id);
  }

  return {
    kind: "incremental",
    reason: base.listUnchanged
      ? "index/list.json unchanged since the last run"
      : `${base.changed.length} reading(s) changed since ${base.since}`,
    since: base.since,
    ids: [...scope].sort(),
    changed: base.changed,
  };
}

/** The one-line scope summary for the command header and the report. */
export function describeScope(scope: RefreshScope): string {
  return scope.kind === "full"
    ? `Scope: full — ${scope.reason}`
    : `Scope: incremental (${scope.ids.length} reading(s)) — ${scope.reason}`;
}

// Truncated at topK with the last match still at or above the bound: there may
// be more matches above it that the query never returned, so the reverse set
// this reading contributes is unknown rather than empty.
function isSaturated(matches: readonly { score: number }[]): boolean {
  if (matches.length < REVERSE_TOP_K) return false;
  const last = matches[REVERSE_TOP_K - 1];
  return last !== undefined && last.score >= REVERSE_SCORE_BOUND;
}

function rowChangedSince(row: RefreshRow, sinceMs: number): boolean {
  // No usable timestamp at all is treated as changed: one extra measurement is
  // cheap, and a row that cannot be dated must not be assumed still.
  const created = Date.parse(row.created_at ?? "");
  const updated = Date.parse(row.updated_at ?? "");
  if (!Number.isFinite(created) && !Number.isFinite(updated)) return true;
  if (Number.isFinite(created) && created > sinceMs) return true;
  return Number.isFinite(updated) && updated > sinceMs;
}

function citesAny(row: RefreshRow, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  for (const connection of row.connections ?? []) {
    if (typeof connection?.id === "string" && ids.has(connection.id)) return true;
  }
  for (const tension of row.tensions ?? []) {
    if (typeof tension?.id === "string" && ids.has(tension.id)) return true;
  }
  for (const id of row.connections_neighbourhood_ids ?? []) {
    if (ids.has(id)) return true;
  }
  return false;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
