// Pure planning + merge policy for `corpus refresh-tensions`.
//
// Tier 3 of the nightly corpus refresh: pairwise, directional, and separate
// from the connections judgement. The universe is every (target, neighbour)
// pair the tier-1 report already floored by similarity; similarity alone is
// necessary but not sufficient, so pairs are pre-filtered on cheap overlap
// evidence that both stored manifests already carry (shared people or orgs,
// keyword overlap, an existing citation) before any paid pairwise call.
//
// A judged pair is written to BOTH manifests: each side stores its own
// directional `kind` plus one neutral pair-level `reason`, and a
// `tensions_judged` record so a "none" verdict is remembered. Writes are not
// atomic across the two objects; a crash between them leaves a one-sided
// pair, which `findOneSided` repairs without a paid call when the other side
// has not changed since the judgement. Like refresh-connections, nothing here
// touches status, vectors, title, tldr, tags, keywords, entities,
// summary_markdown, connections, or `updated_at`.

import {
  ManifestSchema,
  TensionJudgedSchema,
  TensionSchema,
  type Tension,
  type TensionJudged,
  type TensionKind,
} from "../../src/schemas/manifest";
import type { TensionJudgement } from "../../src/schemas/reading-summary";
import type { TensionJudgementInput } from "../../src/modules/tension-judgement";
import type { RefreshConnectionsReport } from "./refresh-connections";

// Candidate pre-filter thresholds. Starting values from plan 018, chosen so
// the first production run judges only pairs that share a named entity, a
// fifth of their keyword vocabulary, or an explicit citation; slice 4
// (issue #174) recalibrates them from that run's flag rate, cost, and verdict
// churn. Tags are deliberately not a filter: they are 1-6 broad buckets and
// match almost everything above the similarity floor.
export const TENSION_KEYWORD_JACCARD_MIN = 0.2;

export type RawManifest = Record<string, unknown>;

export type CitationDirection = "a->b" | "b->a";

export interface OverlapEvidence {
  /** Best cosine score the report recorded for the pair, when it came from the report. */
  score?: number;
  people: string[];
  orgs: string[];
  keywords: string[];
  keywordJaccard: number;
  cited: CitationDirection[];
}

export interface TensionPair {
  /** Canonical `${a}|${b}` with a < b. */
  key: string;
  a: string;
  b: string;
}

export interface TensionCandidate extends TensionPair {
  evidence: OverlapEvidence;
  source: "report" | "pair";
}

export type RepairAction =
  | { kind: "mirror"; from: string; to: string; entry: Tension }
  | { kind: "mirror-judged"; from: string; to: string; judged_at: string }
  | { kind: "drop"; on: string; partner: string };

export function orderPair(x: string, y: string): TensionPair {
  const [a, b] = x < y ? [x, y] : [y, x];
  return { key: `${a}|${b}`, a: a!, b: b! };
}

export function pairKey(x: string, y: string): string {
  return orderPair(x, y).key;
}

export function overlapEvidence(
  a: RawManifest,
  b: RawManifest,
  score?: number,
): OverlapEvidence {
  const aKeywords = normalizedSet(a.keywords);
  const bKeywords = normalizedSet(b.keywords);
  const keywords = intersect(aKeywords, bKeywords);
  const union = new Set([...aKeywords, ...bKeywords]).size;
  const cited: CitationDirection[] = [];
  if (cites(a, idOf(b))) cited.push("a->b");
  if (cites(b, idOf(a))) cited.push("b->a");
  return {
    ...(score === undefined ? {} : { score }),
    people: intersect(normalizedSet(a.people), normalizedSet(b.people)),
    orgs: intersect(normalizedSet(a.orgs), normalizedSet(b.orgs)),
    keywords,
    keywordJaccard: union === 0 ? 0 : keywords.length / union,
    cited,
  };
}

