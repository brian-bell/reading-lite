// Pure planning + staleness diff for `corpus-refresh-neighbours`.
//
// Tier 1 of the nightly corpus refresh: re-measure every ready reading against
// Vectorize (no embedding calls, no LLM) and flag those whose stored
// connections/verdict no longer match the current floored neighbourhood. The
// command writes drifted `manifest.similarity` snapshots with the same
// one-field discipline as backfill-similarity (`withSimilarity` /
// `validateBackfillWrite`) and emits refresh-report.json as the tier-2 input.
//
// Similarity is a measurement; connections are a judgement. This module only
// measures and diffs. It never rewrites title, tldr, tags, keywords, entities,
// or summary_markdown.

import {
  SIMILAR_TOP_K,
  SIMILARITY_FLOOR,
  aboveFloor,
  excludeSelf,
  type SimilaritySnapshot,
} from "../../src/modules/stores/similarity-store";

// Material-change gate for rewriting a stored snapshot. Count is exact;
// max/mean use a 0.02 cosine epsilon so nightly jitter around the same
// neighbourhood does not churn computed_at. Calibrated as a starting point
// against the same live-corpus sample that set SIMILARITY_FLOOR (rank-1
// nearest typically moves by more than this when a real neighbour arrives or
// leaves; the 0.51-0.54 same-domain tail moves by less). Revisit after the
// first full production run.
export const SNAPSHOT_CHANGE_EPSILON = 0.02;

export type RefreshFlag =
  | "stale_connection"
  | "connection_below_floor"
  | "new_neighbour"
  | "uncited_neighbour"
  | "verdict_inconsistent";

export type JudgedAtSource = "connections_computed_at" | "last_attempt" | "updated_at";

export interface RefreshNeighbour {
  id: string;
  score: number;
  title?: string;
  tldr?: string;
  tags?: string[];
  created_at?: string;
}

export interface RefreshConnection {
  id: string;
  reason: string;
}

export interface RefreshRow {
  id: string;
  url: string;
  status: string;
  key_prefix: string;
  created_at?: string;
  updated_at?: string;
  novelty_verdict?: string;
  connections?: RefreshConnection[];
  tensions?: { id: string }[];
  similarity?: SimilaritySnapshot;
  connections_computed_at?: string;
  connections_neighbourhood_ids?: string[];
  last_attempt?: { status?: string; finished_at?: string; stage?: string; trigger?: string };
}

export interface RefreshPlan {
  targets: RefreshRow[];
  skippedNotReady: number;
}

export interface JudgedAt {
  judged_at?: string;
  judged_at_source?: JudgedAtSource;
}

export interface RefreshReportNeighbour {
  id: string;
  score: number;
  title?: string;
  tldr?: string;
  tags?: string[];
  created_at?: string;
}

export interface RefreshReportReading {
  id: string;
  key_prefix: string;
  url: string;
  reasons: RefreshFlag[];
  novelty_verdict?: string;
  connections: RefreshConnection[];
  judged_at?: string;
  judged_at_source?: JudgedAtSource;
  current_neighbours: RefreshReportNeighbour[];
}

/**
 * What the run looked at. A full report is a statement about the whole ready
 * corpus; an incremental one is a statement about the readings whose
 * neighbourhood could have moved since `since` (see refresh-scope.ts), and a
 * reading missing from it may simply never have been measured.
 */
export interface RefreshReportScope {
  kind: "full" | "incremental";
  reason: string;
  since?: string;
  readings_in_scope?: number;
}

export interface RefreshReport {
  version: 1;
  generated_at: string;
  tenant: string;
  floor: number;
  scope?: RefreshReportScope;
  readings: RefreshReportReading[];
}

export function planRefresh(
  items: RefreshRow[],
  opts: { only?: string[]; limit?: number; scope?: ReadonlySet<string> } = {},
): RefreshPlan {
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  let skippedNotReady = 0;
  const targets: RefreshRow[] = [];
  for (const it of items) {
    // The incremental scope (refresh-scope.ts) and --only compose: an operator
    // naming ids gets exactly those, intersected with what the scope allows.
    if (opts.scope !== undefined && !opts.scope.has(it.id)) continue;
    if (only && !only.has(it.id)) continue;
    if (it.status !== "ready") {
      skippedNotReady++;
      continue;
    }
    targets.push(it);
  }
  const limited = opts.limit === undefined ? targets : targets.slice(0, opts.limit);
  return { targets: limited, skippedNotReady };
}

