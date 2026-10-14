// Operator planning for `corpus refresh-tensions`: report candidates and plan
// output.
//
// Tier 3 of the nightly corpus refresh: pairwise, directional, and separate
// from the connections judgement. The pair policy it shares with the hosted
// weekly refresh (overlap pre-filter, judged-pair memory, directional sides,
// the merge, and the free one-sided repairs) lives in
// src/modules/tension-judgement/refresh.ts and is re-exported here. Like
// refresh-connections, nothing here touches status, vectors, title, tldr,
// tags, keywords, entities, summary_markdown, connections, or `updated_at`.

import {
  orderPair,
  overlapEvidence,
  passesOverlapFilter,
  type OverlapEvidence,
  type RawManifest,
  type TensionPair,
} from "../../src/modules/tension-judgement/refresh";
import type { RefreshConnectionsReport } from "./refresh-connections";

export * from "../../src/modules/tension-judgement/refresh";

export interface TensionCandidate extends TensionPair {
  evidence: OverlapEvidence;
  source: "report" | "pair";
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

function listOrNone(values: string[]): string {
  return values.length === 0 ? "(none)" : `[${values.join(",")}]`;
}
