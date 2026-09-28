// Operator planning for `corpus refresh-tensions`: report candidates, plan
// output, and the free one-sided repairs.
//
// Tier 3 of the nightly corpus refresh: pairwise, directional, and separate
// from the connections judgement. The pair policy it shares with the hosted
// nightly refresh (overlap pre-filter, judged-pair memory, directional sides,
// the merge) lives in src/modules/tension-judgement/refresh.ts and is
// re-exported here. A one-sided pair (left by a partner's deletion, or by a
// write from before both sides shared a transaction) is found by
// `findOneSided`, which repairs it without a paid call when the other side has
// not changed since the judgement. Like refresh-connections, nothing here
// touches status, vectors, title, tldr, tags, keywords, entities,
// summary_markdown, connections, or `updated_at`.

import { ManifestSchema, type Tension } from "../../src/schemas/manifest";
import {
  entryId,
  inverseKind,
  judgedRecord,
  orderPair,
  overlapEvidence,
  pairKey,
  passesOverlapFilter,
  tensionFor,
  timestamp,
  type OverlapEvidence,
  type RawManifest,
  type TensionMergeResult,
  type TensionPair,
} from "../../src/modules/tension-judgement/refresh";
import type { RefreshConnectionsReport } from "./refresh-connections";

export * from "../../src/modules/tension-judgement/refresh";

export interface TensionCandidate extends TensionPair {
  evidence: OverlapEvidence;
  source: "report" | "pair";
}

export type RepairAction =
  | { kind: "mirror"; from: string; to: string; entry: Tension }
  | { kind: "mirror-judged"; from: string; to: string; judged_at: string }
  | {
      kind: "drop";
      on: string;
      partner: string;
      /** When set, the partner's newer "none" verdict is recorded on `on` as well. */
      judged_at?: string;
      /** The partner is deleted or not ready: purge the judged record too. */
      dangling?: boolean;
    };

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
 * Pairs whose two manifests disagree about a judgement, and the write that
 * reconciles them without a provider call. `readyIds` is every ready reading
 * in the list index, not only the loaded ones: a partner that is absent from
 * it was deleted in practice (a ready reading does not normally regress, and
 * one that returns is rebuilt without tensions and re-judged anyway), so
 * its entries are purged from the holder — otherwise tier 1 would flag the
 * holder `stale_connection` and refresh-connections would re-judge it every
 * night. A ready partner that simply was not loaded cannot be reconciled and
 * is skipped. The caller drops repairs for pairs it is about to judge afresh.
 */
export function findOneSided(
  manifestsById: ReadonlyMap<string, RawManifest>,
  readyIds: ReadonlySet<string>,
): RepairAction[] {
  const keys = new Set<string>();
  for (const [id, manifest] of manifestsById) {
    for (const partner of partnerIds(manifest)) {
      if (partner !== id) keys.add(pairKey(id, partner));
    }
  }
  const actions: RepairAction[] = [];
  for (const key of [...keys].sort()) {
    const [x, y] = key.split("|") as [string, string];
    const mx = manifestsById.get(x);
    const my = manifestsById.get(y);
    for (const [holder, partner, held] of [[x, y, mx], [y, x, my]] as const) {
      if (held && readyIds.has(holder) && !readyIds.has(partner)) {
        actions.push({ kind: "drop", on: holder, partner, dangling: true });
      }
    }
    if (!mx || !my || !readyIds.has(x) || !readyIds.has(y)) continue;
    const tx = tensionFor(mx, y);
    const ty = tensionFor(my, x);

    if (tx || ty) {
      if (tx && ty && ty.kind === inverseKind(tx.kind) && ty.computed_at === tx.computed_at) {
        continue;
      }
      // Exactly one side holds an entry. If the empty side remembers a newer
      // judgement, that judgement was "none" and its second write was lost:
      // the surviving entry is the stale half, not the missing one.
      if (!tx || !ty) {
        const entrySide = tx ? x : y;
        const emptySide = tx ? y : x;
        const entry = (tx ?? ty)!;
        const emptyJudged = judgedRecord(tx ? my : mx, entrySide);
        if (emptyJudged && timestamp(emptyJudged.judged_at) > timestamp(entry.computed_at)) {
          actions.push({
            kind: "drop",
            on: entrySide,
            partner: emptySide,
            judged_at: emptyJudged.judged_at,
          });
          continue;
        }
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
        // The judgement predates the target's rewrite, so it is stale on both
        // sides; clear whatever survives so the pair is re-judged clean.
        actions.push({ kind: "drop", on: from, partner: to });
        if (tx && ty) actions.push({ kind: "drop", on: to, partner: from });
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

/**
 * Remove every trace of a partner — its tension entry and its judged record —
 * for a partner that no longer exists. Other entries and every other key are
 * preserved verbatim.
 */
export function purgeTensionPartner(
  rawManifest: unknown,
  partnerId: string,
): TensionMergeResult {
  if (rawManifest === null || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    return { ok: false, error: "manifest is not an object" };
  }
  const raw = rawManifest as RawManifest;
  const candidate: RawManifest = { ...raw };
  for (const field of ["tensions", "tensions_judged"] as const) {
    if (!Array.isArray(raw[field])) continue;
    candidate[field] = (raw[field] as unknown[]).filter((item) => entryId(item) !== partnerId);
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

function listOrNone(values: string[]): string {
  return values.length === 0 ? "(none)" : `[${values.join(",")}]`;
}