export function resolveJudgedAt(reading: RefreshRow): JudgedAt {
  if (isTimestamp(reading.connections_computed_at)) {
    return {
      judged_at: reading.connections_computed_at,
      judged_at_source: "connections_computed_at",
    };
  }
  const attempt = reading.last_attempt;
  if (attempt?.status === "succeeded" && isTimestamp(attempt.finished_at)) {
    return { judged_at: attempt.finished_at, judged_at_source: "last_attempt" };
  }
  if (isTimestamp(reading.updated_at)) {
    return { judged_at: reading.updated_at, judged_at_source: "updated_at" };
  }
  return {};
}

export function snapshotChanged(
  oldSnap: SimilaritySnapshot | undefined,
  newSnap: SimilaritySnapshot,
): boolean {
  if (oldSnap === undefined) return true;
  if (oldSnap.count !== newSnap.count) return true;
  if (metricChanged(oldSnap.max, newSnap.max)) return true;
  if (metricChanged(oldSnap.mean, newSnap.mean)) return true;
  return false;
}

export function flooredNeighbours(
  id: string,
  matches: RefreshNeighbour[],
): RefreshNeighbour[] {
  return aboveFloor(excludeSelf(matches, id, SIMILAR_TOP_K), SIMILARITY_FLOOR);
}

export function resolveNeighbourCreatedAt(
  match: RefreshNeighbour,
  createdAtById: Map<string, string>,
): string | undefined {
  return isTimestamp(match.created_at) ? match.created_at : createdAtById.get(match.id);
}

export function diffNeighbourhood(
  reading: RefreshRow,
  currentMatches: RefreshNeighbour[],
  list: { id: string; status: string; created_at?: string }[],
  judgedAt?: string,
): RefreshFlag[] {
  const readyIds = new Set(list.filter((row) => row.status === "ready").map((row) => row.id));
  const createdAtById = createdAtMap(list);
  const related = readyFlooredNeighbours(reading.id, currentMatches, readyIds);
  const cited = citedIds(reading.connections);
  const relatedIds = new Set(related.map((neighbour) => neighbour.id));
  const flags: RefreshFlag[] = [];

  if (staleCitationIds(reading, readyIds).length > 0) {
    flags.push("stale_connection");
  }

  const hasConnectionBelowFloor = storedConnections(reading.connections).some(
    (connection) => readyIds.has(connection.id) && !relatedIds.has(connection.id),
  );
  if (hasConnectionBelowFloor) flags.push("connection_below_floor");

  const judgedMs = isTimestamp(judgedAt) ? Date.parse(judgedAt) : undefined;
  const judgedNeighbourhood = new Set(reading.connections_neighbourhood_ids ?? []);
  const hasJudgedNeighbourhood = reading.connections_neighbourhood_ids !== undefined;
  const uncited = related.filter((neighbour) => !cited.has(neighbour.id));
  const isNewNeighbour = (neighbour: RefreshNeighbour): boolean => {
    const createdAt = resolveNeighbourCreatedAt(neighbour, createdAtById);
    // No resolvable timestamp → treat as new (conservative: one extra tier-2
    // call, never hides drift). Missing judgedAt is the same stance: we cannot
    // prove the neighbour was already visible.
    if (createdAt === undefined || judgedMs === undefined) return true;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) return true;
    return createdMs > judgedMs;
  };
  if (uncited.some(isNewNeighbour)) flags.push("new_neighbour");
  const uncitedEntered =
    uncited.some(
      (neighbour) =>
        !isNewNeighbour(neighbour) &&
        (!hasJudgedNeighbourhood || !judgedNeighbourhood.has(neighbour.id)),
    );
  // The other direction of the same ID-set comparison: a rejected candidate
  // lives only in connections_neighbourhood_ids. If it later drops out of the
  // ready floored set, uncited[] is empty for that id and connection_below_floor
  // ignores it, so compare judged IDs against relatedIds too.
  const uncitedLeft =
    hasJudgedNeighbourhood &&
    [...judgedNeighbourhood].some((id) => !cited.has(id) && !relatedIds.has(id));
  if (uncitedEntered || uncitedLeft) {
    flags.push("uncited_neighbour");
  }

  if (verdictInconsistent(reading.novelty_verdict, related.length > 0)) {
    flags.push("verdict_inconsistent");
  }

  return flags;
}

