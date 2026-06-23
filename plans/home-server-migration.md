# Home-Server Migration — Hardened TDD Plan

Migrate reading-lite compute from Cloudflare Workers to a home server. Storage
stays in R2 (accessed via its S3-compatible API instead of the Workers binding),
vectors stay in Vectorize (accessed via its v2 REST API), and Cloudflare Queues
is replaced by an in-process async job runner. Ingress is via Cloudflare Tunnel
to `reading-lite.bbell.dev`, serving the SPA same-origin.

## What changed from the draft

- **ObjectStore.list now preserves the pagination/completeness contract** (`{objects, truncated, cursor}`), not a bare `{key,uploaded}` — because `rebuild()` branches on `truncated && !cursor` to decide whether persisting `index/list.json` is safe (silent partial persist would clobber live rows). Added a >1000-object rebuild HV gate.
- **S3 ETag normalization is now an explicit, tested requirement**: strip surrounding quotes and any weak `W/` prefix so the surfaced etag is byte-identical to the binding's unquoted `R2Object.etag` and is accepted verbatim by a later `If-Match`. Added an etag round-trip contract assertion; without it production fail-closes (perpetual 412 → CAS exhaustion).
- **Seams inject through `Services`/`AppOptions`, not a per-route Env param swap** — collapsing 11 `ReadingStore` + 2 `SimilarityStore` construction sites to one factory and removing `R2Bucket`/`VectorizeIndex` from the Node `Env` (Workers ambient types stop leaking into the Node build). `ObjectStore.put` takes a **binding-neutral precondition**, not the R2 `onlyIf` union.
- **`ObjectStore.get` now exposes a streamable `body` + `contentType`** (two content routes stream `obj.body`); corrected the interface sketch.
- **A `Scheduler`/`Clock` seam (epoch-ms `nowMs` + cancelable `setTimer`) is added before Phase 4c** — none of the runner backoff/drain tests are deterministic without it; `services.now()` returns an ISO string, unusable for delay math.
- **Phase 4 gains the missing non-rate-limit branch**: a non-`RateLimitedError` throw is log-and-done with **zero** runner writes and **no** ceiling increment (process() already wrote the failed manifest). Separated the CF **delivery counter** from the manifest `attemptId`. Resolved that `submit` stays fallible (keeps the `QueueSendError` rollback live).
- **Phase 5 reuses `attemptOwnership.isActive`** so boot reconcile cannot resubmit a pending another producer owns, and states the one durability invariant (drain | boot-reconcile-within-TTL | stalenessOf-past-TTL). `drain()` is tested as a pure function; SIGTERM/`kill -9` is HV-only.
- **New ops phases**: split-brain cutover ordering (exactly-one-writer), systemd supervision + crash-loop backoff, least-privilege scoped secrets, observability/alerting, R2 versioning backup before the correctness gate, and a **rollback story that keeps the Worker live until after prod soak** (destructive deletions moved to a final cleanup phase).
- **Phase 7 hardens public ingress**: Node body-size limit + slow-request timeout (no Workers platform cap anymore), Cloudflare Access **required** (not optional) in front of paid `POST /readings`, explicit CORS-middleware fate, and SPA routing-order tests.
- Corrected Vectorize specifics: REST shapes confirmed (`/v2/indexes/{index}/query|upsert|delete_by_ids`, ndjson upsert, `returnMetadata:'all'`), `topK` cap with metadata is **50** (matches existing clamp), `delete_by_ids` is **net-new** code (the script client only does upsert+query), and all mutations are **eventually consistent** (no read-your-write in tests/HV).

Each phase is labeled **(testable)** or **(HV-only)** per step so Red/Green is not misread as proving crash durability.

---

## Seams (cut points)

- `ReadingStore` / `ListIndexStore` / `ReadingClaim` consume `R2Bucket` (`reading-store.ts:88`, `list-index.ts:97`) → abstract to **`ObjectStore`**.
- `SimilarityStore` wraps `VectorizeIndex` (`similarity-store.ts:26`) → abstract to **`SimilarityBackend`**.
- The single `await queue.send(...)` (`attempt-activation.ts:72`) → **`jobRunner.submit`**.
- `src/index.ts` `queue()` handler + `dispatchQueueMessage` / `handleDeadLetter` → replaced by the in-process runner (`InProcessJobRunner`).
- Inject seams **once** via `Services`/`AppOptions` (`createApp` already takes `AppOptions`; `process-reading`/`activateAttempt` already take `Services`). The Node `Env` carries only string secrets — not `R2Bucket`/`VectorizeIndex`/`Queue`.

