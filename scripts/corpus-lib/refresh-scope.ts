// What a tier-1 refresh pass has to measure, and the run marker that decides it.
//
// `corpus refresh-neighbours --full` re-measures every ready reading.
// The scan is deterministic for an unchanged corpus, so a nightly sweep over an
// unchanged corpus spends its whole wall clock re-deriving snapshots it already
// holds: run A's immediate rerun measured 553 readings in 16 minutes and wrote
// zero of them.
//
// The only neighbourhoods that can have moved since the last run are the ones
// near a vector that was added, replaced, or removed. This module decides that
// set from the corpus listing and a run marker, as a pure function of data the
// caller has already fetched:
//
//   changed   rows created or reprocessed since the marker (`created_at` /
//             `updated_at`), whatever their status
//   reverse   the reverse neighbourhood of each changed reading's own vector:
//             a topK-100 query, keeping ids at or above REVERSE_SCORE_BOUND
//
// The bound sits a margin below SIMILARITY_FLOOR: a reading that far from the
// changed vector cannot cross the floor because that one vector changed, so it
// cannot gain or lose a floored neighbour. Where that reasoning runs out — a
// hundred results all at or above the bound, meaning the query was truncated
// and the real reverse set is unknown — the answer is not a narrower scope but
// a full sweep.
//
// The reverse query is the ONLY source of strangers, and that is enough for
// every change except a moved vector. A reading that cites a changed one had
// it above the floor when it was judged, so as long as that vector stays where
// it is — a re-summarize, a status flip to failed, a reprocess of the same
// content — the citer still scores above the bound and the reverse query finds
// it. Only a vector that MOVES leaves a citer behind, and nothing queryable
// remembers where it was.
//
// The scope is a nightly economy, not a correctness claim, and it is the weekly
// `--full` sweep that makes the trade safe. What a nightly pass can miss, all
// of it deliberate:
//
//   - a flag that persists on a reading nobody touched (the backfill's
//     `connection_below_floor` rows) stays invisible until that reading enters
//     scope or the next full sweep;
//   - a reprocess that moves a vector far enough to LEAVE a stranger's floored
//     neighbourhood: the reverse query runs against the vector's new position,
//     and the old one is gone. Nothing the planner can read remembers the old
//     neighbourhood — a list row carries no connections, tensions or
//     judged-candidate ids, so citations are only reachable by reading every
//     reading's relationships, which is the O(N) cost the scope exists to
//     avoid. That stranger's re-judgement is deferred to the sweep;
//   - and, more broadly than the moved-vector case, the stored `similarity`
//     snapshot and list row of ANY reading the scope leaves out. The bound
//     above is a claim about floored neighbourhoods, and therefore about
//     FLAGS. The snapshot is not: it summarises the RAW topK, sub-floor scores
//     included, so a vector merely ADDED anywhere enters some stranger's topK
//     and moves its `max`/`mean` at any score, well below the bound. Measured
//     on staging 2026-09-02 (docs/operations.md, "Scope"): an incremental pass
//     over eight newly ingested rows — four of them ready and holding a vector —
//     produced flags byte-identical to the sweep that
//     followed it, while that sweep still rewrote two snapshots the incremental
//     never measured — both sub-floor movements (0.221→0.239, 0.172→0.268),
//     neither able to change a flag. So between sweeps the `similarity`
//     numbers the API and the SPA serve are approximate rather than current.
//     It is deterministic and it clears on the next `--full`: an immediate
//     second sweep reported zero drift;
// A purge and an embedding-only write used to be on that list too, and are not
// any more:
//
//   - a purge is named, not counted. The marker records the list ids it saw,
//     so an id that has left the list escalates whatever the row count does —
//     a day that purges as many readings as it ingests no longer looks still.
//     Ids rather than a hash of them because the question is "which readings
//     are gone", and a digest answers only "something differs", which the row
//     timestamps already say. EVERY id, not just the ready
//     ones: status is not a statement about vector ownership (the same reason
//     the reverse queries ignore it), so a row that was ready last week, is
//     `failed` today and purged tomorrow would slip past a ready-only record
//     while its vector left the index. A row that merely stopped being ready is
//     not a removal — it is still in the list, its own timestamps put it in
//     `changed`, and its vector is queried from there.
//   - a write that moves embeddings without touching the readings rows
//     invalidates the marker: the row timestamps do not move while
//     neighbourhoods do. Such a writer stamps `invalidated_by` on the marker,
//     and the next pass sweeps on its own rather than on operator discipline.
//     (`corpus backfill-vectors`, which stamped it, was retired in
//     reading-lite-gh347.4.6 — `reading_embeddings` has a foreign key to
//     `readings` now, so a bare vector is unrepresentable. The field stays
//     because the marker must keep reading one written before that.)
//
// And the scope is only worth narrowing while it is narrower. Every reverse
// query and every measurement is one similarity query, and a sweep is one per
// ready reading. A bulk ingest or a mass reprocess can change so much that the
// reverse queries plus the readings they bring in cost more than the sweep
// they exist to avoid, for less coverage. `scopeCostTally` settles that with
// one rule, checked before the first reverse query and again before each one
// after it:
//
//   reverse queries not yet issued + ready readings known to be in scope
//     > ready readings in the list   →   sweep
//
// Queries already issued are spent either way, so they do not count; the
// in-scope set only grows, and overlapping reverse results count once. A tie
// stays incremental: the two passes cost the same, and a tie is where a quiet
// corpus whose only scope is its carried unmeasurable readings sits — a sweep
// there would be read as a configuration failure (see the zero-measured check
// in the command). Manifest reads are not counted, which leans the rule toward
// sweeping, the direction that covers more. `--limit` plays no part: it
// applies to whichever plan the scope produces.
//
// What is NOT deferred: a reading the rules above DO bring into scope is a
// measurement target like any other, so its `similarity` snapshot and its list
// row are brought current in the same pass, not just flagged for tier 2.
//
// This scope is the default as of the staging proof recorded in
// docs/operations.md; `--full` is the explicit weekly sweep.
//
// Pure by construction: the reverse-neighbour queries are performed by the
// command and handed in as data, so every rule here is unit-testable without a
// database.