export function buildReportReading(
  reading: RefreshRow,
  currentMatches: RefreshNeighbour[],
  list: { id: string; status: string; created_at?: string }[],
  reasons: RefreshFlag[],
  judged: JudgedAt,
): RefreshReportReading {
  const createdAtById = createdAtMap(list);
  const readyIds = new Set(list.filter((row) => row.status === "ready").map((row) => row.id));
  const connections = storedConnections(reading.connections);
  const current_neighbours = readyFlooredNeighbours(reading.id, currentMatches, readyIds).map((neighbour) => {
    const created_at = resolveNeighbourCreatedAt(neighbour, createdAtById);
    const out: RefreshReportNeighbour = { id: neighbour.id, score: neighbour.score };
    if (neighbour.title !== undefined) out.title = neighbour.title;
    if (neighbour.tldr !== undefined) out.tldr = neighbour.tldr;
    if (neighbour.tags !== undefined) out.tags = neighbour.tags;
    if (created_at !== undefined) out.created_at = created_at;
    return out;
  });
  const row: RefreshReportReading = {
    id: reading.id,
    key_prefix: reading.key_prefix,
    url: reading.url,
    reasons,
    connections,
    current_neighbours,
  };
  if (reading.novelty_verdict !== undefined) row.novelty_verdict = reading.novelty_verdict;
  if (judged.judged_at !== undefined) row.judged_at = judged.judged_at;
  if (judged.judged_at_source !== undefined) row.judged_at_source = judged.judged_at_source;
  return row;
}

export function buildRefreshReport(opts: {
  generatedAt: string;
  tenant: string;
  scope?: RefreshReportScope;
  readings: RefreshReportReading[];
}): RefreshReport {
  return {
    version: 1,
    generated_at: opts.generatedAt,
    tenant: opts.tenant,
    floor: SIMILARITY_FLOOR,
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    readings: opts.readings,
  };
}

function metricChanged(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined && b === undefined) return false;
  if (a === undefined || b === undefined) return true;
  return Math.abs(a - b) >= SNAPSHOT_CHANGE_EPSILON;
}

function isTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function createdAtMap(list: { id: string; created_at?: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of list) {
    if (isTimestamp(row.created_at)) out.set(row.id, row.created_at);
  }
  return out;
}

function storedConnections(raw: unknown): RefreshConnection[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is RefreshConnection =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { reason?: unknown }).reason === "string",
  );
}

function citedIds(raw: unknown): Set<string> {
  return new Set(storedConnections(raw).map((c) => c.id));
}

function readyFlooredNeighbours(
  id: string,
  matches: RefreshNeighbour[],
  readyIds: ReadonlySet<string>,
): RefreshNeighbour[] {
  return flooredNeighbours(id, matches).filter((neighbour) => readyIds.has(neighbour.id));
}

function staleCitationIds(reading: RefreshRow, readyIds: Set<string>): string[] {
  const connectionIds = storedConnections(reading.connections).map((c) => c.id);
  const tensionIds = Array.isArray(reading.tensions)
    ? reading.tensions
        .filter((t): t is { id: string } => typeof t === "object" && t !== null && typeof t.id === "string")
        .map((t) => t.id)
    : [];
  return [...new Set([...connectionIds, ...tensionIds])].filter((id) => !readyIds.has(id));
}

function verdictInconsistent(verdict: string | undefined, hasFlooredNeighbour: boolean): boolean {
  if (verdict === "novel") return hasFlooredNeighbour;
  if (verdict === "familiar" || verdict === "duplicate") return !hasFlooredNeighbour;
  return false;
}