**Dual-target discipline:** through Phase 5 the codebase runs on BOTH targets. The `r2ObjectStore(bucket)` and `vectorizeBinding(index)` adapters keep every Workers-pool suite green against Miniflare (`test/unit/stores/**`, `test/integration/**`, `commit-terminal.test.ts`, `visibility.test.ts`, `mark-failed.test.ts`) while the Node-pool suites validate the S3/REST/runner implementations. The hard cutover (delete queue handler, drop `READING_JOBS`) lands only in the final cleanup phase, **after** prod soak.

**Edit-site inventory the plan owns (18 sites):** `new ReadingStore(c.env.READINGS_BUCKET)` ×11 (`router.ts:69,115,159,173,215,260,276,284,300`; `process-reading.ts:41,279`); `new SimilarityStore(...READINGS_INDEX)` ×2 (`router.ts:208`, `process-reading.ts:42`); `queue.send` ×1 (`attempt-activation.ts:72`); `READING_JOBS` 503 guard/read pairs ×4 (`router.ts:360/366, 493/499, 577/583, 635/641`). Injecting via `Services` collapses the 13 store sites to one factory.

---

## 1. Phase — ObjectStore seam + R2-over-S3 read path (tracer bullet)

- **a. (Red, node pool) (testable)** Define the `ObjectStore` interface and write a **parameterized shared contract suite** (run later against the in-memory fake, the `r2ObjectStore` adapter, and `S3ObjectStore`):
  - `get(key)` → `null | { body: ReadableStream; text(): Promise<string>; etag: string; uploaded: Date; contentType?: string }`. The streamable `body` + `contentType` are load-bearing: `GET /readings/:id/content` and `/content/raw` do `new Response(obj.body)` (`router.ts:292,306`; `reading-store.ts:145-169`).
  - `list({prefix, limit, cursor})` → **`{ objects: {key, uploaded}[]; truncated: boolean; cursor?: string }`**. This preserves the exact fields `rebuild()` branches on: it treats `truncated:true && !cursor` as an incomplete page (`complete=false`) and re-loops on `cursor` (`list-index.ts:208-212`). Contract tests: prefix filter, pagination across a `>limit` corpus returns every key, `uploaded` ordering, and a **completeness** case (complete scan reports complete; a truncated/partial scan is representable).
  - `delete(key)`; `put(key, body, opts)` deferred to Phase 2.
  - Tests assert **public behavior**, never the binding's `onlyIf`/`Headers` representation.
- **b. (Green, node pool) (testable)** Implement `InMemoryObjectStore` get/list/delete passing the contract. List must reproduce the truncated/cursor pagination shape so the fake is not lower-fidelity than reality at the pagination pivot.
- **c. (Refactor) (testable)** Change `ReadingStore`/`ListIndexStore`/`ReadingClaim` to take `ObjectStore` (constructed once and threaded via `Services`/`AppOptions`, replacing the 13 per-site `new ...(c.env.*)` constructions). Add `r2ObjectStore(bucket)` adapter so the entire Workers-pool suite stays green against Miniflare R2 — **state this explicitly: the adapter is what keeps `reading-store.test.ts`, `list-index.test.ts`, and the integration suite green until the Phase 6/cleanup cutover.**
- **d. (Red, node pool) (testable)** `S3ObjectStore` get/list/delete against the shared contract + a live opt-in test gated on `CORPUS_R2_*` (a **dedicated least-privilege token**, see Phase 6/secrets).
- **e. (Green, node pool) (testable)** Implement `S3ObjectStore` (aws4fetch). Requirements:
  - Normalize 404 → `null` on get.
  - **`list` parses `<LastModified>` into `uploaded` and maps `IsTruncated`→`truncated`, `NextContinuationToken`→`cursor`.** Do NOT reuse `scripts/lib/cf-clients.ts` `listKeys()` — it returns keys only, and worker code depends on `obj.uploaded` for ordering (`reading-store.ts:203,222,249`). Document that S3 never produces `truncated && !cursor`, so the completeness guard simply never trips on S3 — and assert that in the contract.
  - **ETag normalization (correctness-critical):** strip surrounding double-quotes and any leading `W/` from every ETag surfaced by get/put/list, so the value equals the binding's unquoted `R2Object.etag` that stores feed back into `If-Match` (`reading-claim.ts:138`, `list-index.ts:162`, `reading-store.ts:113,280`). Surfacing the raw quoted S3 ETag makes every later conditional replace 412 forever (CAS exhaustion → submits 503 under no real contention).
