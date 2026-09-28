// Pure pair policy for tension refresh, shared by the operator pass
// (`ops corpus refresh-tensions`, scripts/corpus-lib/refresh-tensions.ts) and
// the hosted nightly refresh (src/tension-judge.ts).
//
// The universe is (target, neighbour) pairs already floored by similarity;
// similarity alone is necessary but not sufficient, so pairs are pre-filtered
// on cheap overlap evidence that both stored readings already carry (shared
// people or orgs, keyword overlap, an existing citation) before any paid
// pairwise call.
//
// A judged pair is written to BOTH readings in one transaction: each side
// stores its own directional `kind` plus one neutral pair-level `reason`, and a
// `tensions_judged` record so a "none" verdict is remembered. Nothing here
// touches status, vectors, title, tldr, tags, keywords, entities,
// summary_markdown, connections, or `updated_at`.

import {
  ManifestSchema,
  TensionJudgedSchema,
  TensionSchema,
  type Tension,
  type TensionJudged,
  type TensionKind,
} from "../../schemas/manifest";
import type { TensionJudgement } from "../../schemas/reading-summary";
import type { TensionJudgementInput } from "./index";

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

/**
 * Whether the nightly refresh should pay to judge this pair: two distinct
 * readings that clear the overlap pre-filter, are not already judged, and
 * both carry the summary text the judge reads. The operator pass reaches the
 * same answer through `tensionCandidates`, `isPairJudged` and a plan-time
 * skip of a reading with no summary.
 */
export function tensionPairEligible(a: RawManifest, b: RawManifest): boolean {
  if (idOf(a) === idOf(b) || !hasSummaryText(a) || !hasSummaryText(b)) return false;
  return passesOverlapFilter(overlapEvidence(a, b)) && !isPairJudged(a, b);
}

function hasSummaryText(manifest: RawManifest): boolean {
  const summary = typeof manifest.summary_markdown === "string" ? manifest.summary_markdown
    : typeof manifest.tldr === "string" ? manifest.tldr : "";
  return summary.trim().length > 0;
}

function idOf(manifest: RawManifest): string {
  return typeof manifest.id === "string" ? manifest.id : "";
}

export function entryId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

export function tensionFor(manifest: RawManifest, partnerId: string): Tension | null {
  if (!Array.isArray(manifest.tensions)) return null;
  for (const raw of manifest.tensions) {
    const parsed = TensionSchema.safeParse(raw);
    if (parsed.success && parsed.data.id === partnerId) return parsed.data;
  }
  return null;
}

export function judgedRecord(manifest: RawManifest, partnerId: string): TensionJudged | null {
  if (!Array.isArray(manifest.tensions_judged)) return null;
  for (const raw of manifest.tensions_judged) {
    const parsed = TensionJudgedSchema.safeParse(raw);
    if (parsed.success && parsed.data.id === partnerId) return parsed.data;
  }
  return null;
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

export function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}