export function passesOverlapFilter(evidence: OverlapEvidence): boolean {
  return (
    evidence.people.length > 0 ||
    evidence.orgs.length > 0 ||
    evidence.keywordJaccard >= TENSION_KEYWORD_JACCARD_MIN ||
    evidence.cited.length > 0
  );
}

export function formatOverlapEvidence(evidence: OverlapEvidence): string {
  const parts = [
    `score=${evidence.score === undefined ? "n/a" : evidence.score.toFixed(3)}`,
    `people=${listOrNone(evidence.people)}`,
    `orgs=${listOrNone(evidence.orgs)}`,
    `keywords=${evidence.keywords.length}(${evidence.keywordJaccard.toFixed(2)})`,
    `cited=${listOrNone(evidence.cited)}`,
  ];
  return parts.join(" ");
}

/**
 * Every deduplicated (target, neighbour) pair from the report whose two sides
 * are live ready manifests and pass the overlap pre-filter. The report lists
 * each neighbour on the target's side only, so A->B and B->A collapse onto
 * one canonical pair carrying the best score seen.
 */
export function tensionCandidates(
  report: Pick<RefreshConnectionsReport, "readings">,
  manifestsById: ReadonlyMap<string, RawManifest>,
  liveReadyIds: ReadonlySet<string>,
): TensionCandidate[] {
  const scores = new Map<string, { pair: TensionPair; score: number }>();
  for (const reading of report.readings) {
    for (const neighbour of reading.current_neighbours) {
      if (neighbour.id === reading.id) continue;
      if (!liveReadyIds.has(reading.id) || !liveReadyIds.has(neighbour.id)) continue;
      if (!manifestsById.has(reading.id) || !manifestsById.has(neighbour.id)) continue;
      const pair = orderPair(reading.id, neighbour.id);
      const prior = scores.get(pair.key);
      if (!prior || neighbour.score > prior.score) {
        scores.set(pair.key, { pair, score: neighbour.score });
      }
    }
  }
  const out: TensionCandidate[] = [];
  for (const { pair, score } of scores.values()) {
    const evidence = overlapEvidence(
      manifestsById.get(pair.a)!,
      manifestsById.get(pair.b)!,
      score,
    );
    if (!passesOverlapFilter(evidence)) continue;
    out.push({ ...pair, evidence, source: "report" });
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * A pair is already judged when BOTH manifests remember judging the other and
 * neither has been rewritten by ingest since (refresh writes leave
 * `updated_at` alone, so a newer `updated_at` means a reprocess replaced the
 * summary the judgement was made from).
 */
export function isPairJudged(a: RawManifest, b: RawManifest): boolean {
  const ja = judgedRecord(a, idOf(b));
  const jb = judgedRecord(b, idOf(a));
  if (!ja || !jb) return false;
  const floor = Math.max(timestamp(a.updated_at), timestamp(b.updated_at));
  if (!Number.isFinite(floor)) return false;
  return Date.parse(ja.judged_at) >= floor && Date.parse(jb.judged_at) >= floor;
}

export function inverseKind(kind: TensionKind): TensionKind {
  switch (kind) {
    case "contradicts":
      return "contradicts";
    case "supersedes":
      return "superseded_by";
    case "superseded_by":
      return "supersedes";
    case "qualifies":
      return "qualified_by";
    case "qualified_by":
      return "qualifies";
  }
}

/**
 * Turn the judge's single pair verdict into each side's directional entry.
 * `null` on a side means "no tension: remove any prior entry for the partner".
 */
export function deriveTensionSides(
  judgement: TensionJudgement,
  ids: { a: string; b: string },
  computedAt: string,
): { a: Tension | null; b: Tension | null } {
  if (judgement.verdict === "none") return { a: null, b: null };
  const reason = judgement.reason.trim();
  const entry = (id: string, kind: TensionKind): Tension => ({
    id,
    kind,
    reason,
    computed_at: computedAt,
  });
  if (judgement.verdict === "contradicts") {
    return { a: entry(ids.b, "contradicts"), b: entry(ids.a, "contradicts") };
  }
  const forward: TensionKind = judgement.verdict;
  const backward = inverseKind(forward);
  return judgement.side === "a"
    ? { a: entry(ids.b, forward), b: entry(ids.a, backward) }
    : { a: entry(ids.b, backward), b: entry(ids.a, forward) };
}

export type TensionMergeResult =
  | { ok: true; manifest: RawManifest }
  | { ok: false; error: string };

/**
 * Replace (or, with `null`, remove) the tension entry for one partner and,
 * when `judgedAt` is given, upsert the judged-pair record. Every other key,
 * every other partner's entry, and `updated_at` are preserved verbatim;
 * `tensions` is only introduced when it has something to hold.
 */
export function mergeTensionSide(
  rawManifest: unknown,
  partnerId: string,
  entry: Tension | null,
  judgedAt?: string,
): TensionMergeResult {
  if (rawManifest === null || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    return { ok: false, error: "manifest is not an object" };
  }
  const raw = rawManifest as RawManifest;
  if (entry !== null && entry.id !== partnerId) {
    return { ok: false, error: `entry names ${entry.id}, expected ${partnerId}` };
  }

  const priorTensions = Array.isArray(raw.tensions) ? [...(raw.tensions as unknown[])] : [];
  const tensions: unknown[] = [];
  let placed = false;
  for (const prior of priorTensions) {
    if (entryId(prior) === partnerId) {
      if (entry !== null && !placed) {
        tensions.push(entry);
        placed = true;
      }
      continue;
    }
    tensions.push(prior);
  }
  if (entry !== null && !placed) tensions.push(entry);

  const candidate: RawManifest = { ...raw };
  if (tensions.length > 0 || "tensions" in raw) candidate.tensions = tensions;
  if (judgedAt !== undefined) {
    const priorJudged = Array.isArray(raw.tensions_judged)
      ? [...(raw.tensions_judged as unknown[])]
      : [];
    const judged: unknown[] = [];
    let placedJudged = false;
    const record: TensionJudged = { id: partnerId, judged_at: judgedAt };
    for (const prior of priorJudged) {
      if (entryId(prior) === partnerId) {
        if (!placedJudged) {
          judged.push(record);
          placedJudged = true;
        }
        continue;
      }
      judged.push(prior);
    }
    if (!placedJudged) judged.push(record);
    candidate.tensions_judged = judged;
  }

  const parsed = ManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "failed ManifestSchema",
    };
  }
  return { ok: true, manifest: candidate };
}

