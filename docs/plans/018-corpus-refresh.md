# Plan 018 — Nightly corpus refresh: stale connections, novelty verdicts, and conflict detection

Status: proposed
Scope: `scripts/corpus-lib`, `scripts/ops-lib/commands`, `src/modules/summarizer`,
`src/schemas`, `src/index.ts`, `wrangler.toml`, `web/`

## 1. Problem

`connections` and `novelty_verdict` are computed once, inside `processReading`,
against the Vectorize neighbourhood that existed at summarize time, and then
frozen on the manifest. As the corpus grows they go stale in three distinct
ways:

| Field | How it goes stale | Refresh cost |
|-------|-------------------|--------------|
| `similarity` snapshot | Neighbourhood scores drift as the corpus grows | Cheap — `ops corpus backfill-similarity --rescore` already re-measures by querying Vectorize with the stored vector (no embedding calls) |
| `connections` / `novelty_verdict` | Judged against a neighbourhood that no longer exists; may cite dropped readings, and never gains readings added later | Needs an LLM re-judgement |
| conflicts / tensions (new) | Cannot exist at ingest if the contradicting reading was not in the library yet | Needs LLM pairwise reasoning |

The codebase already anticipates this:

- `src/modules/stores/similarity-store.ts` documents that `novelty_verdict`
  decays toward a constant `"familiar"` and that `similarity.computed_at`
  exists precisely to make staleness detectable.
- `scripts/corpus-lib/sweep.ts` (`invalidatedByDrop`) flags keepers whose
  `connections` cite a dropped reading or whose `similarity` snapshot predates
  a removed duplicate.
- `docs/product/reading-lite-scope.md` commits to batch/async latency
  ("connections may take a few hours") as product behavior, not a compromise.

What is missing is the automated loop that connects these pieces, plus the new
tensions dimension.

### Core principle

**Similarity is a measurement; connections are a judgement; conflicts are a
different judgement.** Measurements are refreshed cheaply and universally.
Judgements are re-run selectively, only where the measurement says the ground
has shifted. Nothing in this plan re-summarizes a reading: title, tldr, tags,
keywords, entities, and `summary_markdown` are never rewritten by refresh —
the same one-field discipline `backfill-similarity` established
(`withSimilarity` writes exactly one field and keeps the manifest
byte-identical otherwise, `updated_at` included).

## 2. Architecture: two tiers, ops-CLI first, cron last

```
Tier 1 (cheap, all ready readings, no LLM)
  ops corpus refresh-neighbours
    → re-query Vectorize by stored vector id (no embedding calls)
    → update similarity snapshots that changed materially
    → diff floored neighbourhood vs stored connections/verdict
    → emit refresh-report.json (the tier-2 work queue)

Tier 2 (expensive, flagged readings only)
  ops corpus refresh-connections --report refresh-report.json
    → judgeRelationships(): narrow LLM call, connections + verdict only
    → merge, stamp connections_computed_at, sync list index

Tier 3 (pairwise, flagged pairs only)
  ops corpus refresh-tensions --report refresh-report.json
    → entity/keyword-overlap pre-filter → pairwise judgeTension()
    → write tensions to both manifests

Tier 4 (automation)
  [cron trigger, nightly] → scheduled() → shard messages
    → RELATIONSHIP_REFRESH_JOBS queue → consumer runs tiers 1-2 per shard
```

Each tier ships as an independently useful, plan-first ops command before any
cron wiring, matching the `backfill-similarity` / `sweep` pattern: dry-run by
default, `--execute` to write, `--tenant` required, exit 0/2/1 semantics, a
row in `scripts/ops-lib/registry.ts`, and coverage enforced by
`test/unit/scripts/ops-registry-coverage.test.ts`.

## 3. Design decisions (resolving the open questions)

### 3.1 The judgement-freshness timestamp gap

Tier 1 must answer "was this neighbour already visible when connections were
last judged?" — but no stored field records judgement time:

- `SimilaritySnapshot` stores only `count`/`max`/`mean`/`computed_at` — no
  neighbour identities.
- `similarity.computed_at` is **not** the judgement time: `corpus
  backfill-similarity` rewrites it without re-running the summarizer, so on a
  backfilled/rescored reading it postdates the actual connections judgement.