- **f. (Refactor) (testable)** `src/node/env.ts buildNodeEnv()` + `src/node/server.ts` (`@hono/node-server`, new dep) serving `createApp()`. Read routes only; write/submit routes return 503 for now. Target Node ≥20 so global `crypto` (`getRandomValues`, `subtle.digest`) works without an import. → **HV-1**

> **Risks & mitigations:** silent partial-index persist is as dangerous as a CAS bug — a truncated scan persisted over `index/list.json` clobbers live rows. Mitigated by preserving `truncated/cursor` in the interface (1a) and the >1000-object rebuild gate **HV-2b**.

---

## 2. Phase — conditional writes (CAS) over S3 [correctness-critical]

- **a. (Red, node pool) (testable)** Extend the **shared** contract suite with a **binding-neutral** conditional put: `put(key, body, { contentType?, precondition?: {kind:'create'} | {kind:'replace', etag} })`. The binding union (`{etagMatches}` object vs `new Headers({"If-None-Match":"*"})`) is translated **only** inside `r2ObjectStore` (1c); call sites and tests never see it. Contract cases:
  - Failed precondition → returns `null` (matches the binding contract all stores branch on: `list-index.ts:164-168`, `reading-store.ts:122-131,253-298`).
  - Clean create via `{kind:'create'}` returns a **non-null** object with a new etag (the `writeByUrlPointer` and absent-object `mutateListIndex` branches depend on the success path, not just 412→null).
  - **Etag round-trip:** `put` → capture returned etag → `replace` with **exactly** that etag → expect non-null/success; and `get` → etag **byte-identical** to the put's. Run against in-memory fake AND S3. The in-memory fake deliberately mints a **quoted/`W/`-prefixed** etag internally and strips on read, so it exercises the same normalization contract the S3 adapter must honor.
  - Concurrent-writer race.
- **b. (Green-fake) (testable)** `InMemoryObjectStore.put` enforces precondition, returns `null` on failure, surfaces the new etag, and honors the quoted-internal/stripped-surface convention.
- **c. (Red, node pool) (testable)** Same conditional contract against `S3ObjectStore` + a live race test.
- **d. (Green, node pool) (testable)** `S3ObjectStore.put` maps the neutral precondition to S3 `If-Match` / `If-None-Match: *`, maps 412 → `null`, parses and normalizes the response ETag (quotes + `W/` stripped).
- **e. (Refactor) (testable)** Confirm `mutateListIndex` CAS loop (`list-index.ts:161-168`) and `ReadingClaim` by-url claim (`reading-claim.ts:107-171`, including `PointerExistsError` create-race and `replaceByUrlPointerIfCurrent`) run unmodified over `ObjectStore`. Enable write routes (eager claim + pending write). → **HV-2, HV-2b**

---

## 3. Phase — Vectorize over REST