import { SIMILARITY_FLOOR } from "../../src/modules/stores/similarity-store";
import type { RefreshRow } from "./refresh-neighbours";

/** topK for a reverse-neighbour query. */
export const REVERSE_TOP_K = 100;

/**
 * The score at or above which a reverse match is taken into scope. Derived from
 * the floor rather than written next to it: the question is not "is this a
 * neighbour" but "could this reading's floored neighbourhood have moved", and
 * the margin is the room a single vector's arrival or departure has to push a
 * score across the floor. Lowering SIMILARITY_FLOOR must lower this with it,
 * which a literal would not.
 */
export const REVERSE_SCORE_BOUND = SIMILARITY_FLOOR - 0.1;

/**
 * The stored marker's format. Bumped from 1 when `list_row_count` became
 * `list_ids`, and from 2 when the marker moved onto the rows it describes
 * (reading-lite-gh347.4.1) and lost `list_etag` with the document that had one.
 * A marker the parser does not recognise is rejected rather than migrated, and
 * the bump is what lets the command say "this marker predates the current
 * format" rather than "this marker is damaged" — the same null, very different
 * operator instructions. The pass that meets an old one sweeps and writes a
 * current one, which is correct rather than lossy: a sweep measures everything
 * the marker would have narrowed away.
 */
export const REFRESH_STATE_VERSION = 3;

/**
 * The per-tenant run marker, a `corpus_refresh_state` row (db/migrations/0006).
 */