Decision: introduce an optional manifest field `connections_computed_at`
(ISO datetime), stamped by every writer that actually re-judges relationships
(ingest `readyManifest`, offline batch `write-phase`, and the new tier-2
refresh). For legacy manifests without it, tier 1 falls back to the last
successful attempt's `finished_at` (from `last_attempt`), then `updated_at`.
The fallback can only be too *late*, which makes `new_neighbour` flagging
conservative (false negatives, never false positives) — and the
`stale_connection` and `verdict_inconsistent` rules don't depend on it at all.

Per-connection timestamps were considered and rejected for v1: `Connection`
is `.strict()` and doubles as the LLM tool/output schema
(`src/schemas/reading-summary.ts`, `READING_SUMMARY_JSON_SCHEMA`), so widening
it ripples into both provider request builders and the Anthropic prompt-cache
prefix. One manifest-level stamp is enough to drive the diff.

### 3.2 Overwrite vs merge for connections

Decision: **merge, with the LLM returning the full updated set and the tool
enforcing an id whitelist.** Concretely, `judgeRelationships` receives the
existing connections as prior context plus the current floored neighbourhood,
and returns the complete new `connections` array. The command then:

1. Drops any returned id not in (current floored neighbourhood ∪ previously
   stored connections ∪ current ready list-index ids) — hallucination guard.
2. Drops any id that no longer resolves in `index/list.json` as `ready` —
   the stale-citation cleanup `sweep.invalidatedByDrop` detects today but
   cannot fix.
3. Stamps `connections_computed_at` and replaces `novelty_verdict`.

This keeps the contract deterministic (the stored array is always exactly one
model output filtered by a pure function — testable without an LLM) while
behaving like a merge in practice, because the prior connections are in the
prompt and the model is instructed to keep still-valid ones.

### 3.3 User-visible staleness

Yes. The SPA detail view shows "connections as of {date}" from
`connections_computed_at` (fall back to nothing when absent), matching the
precedent `similarity.computed_at` set. Ships with tier 2, since that is what
makes the date change.

### 3.4 Reprocess wins over refresh

Both offline commands and the future queue consumer skip a reading when:

- `active_attempt.status === "running"` on a just-re-read manifest (a
  reprocess is in flight; its terminal commit will re-judge with fresh
  context anyway), or
- the manifest's last successful attempt `finished_at` is newer than the
  refresh run's scan timestamp (the reading was re-judged mid-run), or
- the purge witnesses are gone (`missingManifestStillLive` logic: no by-id
  pointer and no list row → never recreate anything).

The worker path additionally CAS-writes via
`readManifestWithEtag`/`replaceManifestIfCurrent`, so a reprocess landing
between read and write loses nothing — the refresh write simply fails its CAS
and the reading is picked up next night.

### 3.5 Tension directionality

Decision: store on **both** manifests so either detail page can render the
edge without a join, with a per-side directional kind:

```typescript
// src/schemas/reading-summary.ts (mirrored in web/src/types.ts)
export const TensionKindSchema = z.enum([
  "contradicts",     // symmetric
  "supersedes",      // this reading supersedes `id`
  "superseded_by",   // `id` supersedes this reading
  "qualifies",       // this reading narrows/qualifies `id`
  "qualified_by",    // `id` narrows/qualifies this reading
]);

export const TensionSchema = z.object({
  id: z.string().min(1),
  kind: TensionKindSchema,
  reason: z.string().min(1),
  computed_at: z.string().datetime(),
}).strict();
```

The pairwise judge returns one verdict per pair (`contradicts` |
`supersedes` — with which side supersedes — | `qualifies` — with direction — |
`none`); the writer derives each side's kind and a side-appropriate `reason`.
This avoids a `direction` flag that every reader would have to interpret, at
the cost of two extra enum values. Like `connections`, purge leaves inbound
tensions dangling; tier 1's stale-citation rule extends to `tensions` so they
get cleaned on the next refresh rather than at purge time.

Stored on the manifest for v1. A separate edge index (`index/edges/` or D1)
is explicitly deferred until a graph query actually needs it.

### 3.6 Cost ceiling

Offline commands: plan mode prints the exact judgement count and a
conservative dollar estimate (token arithmetic over own-tldr + own-summary +
K neighbour tldrs, same style as the `compare-summary-effort` runner);
`--limit` caps a pass; `--execute` refuses if the estimate exceeds
`--max-cost` (default set generously, e.g. $5).