- **a. (Red, node pool) (testable)** Extract `SimilarityBackend` (`upsert`/`query`/`delete`); re-point fakes. Contract tests: `topK` clamp **1–50** — assert the **50 cap is intentionally the `returnMetadata:'all'` limit**, not arbitrary (REST rejects `topK>50` with metadata on; both real callers use 5 / schema-validated `k`); metadata mapping (`url/title/tags/created_at`); `WrongEmbeddingDimensionError` thrown client-side **before** any network call (1536 length guard, `similarity-store.ts:29-31,46-48` — ports unchanged).
- **b. (Green) (testable)** Keep the `vectorizeBinding(index)` adapter passing (Workers-pool suites stay green).
- **c. (Red, node pool) (testable)** `VectorizeRestClient` contract (stubbed fetch + live opt-in):
  - `query` → `POST .../v2/indexes/{index}/query`, `application/json` body `{vector, topK, returnMetadata:'all'}`, reads `result.matches[]` (`id/score/metadata`).
  - `upsert` → `POST .../upsert`, `application/x-ndjson`, one `{id,values,metadata}` per line.
  - `delete` → `POST .../delete_by_ids`, `application/json` `{ids:[id]}`. **This is net-new code** — the existing `scripts/lib/cf-clients.ts` client implements only upsert+query (corpus scripts delete via the wrangler CLI), so write a real delete contract test; do not assume reuse.
  - Bearer auth on all three. Tolerate looser `metadata: unknown` typing (the store already coerces with `typeof` guards).
- **d. (Green, node pool) (testable)** Implement `VectorizeRestClient` (v2 REST). Consider sharing one implementation with the script client (consistent with Phase 6c).
- **e. (Refactor) (testable)** Wire Node env to `SimilarityStore(new VectorizeRestClient(...))`. → **HV-3**

> **Risks & mitigations:** Vectorize REST upserts/deletes are **eventually consistent** (response is a `mutationId`; queryable "in a few seconds") — same model as the binding, so not worse on the home box. No test or HV step may assume read-your-write on Vectorize. HV-3 tolerates a few-seconds lag (see Appendix).

---

## 4. Phase — in-process async job runner (Queues replacement)

> Scope note: Phase 4 reproduces the **online** queue behaviors (concurrency, rate-limit backoff, DLQ-ceiling terminal fail, app-error ack). **Crash durability** (at-least-once across a process exit) is **not** a Phase 4 property — it is provided by Phase 5 boot-reconcile + drain. The verifiable claim is "Phase 4 + Phase 5 together reproduce the depended-on queue behaviors."