/**
 * Pairs whose two manifests disagree about a judgement, and the write that
 * reconciles them without a provider call. Pairs in `excludePairKeys` are
 * about to be judged afresh and are left to that write. A partner that is
 * missing or not ready is left dangling on purpose: tier 1 flags it as
 * `stale_connection`, exactly as it does for connections.
 */
export function findOneSided(
  manifestsById: ReadonlyMap<string, RawManifest>,
  readyIds: ReadonlySet<string>,
  excludePairKeys: ReadonlySet<string> = new Set(),
): RepairAction[] {
  const keys = new Set<string>();
  for (const [id, manifest] of manifestsById) {
    for (const partner of partnerIds(manifest)) {
      if (partner !== id) keys.add(pairKey(id, partner));
    }
  }
  const actions: RepairAction[] = [];
  for (const key of [...keys].sort()) {
    if (excludePairKeys.has(key)) continue;
    const [x, y] = key.split("|") as [string, string];
    const mx = manifestsById.get(x);
    const my = manifestsById.get(y);
    if (!mx || !my || !readyIds.has(x) || !readyIds.has(y)) continue;
    const tx = tensionFor(mx, y);
    const ty = tensionFor(my, x);

    if (tx || ty) {
      if (tx && ty && ty.kind === inverseKind(tx.kind) && ty.computed_at === tx.computed_at) {
        continue;
      }
      const fromX = !ty || (tx !== null && timestamp(tx.computed_at) >= timestamp(ty.computed_at));
      const source = fromX ? tx! : ty!;
      const from = fromX ? x : y;
      const to = fromX ? y : x;
      const target = fromX ? my : mx;
      if (timestamp(target.updated_at) <= timestamp(source.computed_at)) {
        actions.push({
          kind: "mirror",
          from,
          to,
          entry: {
            id: from,
            kind: inverseKind(source.kind),
            reason: source.reason,
            computed_at: source.computed_at,
          },
        });
      } else {
        actions.push({ kind: "drop", on: from, partner: to });
      }
      continue;
    }

    const jx = judgedRecord(mx, y);
    const jy = judgedRecord(my, x);
    if (!jx && !jy) continue;
    const fromX = !jy || (jx !== null && timestamp(jx.judged_at) > timestamp(jy.judged_at));
    const source = fromX ? jx! : jy!;
    const target = fromX ? my : mx;
    const targetRecord = fromX ? jy : jx;
    if (targetRecord && timestamp(targetRecord.judged_at) >= timestamp(source.judged_at)) continue;
    if (timestamp(target.updated_at) <= timestamp(source.judged_at)) {
      actions.push({
        kind: "mirror-judged",
        from: fromX ? x : y,
        to: fromX ? y : x,
        judged_at: source.judged_at,
      });
    }
  }
  return actions;
}