Worker path: `REFRESH_MAX_JUDGEMENTS` env cap per nightly run (queue consumer
counts judgements in the shard cursor object and stops enqueueing judge work
past the cap), plus the `RELATIONSHIP_REFRESH` master gate. Per-tenant budget
ledgers are deferred to the multi-tenant billing workstream — v1 runs
founder/global only.

## 4. Phase 1 — `ops corpus refresh-neighbours` (tier 1)

Zero LLM cost. Immediately answers "how stale is the corpus?" even before any
tier-2 work exists.

### New pure module: `scripts/corpus-lib/refresh-neighbours.ts`

Mirrors the structure of `backfill-similarity.ts` (pure planning + merging,
no R2), and reuses `excludeSelf`, `aboveFloor`, `SIMILAR_TOP_K`,
`SIMILARITY_FLOOR`, `summarizeSimilarity` from `similarity-store.ts`:

- `planRefresh(items, opts)` — targets = `ready` readings (only they own a
  vector), with `--only`, `--limit` selection. Unlike backfill there is no
  "already scored" skip: every ready reading is re-measured every run;
  resumability comes from the run being cheap and idempotent.
- `diffNeighbourhood(reading, currentMatches, listIds, judgedAt)` — returns a
  `RefreshFlag[]`, where each flag is one of:
  - `stale_connection` — a stored `connections[].id` (or `tensions[].id`) is
    absent from the current ready set in `index/list.json`. (Same test as
    `sweep.invalidatedByDrop`, promoted from sweep-time to nightly.)
  - `new_neighbour` — a current floored neighbour id is not cited in
    `connections` AND that neighbour postdates `judgedAt` (see 3.1). The
    neighbour's age comes from vector metadata `created_at` when present,
    else from its list-index row; a neighbour with no resolvable timestamp is
    treated as new (conservative: flags for re-judgement, costs one tier-2
    call, never hides drift).
  - `verdict_inconsistent` — `novelty_verdict === "novel"` while the floored
    neighbourhood is non-empty, or `familiar`/`duplicate` while it is empty.
- `snapshotChanged(oldSnap, newSnap)` — material-change test gating the
  snapshot rewrite: count changed, or |Δmax| ≥ 0.02, or |Δmean| ≥ 0.02.
  Constant lives in this module with a calibration comment (same discipline
  as the `SIMILARITY_FLOOR` comment); revisit after the first full run.

### Command: `scripts/ops-lib/commands/corpus-refresh-neighbours.ts`

Follows `corpus-backfill-similarity.ts` closely — same `run(argv, deps)`
shape, same injected `CorpusBackfillR2`-style deps, same tenant flag, same
exit semantics (attempted-but-unmeasured readings → exit 1):

1. Read `index/list.json`; plan targets.
2. Per target: `queryByVectorId(index, id, SIMILAR_TOP_K + 1, namespace)`
   (over-fetch by one, self excluded — the existing idiom). **Prerequisite:**
   extend `scripts/corpus-lib/wrangler-r2.ts#queryByVectorId` to request
   `returnMetadata` and surface `{id, score, title?, tldr?, tags?,
   created_at?}` — tier 1 needs `created_at` for the age test and tier 2
   needs `title`/`tldr` to build judgement context without extra reads.
3. Compute new snapshot; if `snapshotChanged` and `--execute`, write it with
   the exact `backfill-similarity` write discipline: `validateBackfillWrite`
   (parse-as-gate, write the original merged object so unknown fields
   survive `.strip()`), per-reading error isolation, confirmed-written-only
   list-index flush in a `finally`.
4. Always (plan or execute): append flagged readings to the report.
5. Write `--out refresh-report.json` (default `./refresh-report.json`):

```jsonc
{
  "version": 1,
  "generated_at": "…",
  "tenant": "global",
  "floor": 0.55,
  "readings": [
    {
      "id": "rd_…", "key_prefix": "…", "url": "…",
      "reasons": ["new_neighbour", "verdict_inconsistent"],
      "novelty_verdict": "novel",
      "connections": [{ "id": "rd_…", "reason": "…" }],
      "judged_at": "…",             // resolved per 3.1, with its source noted
      "judged_at_source": "connections_computed_at | last_attempt | updated_at",
      "current_neighbours": [
        { "id": "rd_…", "score": 0.72, "title": "…", "tldr": "…", "created_at": "…" }
      ]
    }
  ]
}
```

