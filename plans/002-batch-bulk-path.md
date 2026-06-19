# Plan 002 — Bulk path via Anthropic + OpenAI Batch APIs (issue #20)

> Add a **bulk** reprocess/recovery path that summarizes (and optionally embeds)
> through the async **Batch APIs** instead of fanning every reading into the
> realtime `READING_JOBS` queue. The interactive submit/poll path is untouched.

## 1. Problem & goal

Bulk reprocessing (migrations, `corpus-recover`) currently routes every reading
through the realtime queue → live `messages.create` + embed. That path is built
for one latency-sensitive URL at a time; a backlog of dozens–thousands bursts
upstream per-minute rate limits (a 90-reading run cleared 46 and stranded 44).
`corpus-recover --wave` (#19) paces submissions to stay under the limit, but that
just makes a slow job slower on purpose — a mitigation, not the right tool.

**Goal:** a separate bulk path that submits one Anthropic **Message Batch**
(`custom_id` = reading id), polls to completion, then writes
manifests/index/vectors from the results — at ~50% token cost, with no
rate-limit dance and nothing to strand. Embeddings stay realtime for v1
(cheap/fast; batch them later if measurement justifies it).

### Acceptance (from the issue)
- `corpus-recover` can reprocess a backlog via the Message Batch API end-to-end
  (submit → poll → write results), embeddings handled.
- A bulk run of N readings completes without tripping rate limits or stranding
  any reading, at batch pricing.
- The interactive submit/poll path is **untouched**.

## 2. Key decisions (resolving the issue's open questions)

| Question | Decision | Why |
|---|---|---|
| **Where the batch path runs** | A **Node CLI**, not the worker. New `--batch` mode in `corpus-recover` (logic in `scripts/corpus-lib/batch/*`). | Batches take minutes–hours; that does not fit a Worker request/queue-consumer. `migrate.ts` already proves the Node→R2(S3/SigV4)→Vectorize(REST) write pattern, reusing pure `src/` helpers. The realtime queue stays the realtime path — we never touch it. |
| **Where extraction runs** | **Locally, up front** in the script. For each target: read existing `extracted.md` from R2 if present; else `extractFromUrl` (browser UA, same as today's `local-extract`). Only summarize+embed go through the batch. | The Anthropic batch can't fetch URLs. The script already imports `extractFromUrl`. This collapses today's `reprocess` and `local-extract` policy buckets into one bulk path. |
| **emit_reading / prompt-cache contract** | Refactor `src/modules/anthropic` to export a **pure request-body builder** and a **pure response parser**; both the realtime call and the batch reuse them. Each batch request is `{ custom_id, params: <identical body> }`. | Guarantees a byte-identical cacheable prefix (tools → system w/ `cache_control`), so the prompt cache is shared across the batch. Single source of truth for the tool def + system prompt. |
| **Embeddings: batch or realtime?** | **Realtime for v1**, but coalesced via OpenAI's array `input` (one HTTP call embeds many texts). Defer OpenAI Batch API to a follow-up. | Embeddings are cheap and fast; the rate-limit pain is Anthropic. Array-input realtime avoids the burst without the batch-lifecycle complexity. There's also a hard ordering dependency (below) that makes a single co-submitted embed+summarize batch impossible. |
| **CLI surface** | `corpus-recover --batch` swaps the submit path; `--wave` stays for the realtime path (the #19 safety net). | Matches the issue. One audit `index.json` drives both. |
| **Attempt trigger** | Reuse existing `"reprocess"` trigger value. | Avoids a manifest-schema + SPA-mirror change. (Optional later: add a `"batch"` trigger for diagnostics — requires updating `src/schemas/manifest.ts` **and** `web/src/types.ts` in lockstep.) |

### The ordering dependency (why embed can't be one co-batch)
The realtime pipeline embeds twice:
1. `embed_source` → query Vectorize top-K → **feeds "similar readings" into the
   summarize prompt** (drives `novelty_verdict` + `connections`).
2. `embed_summary` (TL;DR) → the persistent vector.

So step 1 must finish **before** the Anthropic batch is built, and step 2 needs
the **batch output**. The bulk flow is therefore three ordered phases:

```
extract(local/R2) → embed_source(realtime, array) → query similar
   → [ANTHROPIC MESSAGE BATCH: summarize all]            ← the slow async step
   → embed_summary(realtime, array) → upsert vectors + write manifests/index
```

## 3. Architecture

### 3.1 Refactors in `src/` (shared, behavior-preserving)
These make the realtime worker and the Node batch path share one contract. They
are pure extractions — the realtime path must behave identically (regression
tests below).

- **`src/modules/anthropic/index.ts`**
  - Export `buildSummarizeRequestBody(input: SummarizeReadingInput, model: string): object`
    — the exact body object currently built inline in `summarizeReading`
    (system + `cache_control`, tools, `tool_choice`, messages via
    `buildUserMessage`). `summarizeReading` calls it.
  - Export `parseEmitReadingResult(content, usage): SummarizeReadingResult`
    — the `tool_use` find + `EmitReadingToolInputSchema.safeParse` +
    `NoToolUseError`/`BadToolInputError`. `summarizeReading` calls it.
  - Keep `EMIT_READING_TOOL_NAME`, error classes exported.
  - **Constraint:** the prefix bytes (tools + system) must not change, or every
    cached prompt invalidates. Snapshot-test the prefix.

- **No change to `src/modules/embeddings`** for v1 realtime path; the batch
  script needs *array* embedding, so add a small Node helper (3.2) rather than
  widening the worker module. (If we later want array embeds in the worker too,
  generalize `embed` to accept `string | string[]`.)

### 3.2 New: `scripts/corpus-lib/batch/`
All Node-only (under the node vitest project glob; may import `node:*`).

- **`clients.ts`** — thin REST clients, injectable (deps-as-args, no globals):
  - `AnthropicBatchClient`: `create(requests)`, `get(batchId)`,
    `results(resultsUrl)` (streams/parses JSONL). Header
    `anthropic-version: 2023-06-01`; endpoint `POST /v1/messages/batches`.
  - `OpenAIEmbedClient.embedMany(inputs: string[]): number[][]` — single
    `POST /v1/embeddings` with array `input` (chunked to stay under request-size
    limits; validate each vector is length `EMBEDDING_DIM`).
  - Reuse the `R2Client` (S3/SigV4 via `aws4fetch`) + `VectorizeClient` (REST)
    **from `scripts/migrate-lib/clients.ts`** — extract those factory funcs out
    of `migrate.ts` into a shared `scripts/lib/cf-clients.ts` so both
    `migrate.ts` and the batch path use one implementation. Also need an R2
    **read** (`get`) added to `R2Client` to load existing `extracted.md` /
    current manifest (migrate only writes today).
- **`prepare.ts`** — pure: turn audit rows → `BatchTarget[]`
  `{ readingId, url, urlHash, keyPrefix, createdAt, preserveReadyManifest? }`.
  Resolve `keyPrefix` via existing `buildKeyPrefix` / by-id pointer.
- **`extract-phase.ts`** — for each target: `readExtracted` from R2 → else
  `extractFromUrl(browserFetch)`. Drop targets with no usable markdown
  (record as skipped, reason carried into the report).
- **`similar-phase.ts`** — `embedMany(truncateForEmbed(markdown))` then Vectorize
  query top-5 per target (filter `id !== self`) → `SimilarContext[]`.
- **`submit-phase.ts`** — build `{custom_id, params: buildSummarizeRequestBody(...)}`
  per target; `create()`; **persist a sidecar** `<index>.batch.json`
  (`{ batchId, createdAt, targets: {custom_id → keyPrefix,...} }`) so a crashed
  poll resumes without re-summarizing (idempotent + cost-safe).
- **`poll-phase.ts`** — poll `get(batchId)` until `processing_status === "ended"`
  (bounded backoff; respects 24h max). Stream `results()`.
- **`write-phase.ts`** — per result:
  - `succeeded` → `parseEmitReadingResult` → build `ready` Manifest (mirror the
    field map in `process-reading.ts:134`), `embedMany` the TL;DRs (batched
    across the result set), Vectorize upsert, then **terminal writes** (3.3).
  - `errored`/`expired`/`canceled` → mark that reading **failed (retryable)**,
    preserving a prior `ready` snapshot if present. **No by-url pointer.**

### 3.3 Terminal-write contract (must match `process-reading.ts` exactly)
Per CLAUDE.md: *every* terminal write maintains `index/list.json`; the by-url
pointer is written **only on success**; failed URLs stay re-submittable.

- **Success:** write `manifest.json` (status `ready`) + `raw.*`/`extracted.md`
  (if newly extracted) + by-url pointer + by-id pointer + Vectorize upsert +
  `manifestToIndexItem` into `index/list.json`.
- **Failure:** write `failed` manifest (or roll forward to `preserveReadyManifest`
  per `markFailed`) + list item; **no** by-url pointer.
- **List index:** the script is effectively the sole writer during a backfill —
  read `index/list.json` **once**, merge all touched items
  (`manifestToIndexItem`, replace-by-id), write **once**. This matches the
  `migrate.ts` precedent (also a plain write-once). *Decision (v1):* no etag CAS —
  the S3 `R2Client.put` doesn't expose conditional writes, and the operator runs
  this alone. Residual risk: a concurrent interactive submit landing during the
  final write is last-writer-wins; documented in the skill. Adding CAS (extend
  `R2Client.put` with `If-Match`) is a follow-up if backfills ever overlap live traffic.

### 3.4 In-flight visibility (optional but recommended)
Before submit, flip each target's manifest to a `running` `active_attempt`
(trigger `reprocess`, fresh `attemptId`, `started_at = now`) + list item — same
shape the router writes via `manifestForActiveAttempt`. Keeps `corpus-audit`'s
"in-flight vs stranded" meaningful during the (possibly hour-long) batch.
**Risk:** a batch can outlive `PENDING_TTL_SECONDS`, so mid-run audits may label
it "stranded" — benign (the sidecar is the source of truth; terminal writes
land on completion). Note this in the skill doc.

## 4. CLI integration

`corpus-recover --batch [--only reprocess] [--limit N] [--monitor]`:
- Reuses the existing audit `index.json`, `planByAction`, config/token resolution.
- Routes `reprocess` **and** `local-extract` rows through the bulk path (both
  reduce to extract→summarize→embed→write; the batch obsoletes the
  reprocess/local-extract split for bulk).
- `skip`/`none` rows untouched.
- Without `--execute`: print the batch plan (counts, est. requests, est. tokens,
  ~50% cost note) and exit. With `--execute`: run the full lifecycle.
- `--wave` is **ignored** in batch mode (warn if both passed); it remains the
  realtime-path throttle.
- Resume: if `<index>.batch.json` exists with an unfinished batch, `--batch`
  resumes polling that batch instead of creating a new one.
- New env/flags: reuse `.migrate.vars` resolution for R2 S3 creds + Vectorize
  (`MIGRATE_*`), `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, `OPENAI_API_KEY`.

## 5. TDD plan (test-first, per repo convention)

Node-pool tests under `test/unit/corpus/batch/` and `test/unit/anthropic/`.
Use fakes for all clients (deps-as-args); **no real network**, no Vectorize/Queue
bindings in Miniflare.

1. **Refactor guard (red→green first):**
   - `buildSummarizeRequestBody` returns the same body shape; **snapshot the
     cacheable prefix** (tools + system) so any drift fails loudly.
   - `parseEmitReadingResult` covers happy path, `NoToolUseError`,
     `BadToolInputError`.
   - Existing `anthropic.test.ts` still green (realtime path unchanged).
2. **prepare/extract/similar phases:** row→target mapping; R2-extracted reused
   vs `extractFromUrl` fallback; empty-markdown drop; self-filtering in similar.
3. **submit-phase:** request shape (`custom_id` = reading id, `params` identical
   to realtime body); sidecar written; `--limit` honored.
4. **poll-phase:** fake client transitions `in_progress → ended`; backoff;
   results parsed from JSONL.
5. **write-phase (the contract tests):**
   - success → `ready` manifest + by-url + by-id + index item + vector upsert.
   - failure result → `failed` (retryable) manifest + index item, **no by-url**.
   - `preserveReadyManifest` rollback on failure (reuse/port `markFailed` logic).
   - list-index merge: read-once/write-once + CAS retry on etag mismatch.
6. **resume:** existing sidecar with `ended` batch → skips create, writes from
   results; idempotent re-run doesn't double-process.
7. **integration (Node):** end-to-end with all clients faked over ~3 readings:
   audit rows → batch → R2 writes asserted; assert the realtime
   `readings.test.ts` integration suite is untouched/green.

## 6. Docs & rollout
- Update `.claude/skills/corpus-recover/SKILL.md`: add `--batch`, the
  realtime-vs-batch decision guidance, sidecar/resume, the PENDING_TTL caveat.
- Update `README.md` (architecture + scripts) and `CLAUDE.md`
  ("Easy to get wrong": batch path reuses terminal-write helpers; prefix must
  stay byte-identical; embeddings realtime for now).
- `.migrate.vars.example`: note the keys the batch path also reads.
- Manual validation: dry-run on the current `index.json`, then a small
  `--limit 5 --execute --monitor` batch against prod before a full backlog run.

## 7. Risks / watch-items
- **Prefix drift** silently kills prompt-cache savings → snapshot test (5.1).
- **Cost-safety on resume:** never recreate a batch when a live `batchId` exists;
  sidecar is authoritative. Idempotent terminal writes (overwrite-by-id) make a
  re-run safe.
- **Per-request batch errors** (`errored`/`expired`) must land as retryable
  `failed`, never silently dropped — they stay re-submittable (no by-url pointer).
- **List-index races** with concurrent interactive submits → CAS loop.
- **24h batch expiry** on a huge backlog → chunk into multiple batches if the
  target set is very large (Anthropic allows 100K/256MB per batch; chunk on
  request-size, not count, to be safe).
- **`extracted.md` staleness:** prefer a fresh local extract for `local-extract`
  rows (they failed fetch originally); reuse R2 `extracted.md` only for rows that
  already captured content.

## 8. Out of scope (follow-ups)
- OpenAI **Batch API** for embeddings (measure realtime-array cost/throughput
  first; the issue says "measure first").
- A dedicated `"batch"` attempt trigger (schema + SPA mirror change).
- Driving migrations through the same batch path (the issue scopes this to
  reprocess/recover; `migrate.ts` already does its own bulk writes).