export function buildTensionJudgementInput(
  a: RawManifest,
  b: RawManifest,
): TensionJudgementInput {
  return { a: tensionReading(a), b: tensionReading(b) };
}

function tensionReading(manifest: RawManifest): TensionJudgementInput["a"] {
  const id = idOf(manifest);
  const url = typeof manifest.url === "string" ? manifest.url : "";
  const tldr = typeof manifest.tldr === "string" ? manifest.tldr : "";
  const summary =
    typeof manifest.summary_markdown === "string" ? manifest.summary_markdown : tldr;
  if (summary.trim().length === 0) {
    throw new Error(`ready reading ${id} has no stored summary text`);
  }
  return {
    id,
    url,
    title: typeof manifest.title === "string" ? manifest.title : url,
    tldr,
    summary_markdown: summary,
    ...(typeof manifest.created_at === "string" ? { created_at: manifest.created_at } : {}),
  };
}

function idOf(manifest: RawManifest): string {
  return typeof manifest.id === "string" ? manifest.id : "";
}

function entryId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function tensionFor(manifest: RawManifest, partnerId: string): Tension | null {
  if (!Array.isArray(manifest.tensions)) return null;
  for (const raw of manifest.tensions) {
    const parsed = TensionSchema.safeParse(raw);
    if (parsed.success && parsed.data.id === partnerId) return parsed.data;
  }
  return null;
}

function judgedRecord(manifest: RawManifest, partnerId: string): TensionJudged | null {
  if (!Array.isArray(manifest.tensions_judged)) return null;
  for (const raw of manifest.tensions_judged) {
    const parsed = TensionJudgedSchema.safeParse(raw);
    if (parsed.success && parsed.data.id === partnerId) return parsed.data;
  }
  return null;
}

function partnerIds(manifest: RawManifest): string[] {
  const out: string[] = [];
  for (const list of [manifest.tensions, manifest.tensions_judged]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const id = entryId(raw);
      if (id) out.push(id);
    }
  }
  return out;
}

function cites(manifest: RawManifest, partnerId: string): boolean {
  if (!Array.isArray(manifest.connections)) return false;
  return manifest.connections.some((c) => entryId(c) === partnerId);
}

function normalizedSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length > 0) out.add(normalized);
  }
  return out;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((value) => b.has(value)).sort();
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function listOrNone(values: string[]): string {
  return values.length === 0 ? "(none)" : `[${values.join(",")}]`;
}