The report is the tier-2 input contract (like `corpus-audit`'s `index.json`
feeding `corpus-recover`), so it carries everything tier 2 needs to build a
prompt without re-querying Vectorize.

Help text documents the sole-writer caveat backfill already carries: the
list.json rewrite is a plain put, so run while nothing is being submitted.

### Tests (Node pool, `test/unit/scripts/` + `test/unit/corpus/`)

- Planner: ready-only targeting, `--only`/`--limit`.
- Diff rules: each flag reason, the judged-at fallback chain, missing
  neighbour `created_at` → conservative flag, tensions ids included in the
  stale-citation check (forward-compatible; empty until phase 3).
- `snapshotChanged` thresholds.
- Command run with stubbed deps: plan vs execute, snapshot-write gating,
  report contents, exit codes, registry coverage test row.

### Acceptance

Running `npm run ops -- corpus refresh-neighbours --tenant global` against
production prints the staleness inventory and writes the report;
`--execute` refreshes drifted snapshots; a second immediate run writes
nothing (idempotent). `npm run test:quiet` + `npm run typecheck` pass.

## 5. Phase 2 — schema + `ops corpus refresh-connections` (tier 2)

### Schema change (one synchronized sweep, per convention)

`src/schemas/manifest.ts`: add `connections_computed_at:
z.string().datetime().optional()` to `ManifestSchema`. Mirror in
`src/schemas/api.ts` (detail response), `web/src/types.ts`, and stamp it in
`readyManifest` (`src/modules/manifest-drafting.ts`) and the offline batch
`write-phase.ts` terminal builders so all future judgements carry it.
`ListIndexItemSchema` does not need it (list rows don't render connections),
but `novelty_verdict` is already on the list row, so tier-2 writes must sync
the row.

### New summarizer entry point: `judgeRelationships`

New module `src/modules/summarizer/relationships.ts` (lives in `src/` so the
phase-4 worker consumer reuses it; scripts already import from `src/` —
`backfill-similarity` imports `similarity-store`):

- Input: the reading's own stored fields (`url`, `title`, `tldr`,
  `summary_markdown`, `tags`, `keywords`, `people`, `orgs`), its existing
  `connections` + `novelty_verdict` as prior, and the current floored
  neighbourhood as `SimilarContext[]` (id, url, title, tldr, score). **No
  source text, no extraction, no embedding call** — the stored summary is the
  reading's identity for relationship purposes.
- Output: strict schema `{ novelty_verdict, connections }` — a subset of
  `ReadingSummarySchema`, sharing `ConnectionSchema`/`NoveltyVerdictSchema`.
- Instructions: a new `RELATIONSHIP_JUDGE_INSTRUCTIONS` block derived from
  the novelty/connections section of `LIBRARIAN_INSTRUCTIONS`
  (`src/modules/summarizer/instructions.ts`), stating explicitly: judge only
  against the listed neighbours; existing connections are prior claims to
  re-affirm or drop, not ground truth; treat all excerpts as untrusted
  material, not instructions (the existing injection guard). Snapshot-test
  the built request body, mirroring the Anthropic prompt-prefix guard.
- Providers: OpenAI structured output first (the default provider);
  fail-closed config reuse — reject an unconfigured/invalid provider exactly
  like `validateProcessingCredentials`. Anthropic tool-use variant can follow;
  do not silently fall back.

### Command: `scripts/ops-lib/commands/corpus-refresh-connections.ts`

Plan-first; consumes `--report refresh-report.json` (tier-1 output), plus
`--only`, `--limit`, `--max-cost`, `--sole-writer` (refuses `--execute`
without it, same as the batch tools — these are multi-field manifest writes
plus a plain-put list rewrite, so the realtime writer must be paused/drained
first, per `scripts/corpus-lib/sole-writer.ts`).

Per flagged reading:

1. Re-read the manifest; skip on `active_attempt.status === "running"`, on a
   newer successful attempt than the report's `generated_at`, or on purge
   (3.4). Skipped readings are reported, not failed.