export interface RefreshState {
  version: typeof REFRESH_STATE_VERSION;
  /** When the last pass that advanced the marker ran. */
  last_run_at: string;
  /** When the last FULL pass ran; absent until one has. */
  last_full_run_at?: string;
  /**
   * The ids of every row in `index/list.json` the last pass saw, sorted. One of
   * these missing from a later list is a purge, which nothing else in the
   * marker can name.
   */
  list_ids: string[];
  /**
   * Readings that were in scope and could not be measured — no vector, or a
   * manifest that fails ManifestSchema. Carried so every later pass measures
   * them again: nothing about their own row will change when the vector is
   * restored or the manifest repaired, so without this they would drop out of
   * every incremental scope until the next sweep.
   */
  unmeasurable_ids?: string[];
  /**
   * Set by a command that moved vectors without moving anything in R2 that a
   * scope can read (`corpus backfill-vectors`). Its presence forces the next
   * pass full; advancing the marker clears it.
   */
  invalidated_by?: string;
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
  if (rec.version !== REFRESH_STATE_VERSION) return null;
  if (!isTimestamp(rec.last_run_at)) return null;
  const listIds = parseIdList(rec.list_ids);
  if (listIds === null) return null;
  // The three fields below are read as "the whole marker is damaged" rather
  // than dropped the way an unusable `last_full_run_at` is, because dropping
  // any of them narrows a pass on data that is not there: a lost
  // `invalidated_by` scopes a night that owed the corpus a sweep, and lost
  // unmeasurable ids silently stop retrying the readings nobody else will.
  if (rec.unmeasurable_ids !== undefined && parseIdList(rec.unmeasurable_ids) === null) return null;
  if (
    rec.invalidated_by !== undefined &&
    (typeof rec.invalidated_by !== "string" || rec.invalidated_by === "")
  ) {
    return null;
  }
  // Normalized, not echoed: this timestamp is copied into the report header,
  // which tier 2 parses with z.string().datetime(), so a marker spelled any
  // other way Date.parse accepts would make the whole report unreadable to the
  // next command in the chain.
  const state: RefreshState = {
    version: REFRESH_STATE_VERSION,
    last_run_at: new Date(rec.last_run_at).toISOString(),
    list_ids: listIds,
  };
  const unmeasurable = rec.unmeasurable_ids === undefined ? [] : parseIdList(rec.unmeasurable_ids)!;
  if (unmeasurable.length > 0) state.unmeasurable_ids = unmeasurable;
  if (typeof rec.invalidated_by === "string" && rec.invalidated_by !== "") {
    state.invalidated_by = rec.invalidated_by;
  }
  if (isTimestamp(rec.last_full_run_at)) {
    state.last_full_run_at = new Date(rec.last_full_run_at).toISOString();
  }
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
  /** Every id in the list this pass read. */
  listIds: readonly string[];
  /** The in-scope ids this pass could not measure, if any. */
  unmeasurableIds?: readonly string[];
}): RefreshState {
  const lastFull = opts.full ? opts.runAt : opts.previous?.last_full_run_at;
  const state: RefreshState = {
    version: REFRESH_STATE_VERSION,
    last_run_at: opts.runAt,
    list_ids: [...new Set(opts.listIds)].sort(),
  };
  if (lastFull !== undefined) state.last_full_run_at = lastFull;
  // Rebuilt from this pass, never merged with the previous marker's list: a
  // carried id was measured again this pass, so it is in this set if and only
  // if it is still unmeasurable.
  const unmeasurable = [...new Set(opts.unmeasurableIds ?? [])].sort();
  if (unmeasurable.length > 0) state.unmeasurable_ids = unmeasurable;
  // `invalidated_by` is deliberately not carried: this pass measured its whole
  // scope, so whatever forced it full has been answered.
  return state;
}