- **a. (Red, node pool) (testable)** Introduce a **`Scheduler`/`Clock` seam** (`{ nowMs(): number; setTimer(ms, fn): () => void }`) injected alongside `Services` (mirroring the existing injected `random`/`sleep` in the CAS loop). Provide a `FakeClock` that advances deterministically. Note: `services.now()` returns an ISO string and is the wrong primitive for delay math.
- **b. (Red, node pool) (testable)** `JobRunner.submit(args)`; `InProcessJobRunner` with a **controllable fake processor**. Assert concurrency by **observable behavior**, not by peeking a private semaphore: submit N+2 jobs each blocked on a test-controlled deferred; assert exactly N processors have *entered* (recorded by the fake), release one, assert the (N+1)th enters. Also assert FIFO-ish drain and that `process(args)` is invoked. (`max_batch_size=1` is implicit; no ordering guarantee is depended upon — last-writer-wins.)
- **c. (Green) (testable)** Semaphore-bounded pool (cap N = 3, the old `max_concurrency`).
- **d. (Red, node pool) (testable)** **Non-rate-limit error branch (correctness-critical, was missing):** when `process()` throws anything that is NOT a `RateLimitedError`, the runner logs and marks the job **done** — **no re-enqueue, no runner write, no delivery-counter increment, no DLQ-ceiling advance** — because `processReading` already wrote the failed manifest via `markFailed` (`process-reading.ts:194-203`; `index.ts:54-58`). Test asserts **exactly zero** additional manifest/list writes by the runner and no movement toward the ceiling. The two failure-write owners (process's `markFailed` vs the runner) stay disjoint.
- **e. (Green) (testable)** Implement the log-and-done branch.
- **f. (Red, node pool) (testable)** `RateLimitedError` reschedules after a delay honoring `Retry-After` (`e.retryAfterMs`) else exponential **30s doubling to a 300s cap**, with a 1s floor — **dropping** the 12h `QUEUE_MAX_DELAY_SECONDS` cap (a CF-only constraint). The attempt counter here is a **per-job DELIVERY counter** (the analog of CF `msg.attempts`, `index.ts:51`), incremented **only** on rate-limit reschedule, and **distinct** from the manifest `active_attempt.id`/`resolveAttemptId`. Assert the re-enqueue fires at the **exact computed delay** by advancing the `FakeClock` (never a real sleep); assert backoff doubling and `Retry-After` precedence on the scheduled delay value.
- **g. (Green) (testable)** Delayed re-enqueue via the scheduler, threading the delivery counter into the delay.
- **h. (Red, node pool) (testable)** Max-attempts ceiling → terminal fail: reuse `markDeadLettered` (retryable `failed` manifest). State and test the **never-loop / best-effort** guarantee (mirroring `handleDeadLetter`'s always-ack, `index.ts:67-77`): a throwing `markDeadLettered` is swallowed, never re-enqueued. Confirm `markDeadLettered`'s stale-active-ownership guard (`process-reading.ts:298`) is retained by reuse.
- **i. (Green) (testable)** Ceiling handler.
- **j. (Refactor) (testable)** Swap `attempt-activation.ts:72` `queue.send` → `jobRunner.submit`; thread the runner via `Services`. **Decision: `submit` stays fallible** (bounded backlog → throw), so the existing `QueueSendError` rollback funnel (`attempt-activation.ts:71-84`; `manifestForQueueSendFailure`, `retryable:true`) stays live. Add a Red test that a throwing `submit` rolls the slot back to a retryable `failed` manifest. Update the four `READING_JOBS` 503 guards (`router.ts:360/366,493/499,577/583,635/641`) to runner-availability guards. Migrate `activate.test.ts`'s file-local `captureQueue`/`rejectingQueue` (lines 30-45) to a capturing `JobRunner` stub. **Also re-point the other file-local fakes** the migration touches: `commit-terminal.test.ts:86-100`, `visibility.test.ts`, `mark-failed.test.ts:16-58` (the integration `install*` helpers are file-local, not shared). → **HV-4**

> **Note on idempotency:** the in-process runner is effectively exactly-once per submit (sole producer+consumer), a strict reduction in duplicate delivery. The `attemptOwnership` gates (`readingCanWriteAttemptArtifacts` `process-reading.ts:582-590`; `terminalWriteState` `538-580`) remain load-bearing under Phase 5 reconcile racing a concurrent reprocess — no queue-side dedup needs reproducing (the system never relied on it).

---

## 5. Phase — crash durability: boot reconciliation + graceful drain

> **The one durability invariant (state explicitly):** every pending manifest `activateAttempt` wrote (artifacts → manifest → by-id pointer → list row, all **before** submit) is recoverable by EITHER (a) `drain()` completing the in-flight job, OR (b) boot `reconcilePending` resubmitting it while within `PENDING_TTL_SECONDS`, OR (c) `stalenessOf` annotating it `failed` past TTL (still re-submittable via its surviving by-url claim). An abandoned not-started job depends entirely on (b)/(c).

- **a. (Red, node pool) (testable)** `reconcilePending(reader, runner, now, ttl)`: re-submit within-TTL pendings, leave past-TTL to `stalenessOf`. **Reuse the `attemptOwnership.isActive` gate** (the same guard `markDeadLettered` uses at `process-reading.ts:298`) so reconcile resubmits **only** pendings the runner owns the active attempt for. Fixture: a within-TTL pending owned by a **different** active attempt id is **left alone**. Fixture: an abandoned not-started job's pending manifest **is** picked up on the next boot (within TTL).
- **b. (Green) (testable)** Implement; call on boot.
- **c. (Red, node pool) (testable)** `drain()` as a **pure function** over an injected in-flight set + scheduler: it awaits tracked in-flight promises and refuses new submits; not-started jobs are abandoned. **No real SIGTERM in the unit test.**
- **d. (Green) (testable)** Wire a SIGTERM handler that calls `drain()`. The actual SIGTERM/`kill -9` process behavior is **HV-only** (HV-5).
- **e. (Doc) (testable assertion in 4j/HV-4)** Email semantics: a reconcile re-submit of an **already-ready** reading must NOT re-send email — the `attemptOwnership`/terminal-write gates prevent re-running the email path. Accept (document) that a crash **between** "ready written" and "email sent" silently drops the email (no queue redelivery; recoverable only via manual reprocess `email=true`) — same effective behavior as today's best-effort send (`process-reading.ts:243-256`). → **HV-4 sub-check, HV-5**

> **Risks & mitigations:**
> - **Clock dependency.** Both `MISSING_MANIFEST_OWNER_GRACE_MS` (`reading-claim.ts:22,187-192`) and `stalenessOf` now lean on a single host's wall clock. A backward NTP jump could make a fresh pointer look stale or a stale pending look fresh. Mitigation: require NTP-synced host; assume monotonic-enough wall time; one-line operator note.
> - **Boot reconcile vs offline batch.** Boot reconcile inherits the corpus-ingest "sole writer for those URLs" constraint: `corpus-ingest`/`corpus-recover --batch` write the by-url pointer only on success, leaving URLs unclaimed during the in-flight batch window. A boot resubmit of a within-TTL pending for a URL an offline batch is about to write races the documented duplicate window. Mitigation: the home box is the **sole online writer**; batch ingest is an **offline exclusive** operation (service paused/drained) — see Phase 6c.

---

## 6. Phase — Node config/ops + corpus-client refactor (non-destructive)

> Destructive deletion of the CF queue harness is deferred to **Phase 9 (cleanup)** so the Worker stays a working rollback target until after prod soak.

- **a. (Red→Green, node pool) (testable)** `buildNodeEnv()` parsing/validation with the **complete required-env inventory** (missing any one fails boot, non-zero exit):
  - Existing: `READER_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY` (optional), `EMAIL_FROM`, `EMAIL_TO`, `WEB_BASE_URL`, `PENDING_TTL_SECONDS`, `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES`, `ANTHROPIC_MODEL`, `RETRY_*`.
  - CORS: decide in Phase 7 whether `CORS_ALLOWED_ORIGINS` stays required.
  - **New:** R2 S3 creds (account id + access key + secret, scoped to the prod bucket) and Vectorize REST creds (account id + index + scoped bearer token).
  - `R2Bucket`/`VectorizeIndex`/`Queue` are **removed** from the Node `Env` type (replaced by injected seams) so Workers ambient types stop leaking into the Node build.
- **b. (Refactor) (testable)** Refactor `corpus-*` (audit/recover/drop/ingest) onto the new `S3ObjectStore` + `VectorizeRestClient`. **Keep `CORPUS_R2_*`.** The by-url/by-id pointer JSON shape and the same-`id`/`url`/`url_hash` ownership match (`ownedManifestMatches` `reading-claim.ts:178-185`) must stay **byte-compatible** so online claims and offline ingest agree on ownership. Add a `delete` to the shared Vectorize client (corpus delete currently shells out to wrangler).
- **c. (Refactor) (testable)** **HTTP-import scripts inventory** (`reddit-import.ts`, `youtube-import.ts`, `import-bookmarks.ts`, `import-markdown.ts` — these speak HTTP, NOT R2/Vectorize, so they are not covered by 6b): update `import-markdown.ts`'s hardcoded `http://127.0.0.1:8787` default to the configurable Node server port/origin; confirm `reddit/youtube --api-url` defaults still resolve `reading-lite.bbell.dev` through the tunnel; define what "staging" means once the staging Worker is gone (point at the home box or a local Node instance).
- **d. (Doc) (testable note)** Coordination rule (the always-on home box changes the corpus "sole writer" premise): corpus batch tools run with the realtime service **paused/drained**, OR a follow-up makes `corpus-ingest` claim the by-url slot eagerly at submit. Pick one and document it. → **HV-6**

---

## 7. Phase — ingress (Cloudflare Tunnel) + SPA serving + edge hardening

- **a. (Red) (testable)** Same-origin static SPA serving + routing-order tests (the SPA uses `window.location.origin`, so same-origin retires the browser CORS path):
  1. `GET /health` → 200 **without** auth (stays public, registered before `requireBearer`).
  2. `GET /readings` without auth → **401** (NOT the SPA index).
  3. `GET /some/deep/spa/route` → `index.html` 200 (deep-link refresh).
  4. `GET /assets/*` → the built asset.
  - Pin middleware ordering so the static catch-all cannot shadow `/health` or auth-gated `/readings*`.
- **b. (Red→Green) (testable)** **CORS decision:** with same-origin serving the browser CORS path is dead. Either (a) keep `middleware.ts` for non-browser cross-origin callers and keep `CORS_ALLOWED_ORIGINS` a required Node env var `buildNodeEnv` validates, or (b) remove the middleware and drop `CORS_ALLOWED_ORIGINS` from `Env`/`buildNodeEnv`. Add a test that a same-origin request succeeds with **no** allowlist entry (today an OPTIONS preflight from an unlisted origin 403s — confirm the SPA path never hits it).
- **c. (Red→Green) (testable)** **Inbound body-size limit + slow-request timeout** on the Node server (Workers' implicit ~100MB body cap is gone; `FETCH_MAX_BYTES` only bounds **outbound** extractor fetches). Add Hono `bodyLimit` sized to the largest legitimate markdown import and a header/read timeout. Test: an over-limit `POST /readings/import-markdown` → **413**, not buffered to OOM.
- **d. (Green) (testable)** Static middleware after API routes; `cd web && npm run build`.
- **e. (Ops) (HV-only)** `cloudflared` maps `reading-lite.bbell.dev` → `localhost`, run as its **own supervised service** (systemd unit + restart). **Cloudflare Access is REQUIRED** (not optional) in front of `/readings*` — `POST /readings` triggers paid Anthropic+OpenAI calls and the box now terminates all abuse/DoS directly (no Workers edge in front; `requireBearer` has no failed-auth throttling). Keep `/health` public; consider a WAF rate-limit rule and/or failed-auth backoff. → **HV-7, HV-8**

> **Decision/HV note (residential egress):** the home box egress is likely residential, so the in-worker extractor *may* now fetch Reddit `.json` / YouTube watch pages directly, potentially simplifying `RedditManualImportError` / the YouTube oEmbed-floor degradation. **Do not** change extractor behavior in this migration — record an HV-4 bonus check (Appendix) and defer any simplification to follow-up work.

---

## 8. Phase — ops hardening (supervision, secrets, observability, backup)

> Folded in as blocker/major ops issues; sequenced so the safety controls exist **before** the prod cutover.

- **a. (Ops, prereq for HV-5)** **Process supervision.** Run the Node server under systemd: `Restart=on-failure`, `RestartSec` backoff, `StartLimitIntervalSec`/`StartLimitBurst` to cap crash-loops (a bad reconcile must not hot-loop and hammer Anthropic/OpenAI), `MemoryMax`, `EnvironmentFile=`, optional `WatchdogSec`. Without this, Phase 5 boot-reconcile never fires after a crash.
- **b. (Ops, prereq for HV-2)** **Secrets.** Env file at a fixed path (e.g. `/etc/reading-lite/env`), `0600`, service-user owned, `EnvironmentFile=`, **gitignored**. Mint a **dedicated least-privilege R2 S3 token** scoped to ONLY the prod bucket (object read/write, NOT account-wide) and a **Vectorize-scoped** API token (NOT a global CF token, NOT the broad `CORPUS_R2_*` operator keys). `buildNodeEnv` fails fast on any missing required secret.
- **c. (Ops)** **Observability.** Structured logs to journald with rotation/retention; `/health` reports runner depth / in-flight count / last-successful-process timestamp / storage reachability (replacing the now-gone DLQ-as-inspectable-queue — `corpus-audit` enumerates failed/stuck readings as the DLQ-inspection replacement); at least one external alert (tunnel-URL uptime check + process-down/health-degraded alert). Decide that the rate-limit ceiling terminal-fail (4h) and email-send failures emit a **distinguishable** log line an operator can alert on.
- **d. (Ops, prereq for HV-2)** **Backup.** Enable R2 bucket versioning OR a periodic export of `index/list.json` + by-url pointers (small, cheap) so a bad `rebuild`/`delete` is recoverable — the migration re-implements `delete` + `rebuild` over S3 with no platform undo. Add a contract test that `S3ObjectStore.delete` and Vectorize `delete_by_ids` operate on **exactly** the intended key/id and never a prefix-wildcard. → **HV-5, HV-8**

---

## 9. Phase — prod cutover + CF harness cleanup (destructive; LAST)

> **Rollback gate:** the Worker stays fully functional (queue handler + `wrangler.toml` queue config intact) until AFTER prod soak. Destructive deletion happens only here, after HV-8 confirms health.

- **a. (Cutover, HV-only)** **Exactly-one-writer cutover (split-brain prevention).** In a single atomic change: (1) drain the existing Cloudflare Queue to empty (or accept its in-flight messages will be re-driven by Phase 5 boot reconcile) and remove the consumer; (2) flip `reading-lite.bbell.dev/readings*` **off** the Worker; (3) bring the tunnel up to the home box. Invariant: exactly one compute owns prod R2/Vectorize at any instant. The CAS gates prevent corruption but NOT duplicate compute, duplicate emails, and pointer thrash if both run.
- **b. (Soak, HV-only)** Soak on prod via the tunnel. **Rollback path:** re-point the `/readings*` route back to the Worker and re-deploy (Worker + queue infra still exist, can drain and process).
- **c. (Red→Green, after soak) (testable)** Delete `queue()` handler, `dispatchQueueMessage`, `handleDeadLetter`, the DLQ branch; remove `READING_JOBS` from `Env`. `markDeadLettered` **core stays** (reused by the runner ceiling). Strip queue blocks from `wrangler.toml`; deprecate `deploy`/`staging` scripts. → **HV-8 (final)**

---

## 10. Phase — (deferred/optional) retire `list.json` CAS into SQLite

Out of scope for the migration; revisit only if list-index CAS contention becomes a problem on the single box.

---

## Appendix A — Human-verification (HV) checkpoints

Run HV-1 through HV-6 against **staging**; touch prod only at HV-8.

- **HV-1 — Node read path vs real R2.** Boot the Node server (read routes only) against the staging bucket via S3; confirm list/detail/content-stream parity with the Worker, including `obj.body` streaming and `contentType`.
- **HV-2 — Conditional-write race vs real R2 (CORRECTNESS GATE).** Concurrent by-url claim + list CAS against real R2-over-S3. **Explicitly assert the etag round-trip:** a put-returned etag is accepted verbatim by a later `If-Match` and equals a subsequent get's etag (catches the quoted-ETag fail-closed bug). Prereq: backup (8d) in place.
- **HV-2b — >1000-object rebuild vs real R2-over-S3 (CORRECTNESS GATE).** Force a `rebuild()` over a bucket with >1000 manifests; assert the rebuilt index is **complete** (every key across all pages) OR refuses to persist on a truncated scan — never silently persists a partial index over `index/list.json`.
- **HV-3 — Vectorize REST vs real index.** Upsert/query/delete over v2 REST. **Tolerate eventual consistency** (a freshly-upserted vector takes a few seconds to become queryable — no read-your-write assertion). Sub-check: a `remove()` on the **failure path** leaves the vector intact (success/failure asymmetry preserved over REST); a success-path delete eventually clears it (with a few-seconds tolerance).
- **HV-4 — End-to-end real submit (paid).** Full pipeline on the home runtime. Sub-checks: rate-limit backoff reschedules (observe a 429 retry); a non-rate-limit failure lands a single failed manifest (no double write); a reconcile re-submit of an already-ready reading does **not** re-email. **Bonus:** confirm whether residential egress lets the extractor fetch Reddit `.json` / YouTube watch pages directly (record only; no code change).
- **HV-5 — Crash/restart durability.** Under systemd (8a): `SIGTERM` drains in-flight to completion; `kill -9` mid-process strands a pending, then systemd restarts and boot `reconcilePending` re-submits the within-TTL pending end-to-end. Confirm a crash-loop is capped by `StartLimitBurst`. Confirm a bad `S3ObjectStore.delete`/`rebuild` is recoverable from the 8d backup.
- **HV-6 — Clean cutover build + corpus tools.** `npm test` + `npm run typecheck` green on the dual-target tree; `corpus-*` (R2/Vectorize) and HTTP-import scripts run against the home box; confirm the corpus pointer JSON stays byte-compatible with online claims.
- **HV-7 — SPA same-origin browser.** SPA served same-origin (no CORS), deep-link refresh returns `index.html`, `/readings*` bearer-gated, `/health` public, over-limit POST → 413.
- **HV-8 — Public ingress + prod cutover (FINAL).** Tunnel off-network; Cloudflare Access in front of `/readings*`; exactly-one-writer cutover executed atomically (9a); prod soak (9b); backup/versioning confirmed; rollback path verified available **before** the Phase 9c destructive cleanup.