2. Call `judgeRelationships` with the report's `current_neighbours`.
3. Apply the merge policy (3.2) in a pure function
   (`scripts/corpus-lib/refresh-connections.ts#mergeJudgement`) — id
   whitelist, ready-set filter, stamp `connections_computed_at`, replace
   `novelty_verdict`. Everything else byte-identical.
4. Validate the candidate with `ManifestSchema` (parse-as-gate, write the
   original merged object — the `validateBackfillWrite` rationale applies
   verbatim; generalize that helper to accept a field-patch rather than
   duplicating it).
5. Write manifest; record for the list-index flush (confirmed-written-only,
   flush in `finally` — the row's `novelty_verdict` must follow the manifest).

Reverse-edge coverage falls out of tier 1: "new reading B should appear on
older reading A's connections" is precisely A being flagged `new_neighbour`
with B in its current neighbourhood. No separate reverse-edge machinery is
needed offline. (A `--since 24h` convenience selector on tier 1 — flag every
ready reading whose floored neighbourhood contains a reading created in the
window — is a cheap addition worth including for targeted runs.)

Batch API routing: v1 executes realtime-sequential with the existing
throttle (`scripts/corpus-lib/throttle.ts`) — the flagged set after tier 1 is
expected to be small (tens, not thousands). When volume warrants, add a batch
front-end reusing `scripts/corpus-lib/batch/` (`clients.ts`
`OpenAIBatchClient`, sidecar resume, `openai-reconcile.ts` create-window
lock), shaped like `prepare-fresh-markdown.ts`/`run-fresh-markdown.ts`: a
`prepare-refresh.ts` that builds judge payloads from the report, then the
shared submit/poll/write phases with a refresh-specific write step. That
front-end is a follow-up issue, not part of this phase's acceptance.

### Ingest-time connections stay

Nothing in `processReading` changes in this phase. Ingest-time judgement
still provides immediate detail/digest value (per the product scope);
`readyManifest` merely starts stamping `connections_computed_at`.

### Tests

- Merge policy: hallucinated id dropped, dropped-reading id dropped, prior
  kept when re-affirmed, verdict replaced, stamp written, all other fields
  byte-identical (deep-equal minus the three fields).
- Skip guards: active attempt, newer attempt, purged.
- `judgeRelationships`: request-body snapshot; zod parse of provider output;
  fail-closed provider config.
- Command with stubbed deps + stub judge: plan prints count + cost estimate
  and writes nothing; execute path, list-row sync, exit codes.
- Schema sync tests: manifest/api/web types compile; existing manifests
  without the new field still parse (optionality).

### Acceptance

Dry-run against the production report shows per-reading planned judgements
and cost; `--execute --sole-writer` on a small `--limit` batch updates
connections/verdicts/stamps, the SPA detail shows "connections as of {date}",
and re-running tier 1 immediately afterwards no longer flags those readings.

## 6. Phase 3 — tensions (`ops corpus refresh-tensions`)

### Schema

`TensionSchema`/`TensionKindSchema` as in 3.5, in
`src/schemas/reading-summary.ts`; `tensions: z.array(TensionSchema).optional()`
on `ManifestSchema` and the detail-response schema in `api.ts`; hand-mirror in
`web/src/types.ts`; SPA detail section ("Challenges / challenged by") rendered
from it. `Tension` is **not** added to `ReadingSummarySchema` — ingest-time
summarization does not produce tensions in v1 (the contradicting reading is
exactly what ingest can't see; that is the point of the feature).

### Candidate generation (pure, tested, no LLM)

`scripts/corpus-lib/refresh-tensions.ts#tensionCandidates(report, manifests)`:

- Universe: (reading, neighbour) pairs from the tier-1 report's
  `current_neighbours` (already floored at 0.55) — similarity is necessary
  but not sufficient.
- Pre-filter: entity/topic overlap — shared `people` ∪ `orgs` entry
  (case-insensitive), or keyword Jaccard ≥ 0.2. Constants documented and
  calibrated against the live corpus like `SIMILARITY_FLOOR` was.
- Dedup pairs across both directions; skip pairs already carrying a tension
  whose `computed_at` postdates both sides' `judged_at`.

### Pairwise judge: `judgeTension` (`src/modules/summarizer/tensions.ts`)

- Input: both readings' stored `title`/`tldr`/`summary_markdown`.
- Output: strict `{ verdict: "none" } | { verdict: "contradicts" | "supersedes"
  | "qualifies", superseder?: "a" | "b", qualifier?: "a" | "b",
  reason_a: string, reason_b: string }`.
- Instructions bias hard toward `none`: topical overlap, complementary
  coverage, and different emphasis are all `none`; only opposing claims,
  displaced results, or explicit narrowing qualify. Snapshot-test the
  request body.

The writer derives each side's directional kind + reason and appends to both
manifests' `tensions` (replacing an existing entry for the same pair), with
the same write discipline, skip guards, sole-writer requirement, list-index
non-involvement (tensions are not on list rows), and cost ceiling as tier 2.
Both-manifest writes are not atomic; a crash between them leaves a one-sided
tension, which is tolerated (same dangling stance as `connections`) and
repaired by the next run's pair-dedup logic.

### Tests

Candidate pre-filter (overlap rules, pair dedup, already-judged skip),
directional-kind derivation for every verdict shape, one-sided-write repair,
schema round-trips, SPA render.

### Acceptance

Dry-run lists candidate pairs with overlap evidence and cost; execute on a
hand-picked pair known to conflict writes directional tensions to both
manifests and both detail pages render them.

## 7. Phase 4 — cron worker + queue

Only after the offline commands have run against production for a while and
the flag-rate/cost constants are calibrated.

### Bindings and config (`wrangler.toml`, staging + production)

- `[triggers] crons = ["17 9 * * *"]` (staging on a different hour, e.g.
  `["43 7 * * *"]`, so staging incidents don't mask production ones).
- New queue `reading-lite-refresh` (+ `reading-lite-refresh-dlq`), producer
  binding `RELATIONSHIP_REFRESH_JOBS` (optional on `Env`, like
  `READING_JOBS`, so dev's missing binding degrades cleanly), consumer with
  `max_batch_size = 1`, `max_concurrency = 1-2`, DLQ wired.
- Vars: `RELATIONSHIP_REFRESH` master gate (unset = off — dev and the
  pre-calibration period), `REFRESH_MAX_JUDGEMENTS` nightly cap.
- `ops staging setup`/`teardown` gain the new queue pair (they are hard-coded
  to staging names; extend both directions idempotently).

### Runtime shape

`scheduled()` must not do per-reading work inline: a corpus of N readings
needs N Vectorize queries and the Workers subrequest budget (1000/invocation)
plus CPU limits make one-shot sweeps a scaling cliff. Instead:

1. `scheduled()` (new export in `src/index.ts`): read `index/list.json`, cut
   the ready ids into shards of ~50, enqueue one `scan` message per shard
   onto `RELATIONSHIP_REFRESH_JOBS`. Envelope: `RefreshJobEnvelopeV1`
   mirroring `ProcessReadingEnvelopeV1` (`version: 1`, `tenantId`, `actor:
   { kind: "operator", operationId }`, `job: { kind: "scan", ids } |
   { kind: "judge", id, keyPrefix }`), admitted through the same
   control-plane gate (`admitEnvelopeOrReject`) in the consumer. v1 iterates
   the founder/global tenant only; the tenant loop is the multi-tenant
   follow-up.
2. Consumer (`src/index.ts` `queue()` branches on the new queue name, like
   the DLQ branch): a `scan` message runs tier-1 diff for its shard —
   `similarityStoreFor(...).query` is vector-id-less in the worker API, so add
   a `queryById` to `SimilarityStore` wrapping Vectorize's
   `getByIds`+`query`-by-values (or query by the stored vector fetched via
   `getByIds`) with the same namespace/tenant-id-prefix handling as `query` —
   then enqueues one `judge` message per flagged reading, respecting
   `REFRESH_MAX_JUDGEMENTS` via a nightly cursor object
   (`index/refresh-cursor.json`, CAS-written like the list index).
3. A `judge` message runs the tier-2 unit for one reading: skip guards (3.4),
   `judgeRelationships`, merge, **CAS** manifest write
   (`readManifestWithEtag` → `replaceManifestIfCurrent`), list-row sync via
   the existing `mutateListIndex` CAS helper — unlike the offline plain puts,
   the worker path uses the store's CAS machinery throughout, so it coexists
   with the realtime writer and needs no sole-writer pause. No vector writes
   (the embedding did not change). `RateLimitedError` → `msg.retry` with
   delay (reuse `dispatchQueueMessage`); other errors → log + ack (a failed
   refresh leaves the previous judgement in place — never a `failed`
   manifest, refresh must not damage a `ready` reading). DLQ consumer just
   logs; there is nothing to mark.

### SPA

Already covered by phases 2-3 (staleness date, tensions section). Optionally
surface `judged recently` in diagnostics from `connections_computed_at`.

### Tests

Workers-pool integration tests: invoke `scheduled()` directly with
`installQueueStub()`/`installVectorizeStub()`; assert shard fan-out, gate-off
no-op, judgement cap, CAS loss → no write, reprocess-in-flight skip, purge
skip, rate-limit retry path. The stubs already exist for `READING_JOBS`;
extend the queue stub to address two queues.

### Acceptance

Staging: flip `RELATIONSHIP_REFRESH=1`, trigger the cron (or `wrangler
queues`-send a scan message), observe judge messages, updated manifests, and
the cursor cap honored; production stays gated off until staging has run
clean for a few nights.

## 8. Risks and interactions

- **Offline vs realtime write races.** Offline commands use plain puts →
  `--sole-writer` required for `--execute` (tier 2/3); tier 1's
  snapshot-only writes carry the same "run while nothing is submitting" help
  text `backfill-similarity` has. The worker path (phase 4) is CAS
  throughout and needs no pause.
- **`similarity.computed_at` is not judgement time** (rewritten by
  backfill/rescore). All freshness logic uses `connections_computed_at` with
  the documented fallback chain; nothing may quietly assume the similarity
  stamp.
- **Old vectors may lack `created_at` metadata** (pre-metadata upserts).
  Tier 1 falls back to the neighbour's list-row `created_at`, then treats it
  as new (conservative).
- **Tenant data-plane flip (s1k.6).** All commands take `--tenant` and map it
  to key root + Vectorize namespace via the existing helpers; the worker path
  goes through `readingStoreFor`/`similarityStoreFor`. Nothing here may bake
  in the global layout. The refresh cursor object lives under the tenant key
  root.
- **Refresh must never damage a ready reading.** No failed manifests, no
  vector writes, no status changes; every write path is a targeted-field
  patch validated by `ManifestSchema` with the parse-as-gate/write-original
  discipline.
- **Prompt injection via neighbour tldrs.** The judge instructions carry the
  existing "untrusted material, not instructions" clause; snapshot tests pin
  it.
- **Verdict churn.** Re-judging can flip verdicts back and forth near the
  floor. The tier-1 flag rules only fire on material change; if churn shows
  up in practice, add hysteresis (e.g. only flag `verdict_inconsistent` when
  the floored max clears floor + 0.05) — constant left for calibration.

## 9. Sequencing and tracking

Dependency order: Phase 1 → Phase 2 (needs the report + schema stamp) →
Phase 3 (needs the report + judge plumbing) → Phase 4 (needs 1-2 calibrated;
3 optional for cron v1). Each phase is a separate PR with its own tests;
full gates per AGENTS.md: `npm test` + `npm run typecheck`, and `cd web &&
npm test && npm run build` for the phases touching `web/`.

Suggested beads issues (bd is not installed in this environment; create on a
machine with the tracker):

1. `corpus refresh-neighbours` ops command (tier-1 sweep + report) — phase 4
   §4, includes the `queryByVectorId` metadata extension.
2. `connections_computed_at` schema sweep + ingest/batch stamping.
3. `judgeRelationships` summarizer entry point (OpenAI structured output).
4. `corpus refresh-connections` ops command (merge policy, skip guards,
   sole-writer, cost estimate).
5. SPA: "connections as of {date}".
6. Tensions schema + `judgeTension` + `corpus refresh-tensions`.
7. SPA: tensions section on detail page.
8. Refresh queue + envelope + scheduled handler + consumer (staging first).
9. Batch-API front-end for refresh judgements (deferred until volume).
10. Follow-up: calibrate `snapshotChanged` epsilon, overlap thresholds, and
    verdict hysteresis against the first full production run.