export interface ChangedSince {
  kind: "incremental";
  since: string;
  changed: string[];
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
): FullScope | ChangedSince {
  if (marker === null) return { kind: "full", reason: "no usable run marker" };
  // A command that changed vectors without changing anything R2 can date says
  // so here. Checked first: it is true however still the list looks, and the
  // ETag shortcut below would otherwise call that night unchanged.
  if (marker.invalidated_by !== undefined) {
    return { kind: "full", reason: `run marker invalidated by ${marker.invalidated_by}` };
  }
  // A purge removes a row and leaves nothing behind to date: neither the gone
  // reading nor the readings that silently lost a neighbour can be named from
  // the list alone, so a purge is the one change only a full sweep covers.
  // Detected by name rather than by count, so it is still detected on a day
  // that ingests at least as many readings as it purges. (A grown corpus is
  // fully explained by created_at.)
  const present = new Set(list.map((row) => row.id));
  const removed = marker.list_ids.filter((id) => !present.has(id));
  if (removed.length > 0) {
    return {
      kind: "full",
      reason: `${removed.length} reading(s) removed since the last run, first ${removed[0]}`,
    };
  }
  const sinceMs = Date.parse(marker.last_run_at) - MARKER_CLOCK_SKEW_MS;
  // Every row is dated by the same rule, with no whole-corpus shortcut. The
  // list index had an ETag, and an unchanged one meant no row could have moved;
  // rows have no such token, and inventing one from a MAX(updated_at) would
  // answer a question this scan already answers per row.
  const changed = list.filter((row) => rowChangedSince(row, sinceMs)).map((row) => row.id);
  return {
    kind: "incremental",
    since: marker.last_run_at,
    changed: [...new Set(changed)].sort(),
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
): RefreshScope {
  const base = changedSince(list, marker);
  if (base.kind === "full") return base;

  const known = new Set(list.map((row) => row.id));
  const statusById = new Map(list.map((row) => [row.id, row.status]));
  const scope = new Set<string>(base.changed);
  // Every changed reading is examined even once one has already forced a full
  // sweep. The queries are already made and the decision is already taken; what
  // the extra pass buys is the counts in the reason, which are the only way an
  // operator can tell "one unusual reading escalated tonight" from "this corpus
  // saturates every night and --since-last-run is buying nothing".
  const missing: string[] = [];
  const vectorless: string[] = [];
  const saturated: string[] = [];

  for (const id of base.changed) {
    if (!reverseNeighbours.has(id)) {
      missing.push(id);
      continue;
    }
    const matches = reverseNeighbours.get(id) ?? null;
    if (matches === null) {
      // A ready reading owes the corpus a vector. Without one there is nothing
      // to scope its former neighbours from, and the row count does not shrink
      // to say so — a sweep is the only honest answer. A non-ready reading
      // having no vector is ordinary, and its citers are reached through the
      // vectors that remain.
      if (statusById.get(id) === "ready") vectorless.push(id);
      continue;
    }
    if (isSaturated(matches)) {
      saturated.push(id);
      continue;
    }
    for (const match of reverseScopeIds(matches, known)) scope.add(match);
  }

  // One reason carrying every count, rather than the first cause found: a
  // transient query failure must not hide that the other forty changed
  // readings all saturated.
  const causes: string[] = [];
  if (missing.length > 0) {
    causes.push(`${missing.length} unanswered reverse quer(ies), first ${missing[0]}`);
  }
  if (vectorless.length > 0) {
    causes.push(`${vectorless.length} ready reading(s) with no vector, first ${vectorless[0]}`);
  }
  if (saturated.length > 0) {
    causes.push(
      `${saturated.length} saturated reverse neighbourhood(s) ` +
      `(no match below ${REVERSE_SCORE_BOUND.toFixed(2)}), first ${saturated[0]}`,
    );
  }
  if (causes.length > 0) {
    return {
      kind: "full",
      reason: `${causes.join("; ")} — of ${base.changed.length} changed reading(s)`,
    };
  }

  // Readings a previous pass could not measure, added to the scope but NOT to
  // `changed`: they are measurement targets, not evidence that a neighbourhood
  // moved. Putting a vectorless one in `changed` would escalate the very pass
  // that exists to retry it.
  // Ready rows only, because those are the ones planRefresh will actually
  // measure: a carried id that has since gone non-ready would otherwise inflate
  // the scope count tiers 2 and 3 print without ever being looked at. Dropping
  // it is not permanent for the ordinary case — a reprocess that lands ready
  // moves the row's timestamps, which is what `changed` reads — but a repair
  // that touches neither the list row nor the vector index does wait for the
  // weekly sweep.
  const carried = carriedIds(list, marker);
  for (const id of carried) scope.add(id);

  const changedReason = `${base.changed.length} reading(s) changed since ${base.since}`;
  return {
    kind: "incremental",
    reason:
      carried.length === 0
        ? changedReason
        : `${changedReason}; ${carried.length} unmeasurable reading(s) carried forward`,
    since: base.since,
    ids: [...scope].sort(),
    changed: base.changed,
  };
}

/**
 * Tracks what an incremental scope will cost while its reverse queries are
 * being made, and says when a full sweep has become cheaper (the rule is in the
 * header above). The command asks `check` before issuing each reverse query and
 * `add`s each answer, so a scope that is no longer worth narrowing stops
 * spending queries on it instead of finishing them first.
 */
export interface ScopeCostTally {
  /** Counts the ready readings one reverse answer brings into scope. */
  add(matches: ReverseMatches): void;
  /**
   * `full` when the reverse queries not yet issued plus the ready readings
   * known to be in scope cost more than sweeping every ready reading;
   * otherwise `null`. `asked` is how many reverse queries have been issued.
   */
  check(asked: number): FullScope | null;
}

export function scopeCostTally(
  list: readonly RefreshRow[],
  changed: readonly string[],
  marker: RefreshState | null,
): ScopeCostTally {
  const known = new Set(list.map((row) => row.id));
  const ready = new Set(list.filter((row) => row.status === "ready").map((row) => row.id));
  // The ready ids the pass will measure, as far as is known so far. A set, so a
  // reading several changed vectors bring in is one measurement, not several.
  const toMeasure = new Set<string>();
  const admit = (id: string): void => {
    if (ready.has(id)) toMeasure.add(id);
  };
  for (const id of changed) admit(id);
  for (const id of carriedIds(list, marker)) admit(id);
  return {
    add(matches) {
      // A saturated or missing answer escalates on its own at the end; its
      // matches are not a scope, so they are not a cost either.
      if (matches === null || isSaturated(matches)) return;
      for (const id of reverseScopeIds(matches, known)) admit(id);
    },
    check(asked) {
      const remaining = changed.length - asked;
      const incremental = remaining + toMeasure.size;
      if (incremental <= ready.size) return null;
      return {
        kind: "full",
        reason:
          `incremental scope would cost at least ${incremental} similarity queries ` +
          `(${remaining} reverse still to run, ${toMeasure.size} reading(s) to measure) ` +
          `against ${ready.size} for a full sweep — after ${asked} of ` +
          `${changed.length} changed reading(s)`,
      };
    },
  };
}

/** The one-line scope summary for the command header and the report. */
export function describeScope(scope: RefreshScope): string {
  return scope.kind === "full"
    ? `Scope: full — ${scope.reason}`
    : `Scope: incremental (${scope.ids.length} reading(s)) — ${scope.reason}`;
}

/**
 * True when the reverse set this reading contributes is unknown rather than
 * complete — the query was cut off at topK and every match it did return is at
 * or above the bound, so there may be more above it that never came back.
 *
 * A result shorter than topK is complete by construction: the scan returned
 * everything it had, bound or no bound. That is what keeps an isolated reading
 * — one match, itself, at 1.0 — from escalating every night.
 *
 * The comparison is against the minimum rather than the last element, because
 * nothing in the query path sorts or asserts a descending order and this
 * escalation is too important to rest on an ordering nobody guarantees.
 */
function isSaturated(matches: readonly { score: number }[]): boolean {
  // Empty is unknown, not complete — a vector that exists always matches
  // itself. The command normalises both adapters' spellings of "no reverse
  // set" to null before this, so an empty list should not arrive; treating it
  // as unknown keeps the rule safe if one ever does.
  if (matches.length === 0) return true;
  if (matches.length < REVERSE_TOP_K) return false;
  return Math.min(...matches.map((match) => match.score)) >= REVERSE_SCORE_BOUND;
}

/**
 * The ids one complete reverse answer brings into scope: matches at or above
 * the bound that are still in the list.
 */
function reverseScopeIds(
  matches: readonly { id: string; score: number }[],
  known: ReadonlySet<string>,
): string[] {
  return matches
    .filter((match) => match.score >= REVERSE_SCORE_BOUND && known.has(match.id))
    .map((match) => match.id);
}

/**
 * The marker's unmeasurable ids that are still ready — the ones a pass carries
 * forward for retry (see incrementalScope for why only ready ones).
 */
function carriedIds(list: readonly RefreshRow[], marker: RefreshState | null): string[] {
  const ready = new Set(list.filter((row) => row.status === "ready").map((row) => row.id));
  return (marker?.unmeasurable_ids ?? []).filter((id) => ready.has(id));
}

/**
 * How far back the marker is read from its own timestamp. The marker is stamped
 * by the operator's clock and compared against `created_at`/`updated_at` written
 * by the Worker's; a few minutes of forward skew on the operator host would
 * otherwise drop a reading from every future scope, invisibly and permanently.
 * The margin only ever measures more, so it cannot make a pass wrong.
 */
export const MARKER_CLOCK_SKEW_MS = 5 * 60 * 1000;

function rowChangedSince(row: RefreshRow, sinceMs: number): boolean {
  // No usable timestamp at all is treated as changed: one extra measurement is
  // cheap, and a row that cannot be dated must not be assumed still.
  const created = Date.parse(row.created_at ?? "");
  const updated = Date.parse(row.updated_at ?? "");
  if (!Number.isFinite(created) && !Number.isFinite(updated)) return true;
  if (Number.isFinite(created) && created > sinceMs) return true;
  return Number.isFinite(updated) && updated > sinceMs;
}

/**
 * A stored list of reading ids, deduplicated and sorted, or `null` when the
 * value is not one. Sorted on the way in as well as out so a hand-edited marker
 * cannot make the scope depend on the order someone typed.
 */
function parseIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === "string" && id !== "")) return null;
  return [...new Set(value as string[])].sort();
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
