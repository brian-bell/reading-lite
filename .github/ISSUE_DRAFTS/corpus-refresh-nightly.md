# Nightly corpus refresh: stale connections, novelty verdicts, and conflict detection

## Problem

Connections and `novelty_verdict` are computed once at ingest time (`processReading` → Vectorize top-K → summarizer) and then frozen on the manifest. As the corpus grows, this creates several kinds of staleness:

| Field | How it goes stale | Cheap to refresh? |
|-------|-------------------|-------------------|
| `similarity` snapshot | Neighbourhood scores drift as corpus grows | **Yes** — `ops corpus backfill-similarity` already exists |
| `connections` / `novelty_verdict` | Judged against a neighbourhood that no longer exists; may cite dropped readings or miss readings added since | Needs LLM re-judgement |
| *(new)* conflicts/tensions | Cannot exist at ingest if the contradicting reading was not in the library yet | Needs LLM + pairwise reasoning |

The codebase already acknowledges this:

- `similarity-store.ts` documents that `novelty_verdict` decays toward constant `"familiar"` and that `similarity.computed_at` exists to make staleness detectable.
- `corpus-sweep` flags keepers whose `connections` cite dropped readings or whose `similarity` snapshot predates a removed duplicate.
- Product scope assumes batch/async latency ("connections may take a few hours").

What is missing is an **automated refresh loop** that connects these pieces — plus a new dimension (conflicts/contradictions) that similarity alone cannot detect.

## Proposed architecture: two tiers

### Tier 1 — nightly vector sweep (cheap, run on all `ready` readings)

For each reading:

1. Re-query Vectorize (same approach as `corpus backfill-similarity` — query by vector id, no embedding calls).
2. Update `similarity` snapshot if scores changed materially.
3. Diff the new floored neighbourhood (`SIMILARITY_FLOOR` = 0.55) against stored `connections` and flag readings where:
   - A cited connection no longer exists.
   - A new neighbour cleared the floor that was not present at `computed_at`.
   - `novelty_verdict` is inconsistent with the new neighbourhood (e.g. marked `novel` but now has a 0.72 neighbour).

**No LLM.** Produces a work queue for tier 2.

### Tier 2 — selective relationship refresh (expensive, flagged readings only)

For readings tier 1 flagged — plus reverse-edge triggers (new readings added in the last 24h should cause their neighbours to be re-evaluated):

1. Re-run the summarizer's relationship judgement with the *current* neighbourhood context (similar to frozen-context reconstruction in `compare-summary-effort`).
2. Update `connections`, `novelty_verdict`, and optionally a new `tensions`/`conflicts` field.
3. Write manifest + list index with the same lockstep discipline as terminal commits (respect owner gate; skip readings with `active_attempt`).

Route through provider batch API where latency is acceptable. Nightly batch refresh is honest product behavior, not a compromise.

## Conflicts are a sibling feature, not a connection subtype

- **Connections** answer: "what else should I read?" (relatedness).
- **Conflicts/tensions** answer: "what do I already believe that this challenges?" (opposing claims).

Embedding similarity is necessary but not sufficient — high topical overlap can mean agreement or contradiction. Evaluate tension candidates from tier 1 flagged pairs that also share entity/topic overlap (people, orgs, keywords) as a cheap pre-filter before LLM pairwise comparison.

Proposed schema sketch:

```typescript
interface Tension {
  id: string;
  kind: "contradicts" | "supersedes" | "qualifies";
  reason: string;
  computed_at: string;
}
```

Store on the manifest for v1 (like `connections`). A separate edge index (`index/edges/` or D1) can come later if graph queries are needed.

## Runtime shape: cron → enqueue → consume

Prefer **not** doing all work inline in a single cron invocation (Workers CPU/time limits; corpus will outgrow one shot):

```
[cron trigger, nightly]
  → corpus-refresh worker: tier-1 sweep, write refresh queue
  → RELATIONSHIP_REFRESH_JOBS queue (new)
  → consumer: tier-2 LLM refresh per reading (or batch-submit)
```

Keep the hot HTTP worker untouched. Mirror existing `READING_JOBS` patterns (queue + DLQ + attempt ownership).

**Ops CLI first:** `npm run ops -- corpus refresh-neighbours` (tier 1) and a tier-2 command, dry-run by default — same pattern as `backfill-similarity` and `sweep`. Cron is just scheduled ops.

## Preserve ingest-time connections

Do not move connections entirely to nightly. Ingest-time connections still matter for immediate digest/detail value. Nightly refresh handles the **reverse edge** problem: when a new reading arrives, older related readings should gain it as a connection. Today they never do.

## Open design questions

1. **Overwrite vs merge** — replace `connections` wholesale, or merge (add new, drop stale-cited, keep stable)? Suggest merge with `computed_at` on the array or per-connection.
2. **User-visible staleness** — show "connections as of {date}" in SPA? (`similarity.computed_at` sets precedent.)
3. **Reprocess interaction** — manual reprocess should win over nightly; skip readings with `active_attempt` or `last_attempt` newer than refresh cursor.
4. **Conflict directionality** — store on both manifests for detail-page reads from either side?
5. **Cost ceiling** — per-tenant nightly LLM budget cap (required at multi-tenant scale).

## Suggested sequencing

1. **Tier 1 ops command** — `corpus refresh-neighbours`: extend `backfill-similarity` with diff + flag report. Zero LLM cost; immediately shows how stale the corpus is.
2. **Tier 2 ops command** — refresh `connections`/`novelty_verdict` for flagged readings only; dry-run first; use batch API.
3. **Tensions schema + prompt** — pairwise LLM evaluation on flagged neighbour pairs.
4. **Cron worker + queue** — wire scheduled execution; expose in SPA.

## Core principle

**Similarity is a measurement, connections are a judgement, conflicts are a different judgement.** Refresh measurements cheaply; re-run judgements selectively — do not re-summarize everything.

## Related code / docs

- `src/process-reading.ts` — ingest-time `query_similar` → summarizer
- `src/modules/stores/similarity-store.ts` — `SIMILAR_TOP_K`, `SIMILARITY_FLOOR`, `SimilaritySnapshot`
- `scripts/corpus-lib/backfill-similarity.ts` — cheap snapshot refresh (no LLM)
- `scripts/corpus-lib/sweep.ts` — `invalidatedByDrop` / stale connection detection
- `src/modules/summarizer/instructions.ts` — librarian policy for connections + novelty
- `docs/product/reading-lite-scope.md` — batch mode, connections as differentiator
