# 016 — Local Extraction Agent (poll-driven fallback extractor)

A one-shot Node CLI (`npm run extract-agent`) that runs on the home box on a
timer, polls the reading-lite API for readings whose extraction failed or
degraded in the Worker, re-extracts them locally (residential IP, browser
headers, optional headless render), and re-submits the markdown through the
existing API. All summarize/embed/vectorize work stays in the Worker. This
supersedes the dropped full home-server migration (plan 015).

## Goal

- Automatically convert `failed` readings whose failure was at the
  `fetch_source` stage (bot-blocks, timeouts, Reddit/oversized) into `ready`
  readings, unattended.
- Automatically upgrade quality-degraded READY readings: `raw_only` (JS
  shells Readability couldn't extract statically) and thin YouTube
  floor-only readings (no description/transcript).
- Zero new Cloudflare infrastructure. One Worker API extension total.

## Non-goals

- No first-class / synchronous delegation (Worker → home push, tunnels,
  Funnel). Deliberately deferred; the agent's run logs are the evidence base
  for that later decision.
- No queue consumers (the DLQ never sees ordinary extraction failures —
  `src/index.ts:53-57` acks them after writing the failed manifest).
- No R2/Vectorize/Anthropic/OpenAI access from the home box. The agent is a
  plain authenticated API client; the only secret it holds is
  `READER_API_TOKEN` (plus an optional healthcheck ping URL).
- No Reddit credentials (no OAuth app, no stored login). Anonymous fetch or
  skip-for-manual.
- No changes to realtime submit/queue behavior; the Worker keeps trying
  first, exactly as today.

## Current-system observations (verified)

- Extraction failures write a failed manifest with `error.stage:
  "fetch_source"` and ack (`src/index.ts:42-59`); the durable "needs local
  extraction" signal is the manifest/list row, not any queue.
- `GET /readings` supports only `q/tag/offset/limit`
  (`ListReadingsQuerySchema`); the agent pages the full list and filters
  client-side. List rows (`manifestToIndexItem`,
  `src/modules/stores/list-index.ts:51-71`) carry `status`, `error`
  (code/message/stage), `active_attempt`, `last_attempt` — but **not**
  `content_status`. Failed-row eligibility is decidable from the list alone;
  `raw_only` detection needs a per-reading detail GET (memoized, see sidecar).
- `POST /readings/import-markdown` reprocesses **failed** owners in place but
  no-ops (200, existing manifest) for ready/pending owners
  (`src/router.ts:457-475`). So the failed path needs zero Worker changes.
- `POST /readings/:id/reprocess` body is `{force?, email?}` only
  (`src/schemas/api.ts:34-40`). `enqueueReprocess` (`src/router.ts:481`)
  already synthesizes a markdown `ProcessReadingSource` from stored extracted
  content when `manifest.source_type === "markdown"` — the natural extension
  point for a request-supplied markdown source. Ready readings get
  `preserveReadyManifest`, so a failed upgrade attempt rolls the reading
  forward to its previous ready state, not to failed.
- The pipeline already consumes markdown sources (`prepare_markdown` stage,
  `src/process-reading.ts:389-397`); only the HTTP surface can't express
  "reprocess this ready reading with this markdown".
- The shared extractor (`src/modules/extractor/index.ts`) is Node-clean
  (linkedom/Readability/Turndown, global `crypto.subtle`, `TextDecoder`).
  `extractFromUrl` performs the SSRF guard (`assertSafeUrl`) internally and
  accepts injected `fetch` — tier 1 reuses it via `makeBrowserFetch`
  (`scripts/corpus-lib/browser-fetch.ts`). **But the guard checks only the
  initial URL, and `makeBrowserFetch` hardcodes `redirect: "follow"`** — on
  the Worker, Cloudflare blocks private-IP egress at the platform level, so
  a public→LAN redirect was never exploitable there; the home box has no
  such backstop. The agent therefore needs its own redirect-hop-checking
  fetch wrapper (Phase 1g/h) — the "inherits the guard by construction"
  shortcut is NOT sufficient. The blocked-host predicate
  (`isBlockedHostname`, `src/modules/extractor/index.ts:356-373`) is
  currently module-private and must be exported for reuse.
- `readabilityFromHtml` internally falls back to a raw-DOM salvage path
  without signaling which path produced the markdown
  (`src/modules/extractor/index.ts:244-264`) — the upgrade gate needs that
  signal (salvaged soup must not replace `raw_only`).
- Reusable Node-side machinery: `scripts/corpus-lib/api.ts`
  (`importMarkdown`, `reprocessReading`, `lookupReading`),
  `reason.ts` (`httpStatusFromMessage`, `reasonForFailure`), `policy.ts`
  (the recover triage table — the template for the agent's policy),
  `throttle.ts`, `scripts/lib/dotvars.ts` (env-file loading),
  `scripts/reddit-import-lib/parse.ts` (`redditListingToMarkdown`),
  `scripts/youtube-import-lib/parse.ts` + `scripts/youtube-import.ts`
  (watch-page metadata + yt-dlp transcript).
- YouTube floor-only content heuristic: `buildYoutubeMarkdown`
  (`src/modules/extractor/youtube.ts:248-268`) emits `## Transcript` only
  when a transcript exists and a bare description paragraph otherwise —
  "markdown has neither a `## Transcript` section nor a description block" is
  detectable from `GET /readings/:id/content`.
- Test layout: `vitest.workspace.ts` — Node-pool globs are explicit; a new
  `test/unit/extract-agent/**` glob is required. Worker-side changes test in
  the Workers pool (`test/integration/**`, `test/unit/schemas/**`).
- Working tree: `plans/015-home-server-migration.md` is untracked and
  superseded — delete it when this plan lands (its dropping is already
  committed upstream as 359051f).

## Architecture

```
scripts/extract-agent.ts            CLI entrypoint (dry-run default, --execute)
scripts/extract-agent-lib/
  config.ts        env/.extract-agent.vars parsing, caps, paths
  poll.ts          GET /readings pager + client-side eligibility filter
  policy.ts        per-error-code decision table (attempt / never / manual)
  sidecar.ts       local attempt-state store (JSON file, atomic write)
  gates.ts         per-category upgrade gates + paid-action budget
  safe-fetch.ts    redirect-hop-checking fetch wrapper (LAN SSRF guard)
  static-tier.ts   tier 1: extractFromUrl + makeBrowserFetch(safeFetch)
  headless-tier.ts tier 2: Playwright render → Readability (lazy import)
  reddit.ts        anonymous .json fetch → redditListingToMarkdown
  youtube.ts       youtube-import path reuse (metadata + yt-dlp)
  submit.ts        importMarkdown (failed) / reprocess-with-source (ready)
  run.ts           orchestrator: plan → act → report
  report.ts        structured run summary + dead-man ping
test/unit/extract-agent/**          Node-pool tests
```

Data flow per run: acquire lockfile → load sidecar → page list → classify
rows into a plan (attempt/skip-with-reason) → for each attempted row: tiered
extract → gate → submit → update sidecar → write run report → ping
healthcheck → release lock.

## Config & secrets

`.extract-agent.vars` (dotvars format, `0600`, gitignored) or env:

- `READING_API_URL` (e.g. `https://reading-lite.bbell.dev`) — staging URL for
  verification runs.
- `READER_API_TOKEN` — the only credential.
- `HEALTHCHECK_URL` — optional dead-man ping.
- `AGENT_MAX_PAID_ACTIONS` (default 25), `AGENT_MAX_ATTEMPTS` (default 3),
  `AGENT_FETCH_MAX_BYTES` (default 20 MiB — deliberately above the Worker's
  cap so `OversizedResponseError` rows are recoverable),
  `AGENT_MIN_ARTICLE_CHARS` (default 350; the size **ceiling** is not an
  env knob — it is `MARKDOWN_IMPORT_MAX_BYTES` imported from
  `scripts/import-markdown-lib/parse.ts`, see gates),
  `AGENT_STATE_PATH` (default `~/.reading-lite/extract-agent.state.json`),
  `AGENT_EMAIL` (default false — pass-through to the API `email` flag).

## Eligibility & policy

A row is **eligible** only if all of:

1. `status === "failed"` with `error.stage === "fetch_source"`, OR
   `status === "ready"` and flagged degraded (Phase 6+; needs detail GET).
2. Not pending and no `active_attempt.status === "running"` (never race an
   in-flight Worker attempt; the API would no-op anyway — don't spend
   renders).
3. Sidecar says attemptable, per this decision table (pinned by Phase 1e
   tests):
   - manifest `updated_at` **newer** than the sidecar's
     `last_manifest_updated_at` → the Worker acted since we last did: reset
     `attempts`/backoff, clear `given_up`, re-classify from scratch;
   - **equal** → honor backoff (`next_eligible_at`) and the
     `attempts < AGENT_MAX_ATTEMPTS` / `given_up` ceilings;
   - **older** (clock skew, list rebuild) → treat as equal.

Failed rows whose error does not carry `stage: "fetch_source"` — notably
staleness-annotated strandings (`stalenessOf` surfaces `failed` without a
write) and DLQ-marked rate-limit exhaustions — are **out of scope by
design**: they are Worker-recoverable via reprocess/corpus-recover, and
local extraction adds nothing. Why the stage filter excludes them is
subtler than it looks and worth pinning: the manifest's
`active_attempt.stage` is written once at activation as `"queued"` and is
**never advanced mid-run** (`runStage` writes only the attempt log, not the
manifest — `src/process-reading.ts:679-686`). An ordinary processing
failure stamps the true stage from the in-memory attempt, so real fetch
failures do carry `error.stage: "fetch_source"`; but stale annotations and
`markDeadLettered` derive their stage from the manifest summary and
therefore always carry `"queued"`. The run report counts these as
`out_of_scope` rather than hiding them, so an implementer must not "fix"
the filter to include them — and a Phase 1c policy case pins a
`stage: "queued"` stale/DLQ row as excluded.

Policy table (modeled on `corpus-lib/policy.ts` `recoveryAction`, new module
so recover semantics are untouched):

| Failure                                        | Decision            |
|------------------------------------------------|---------------------|
| `BadStatusError` 404/410                       | never (dead link)   |
| `BadStatusError` 401/402/451, teaser overrides | never (paywall)     |
| `BlockedHostError`                             | never (SSRF guard fired; do NOT retry from inside the LAN) |
| `BadStatusError` 403/429                       | attempt (tier 1 → 2)|
| `FetchTimeoutError`, `BadStatusError` 5xx      | attempt (tier 1 → 2)|
| `OversizedResponseError`                       | attempt (tier 1, raised byte cap) |
| `RedditManualImportError` / reddit URL         | attempt (reddit path); challenge → manual |
| YouTube URL (failed)                           | attempt (youtube path) |
| "not an article / PDF" reasons                 | never               |
| anything else at `fetch_source`                | attempt (tier 1 → 2)|

Rows classified `never`/`manual` are listed in the run report with reasons —
`manual` rows are the reddit-import/youtube-import skill queue.

## Sidecar state

JSON file, versioned, written atomically (tmp + rename), keyed by reading id:

```jsonc
{
  "version": 1,
  "readings": {
    "rd_x": {
      "attempts": 2,
      "last_attempt_at": "…",
      "last_manifest_updated_at": "…",   // manifest state we last acted on
      "last_outcome": "challenge|imported|upgraded|gate_rejected|error",
      "next_eligible_at": "…",
      "given_up": false,
      "content_status": "raw_only",       // memoized detail-GET verdict
      "youtube_thin": true,                // memoized content-GET thinness verdict
      "content_checked_updated_at": "…"   // both memos valid while manifest unmoved
    }
  }
}
```

Loss of the sidecar is safe by design: the worst case is re-attempting and
re-hitting gates/caps; the paid-action cap bounds the damage of a rebuilt
box. The sidecar is also the memo for `content_status` detection so each
ready reading costs at most one detail GET per manifest change.

## Upgrade gates & spend budget

Every submit (import or reprocess) triggers paid Anthropic + OpenAI calls, so:

- **Global**: hard cap of `AGENT_MAX_PAID_ACTIONS` submits per run; the
  `corpus-lib` throttle between all API calls and outbound fetches. When the
  cap truncates the plan, the report says how many eligible rows were
  deferred (no silent truncation).
- **Size ceiling on every submit**: markdown byte length ≤
  `MARKDOWN_IMPORT_MAX_BYTES` (128 000, imported from
  `scripts/import-markdown-lib/parse.ts:26` — single-homed, no copies),
  else `gate_rejected`. This is a *queue* constraint, not a summarize one:
  both submit paths inline the markdown in the `ProcessReadingArgs` queue
  message (import-markdown via `activateAttempt`, and the Phase 5 reprocess
  extension rides the same args), and Cloudflare Queues caps messages at
  128 KB. The repo already enforces this client-side for
  `import-markdown`/`corpus-ingest`/`youtube-import`; the agent reuses the
  same constant, minus the envelope headroom `youtube-import-lib` already
  reserves for the non-markdown fields of the message
  (`QUEUE_ENVELOPE_RESERVE` in `scripts/youtube-import-lib/parse.ts` —
  export it rather than minting a copy). An over-cap submit wouldn't
  corrupt anything (queue-send rollback fires) but would burn an attempt on
  a guaranteed failure and leave a confusing run error.
- **failed → captured**: markdown ≥ `AGENT_MIN_ARTICLE_CHARS` after trim.
- **raw_only → captured**: Readability proper returned the article from the
  rendered DOM (NOT the salvage path) and length ≥ threshold.
- **YouTube floor-only**: upgrade only if a transcript or description was
  actually obtained.
- The gate for ready-reading upgrades is deliberately conservative: a
  rejected gate costs nothing; a bad upgrade costs money and pollutes a
  working reading.

## Phases (TDD; every slice is red → green → refactor)

Verification loop for every slice unless stated: `npm run test:quiet --
test/unit/extract-agent` (Node pool) and `npm run typecheck`. Worker slices:
`npm run test:quiet` (full) since integration tests are Workers-pool.

### Phase 0 — scaffolding

a. Add `test/unit/extract-agent/**/*.test.ts` to the Node-pool globs in
   `vitest.workspace.ts`; add `extract-agent` npm script; create
   `scripts/extract-agent-lib/`. (Red) `npm run test:quiet --
   test/unit/extract-agent` exits non-zero ("no test files found") before
   the glob + placeholder spec land; green after.
b. Dependency decision (made now, not mid-phase): **Playwright is a
   devDependency** so `npm run typecheck` (which covers `scripts/**`) can
   resolve its types on every machine; browsers are installed only on the
   home box (`npx playwright install chromium` — documented in Phase 8).
   The Worker bundle is unaffected (wrangler bundles from `src/` only, and
   the import is lazy inside `scripts/extract-agent-lib/`).

### Phase 1 — tracer bullet: failed rows, static tier, import-markdown

Zero Worker changes; end state is a runnable `npm run extract-agent --
--dry-run` against staging that plans (and with `--execute` performs) a real
failed→ready recovery.

a. **(Red)** `poll.ts`: pager spec against a stubbed `fetch` — pages
   `GET /readings?offset&limit` until `has_more` is false, concatenates rows,
   sends the bearer header, surfaces non-200 as a run-fatal error.
b. **(Green)** Implement pager (mirror `corpus-lib/api.ts` conventions;
   injected `fetch` + throttle).
c. **(Red)** `policy.ts`: table-driven spec, one case per row of the policy
   table above, including: pending rows and rows with a running
   `active_attempt` are ineligible; `BlockedHostError` is `never`;
   stale-annotated and DLQ-marked rows (`stage: "queued"` — their real
   shape, per the eligibility section) are `out_of_scope`; reddit/youtube
   routing keys off URL as well as error code (reuse
   `httpStatusFromMessage`).
d. **(Green)** Implement `classify(row) → {decision, why, route}`.
e. **(Red)** `sidecar.ts`: load-missing→empty; atomic save; attempt
   record/backoff math (`next_eligible_at` doubles per failure); give-up at
   `AGENT_MAX_ATTEMPTS`; corrupted file → treated as empty with a warning
   (loss-safe invariant). Inject `now`.
f. **(Green)** Implement.
g. **(Red, Workers pool)** Export the blocked-host predicate: unit spec in
   `test/unit/extractor` for an exported `isBlockedHost(hostname)` covering
   the v4 ranges, v6 (`::1`, ULA, link-local, v4-mapped), `localhost`,
   `.local` — behavior identical to today's private rules; existing
   extractor tests stay green (pure visibility refactor of
   `src/modules/extractor/index.ts:356-373`).
h. **(Red, Node pool)** `safe-fetch.ts` — the LAN SSRF guard `assertSafeUrl`
   cannot provide (it checks only the initial URL, and the Worker relied on
   Cloudflare blocking private egress; the home box has no backstop). Spec
   against an injected base fetch: (1) requests use `redirect: "manual"` and
   the wrapper follows hops itself, re-running `isBlockedHost` on every
   `Location` — a 302→`http://192.168.1.1/` fixture is rejected and the
   second fetch never fires; (2) hop ceiling (5) → structured error;
   (3) per-hop resolved-IP check via an injected `lookup` (dns.lookup shape):
   a public hostname resolving to `10.0.0.5` is rejected before connecting;
   (4) a clean public chain passes through transparently (final response
   returned, so `extractFromUrl` sees no 3xx). DNS-rebinding TOCTOU (re-
   resolution between check and connect) is an **accepted residual risk**,
   documented in the module header — URLs are self-submitted through an
   authed API, and closing it needs a custom undici connect hook that is not
   worth v1 complexity.
i. **(Green)** Implement `safeFetch(base, {lookup, maxHops})`; ALL agent
   egress — tier 1, tier 2 is browser-managed (Phase 3 handles it), Reddit
   `.json`, YouTube oEmbed/watch/timedtext — goes through it.
j. **(Red)** `static-tier.ts`: with an injected `fetch` serving fixture HTML,
   returns `{markdown, title, extractor: "readability"}`; a 403 fixture maps
   to a `challenge` outcome (not a throw); a `192.168.x.x` URL is rejected
   with zero fetch invocations (`assertSafeUrl` inside `extractFromUrl` plus
   the safe-fetch layer — belt and suspenders).
k. **(Green)** Implement as a thin composition: `extractFromUrl(url, {fetch:
   makeBrowserFetch(safeFetch(fetch)), timeoutMs, maxBytes:
   AGENT_FETCH_MAX_BYTES})`, mapping extractor errors → structured outcomes
   (`challenge`, `dead`, `error`). Note `makeBrowserFetch` passes
   `redirect: "follow"` in init — `safeFetch` must own redirect handling
   regardless of caller init (override, don't trust).
l. **(Red)** `gates.ts` + `run.ts` orchestration spec with everything
   stubbed: given a list of rows, produces a plan; in dry-run performs zero
   submits/fetches-with-side-effects; with execute, respects
   `AGENT_MAX_PAID_ACTIONS` (11 eligible, cap 10 → 10 submits + 1 reported
   deferral); gate rejects short markdown AND over-ceiling markdown (a
   markdown of exactly `MARKDOWN_IMPORT_MAX_BYTES` bytes and one of 129 KB
   both → `gate_rejected`, zero submits — pinned against the imported
   constant, not a literal); a submit `error` outcome records a sidecar
   attempt.
m. **(Green)** Implement `run.ts` + `submit.ts` (failed rows →
   `importMarkdown` from `corpus-lib/api.ts`), CLI arg parsing
   (`--dry-run`/`--execute`, `--limit`, `--only <id|url>` for surgical runs).
n. **(Refactor)** Factor shared fixtures; ensure every module takes injected
   `fetch`/`now`/`lookup`/fs-path deps per repo convention (no global
   reaches). Note the pager uses offset pagination over a mutable list —
   rows can be skipped or duplicated across a mutation window; harmless
   (server-side idempotency + next run catches skips), but the pager spec
   must not promise exactness.

→ **HV-1**: against staging, seed a genuinely bot-blocked URL — pick a
`BadStatusError` 403 row from a fresh `corpus-audit` of production (or
re-submit its URL to staging), after confirming from the home box that a
browser-UA `curl` fetches it successfully (this pins "blocked for
datacenter, open for residential" — a URL that 403s everyone would leave
HV-1 unfalsifiable). Run the agent dry-run (plan shows it), then
`--execute`; confirm the reading lands `ready` and the run report records
one import.

### Phase 2 — run report, dead-man ping, lockfile

a. **(Red)** `report.ts`: a completed run appends one JSON line
   (scanned/eligible/out_of_scope/attempted/imported/upgraded/gate_rejected/
   manual/deferred/errors + per-row outcomes) to the run log; pings
   `HEALTHCHECK_URL` exactly once on successful completion, never on a
   crashed run (assert via injected fetch); no ping URL configured → no
   fetch.
b. **(Red)** lockfile: second concurrent run exits cleanly with a "already
   running" report and no side effects; a stale lock (dead pid / age >
   ceiling) is broken with a warning.
c. **(Green)** Implement both. **(Refactor)** wire into `run.ts` so the ping
   is the final statement of a successful run.

### Phase 3 — headless tier (Playwright) for JS shells and challenges

a. **(Red)** Extractor refactor spec (Workers pool, existing
   `test/unit/extractor`): export a variant of `readabilityFromHtml` that
   reports which path produced the article —
   `{markdown, title, salvaged: boolean}` — with existing behavior and
   existing tests unchanged (pure refactor of
   `src/modules/extractor/index.ts:244-264`; the Worker's callers ignore the
   new field).
b. **(Green)** Implement the export; run the full Workers-pool suite.
c. **(Red)** `headless-tier.ts` (Node pool, Playwright faked behind an
   injected `renderPage(url, {routeFilter}) → {html, finalUrl}` seam):
   renders, runs the exported Readability path on rendered HTML, returns
   `{markdown, title, salvaged}`; **SSRF**: initial URL and `finalUrl`
   (post-redirect) both re-checked against `isBlockedHost` — a render that
   lands on a private host is discarded.
d. **(Red)** The route filter itself is a real, exported function (not just
   a recorded mock): `shouldAbortRequest(requestUrl) → boolean` unit-tested
   directly against `isBlockedHost` cases (private subresource → abort;
   public → continue; non-http(s) scheme → abort). The real `renderPage`
   registers it via Playwright `page.route()`.
e. **(Green)** Implement. Playwright is a lazy `await import("playwright")`
   inside the real `renderPage` only (devDependency per Phase 0b; browsers
   home-box-only). Rendering-time DNS rebinding shares the safe-fetch
   residual-risk stance.
f. **(Red)** `run.ts` tiering: tier 2 fires only when tier 1 returned
   `challenge` or produced no/salvaged-only article AND the row's policy
   route allows it; tier-2 failure falls back to sidecar attempt bookkeeping.
g. **(Green/Refactor)** Wire in; `isBlockedHost` imported from the extractor
   module everywhere (safe-fetch, headless route filter) — no copies.

→ **HV-2**: a real JS-shell URL (from a prior `raw_only` case) extracts via
tier 2 on the home box; a `192.168.1.1` URL is refused end-to-end.

### Phase 4 — Reddit (anonymous, skip-on-challenge)

a. **(Red)** `reddit.ts`: fixture thread `.json` → markdown via
   `buildRedditImport` from `scripts/reddit-import-lib/parse.ts` (the CLI's
   wrapper over the shared `redditListingToMarkdown` — reuse it, not the raw
   parser, so title/URL shaping matches the skill byte-for-byte; pin with a
   fixture shared with `test/unit/reddit-import`); a 403/HTML-challenge
   response → outcome `manual` (sidecar `given_up` for the reddit route,
   listed in the report's manual queue) — reddit rows never consume tier-2
   renders.
b. **(Green)** Implement: URL → `<thread>.json` fetch through `safeFetch` +
   browser headers, parse, gate, submit via import-markdown.

→ **HV-3**: one real public Reddit thread recovers anonymously from the home
box, or is cleanly queued for the skill.

### Phase 5 — Worker API: reprocess accepts a markdown source

The single Worker change. Workers-pool TDD; contract files move together per
convention (`src/schemas/api.ts`, router, `web/src/types.ts`, tests).

a. **(Red)** Schema spec (`test/unit/schemas`): `PostReadingReprocessBody`
   accepts optional `source: {kind: "markdown", markdown: string(min 1),
   title?: string}`; rejects `kind: "url"` bodies and empty markdown; absent
   `source` keeps today's parse results (back-compat pinned).
b. **(Red)** Integration specs (`test/integration/readings.test.ts`
   patterns): (1) reprocess of a READY url-sourced reading with a markdown
   source → 202, queued args carry `source.kind === "markdown"` with the
   supplied text and `preserveReadyManifest`; after queue drain the manifest
   is ready with the new content and `source_type: "markdown"` (pin this
   deliberate semantic: future Worker reprocesses reuse the stored markdown
   rather than re-fetching the URL that degraded); (2) reprocess of a FAILED
   reading with a markdown source → 202 and recovers without touching
   by-url resolution; (3) running attempt + no force → 409 unchanged;
   (4) supplied source takes precedence over the stored-markdown
   synthesis in `enqueueReprocess` (`src/router.ts:504-515`).
c. **(Green)** Implement: thread `parsed.data.source` into
   `enqueueReprocess`, preferring a request-supplied source over the
   `source_type === "markdown"` synthesis.
d. **(Refactor)** Mirror the body type in `web/src/types.ts`; `cd web && npm
   test && npm run build`.

→ Deploy to staging (`npm run deploy -- --env staging --execute`) before
Phase 6 HV.

### Phase 6 — upgrade path: detection + raw_only upgrades

a. **(Red)** Detection spec: ready rows get `content_status` resolved via
   `GET /readings/:id` exactly once per `(id, updated_at)` (second run with
   unchanged manifest performs zero detail GETs — assert on the injected
   fetch); `raw_only` rows become upgrade candidates routed to tier 2.
b. **(Red)** Gate spec: salvaged-only or short tier-2 output → no submit;
   proper article → submit via `reprocessReading` extended to carry
   `{force: false, source: {kind: "markdown", …}}` (extend
   `corpus-lib/api.ts`'s `reprocessReading` signature; recover's existing
   call sites keep `{force: true}` behavior — pin with a test in
   `test/unit/corpus`).
c. **(Green)** Implement; upgrades draw from the same paid-action budget as
   recoveries, and recoveries win when the budget is short (failed → ready
   beats better-than-raw_only).

→ **HV-4**: a real `raw_only` reading upgrades to captured on staging;
verify the summary/tldr regenerated and the reading stayed ready throughout
(mid-flight it is pending-with-preserved-ready; confirm a deliberate tier-2
failure rolls it back to ready).

### Phase 7 — YouTube upgrades (and failed YouTube rows)

a. **(Red)** Thinness heuristic spec: markdown fixtures — floor-only (title +
   byline only) → thin; with description → not thin; with `## Transcript` →
   not thin.
b. **(Red)** `youtube.ts` route spec with yt-dlp + watch-page fetch faked:
   produces markdown via the shared `buildYoutubeMarkdown` parts; yt-dlp
   absent → description-only result still passes the gate iff a description
   was obtained; nothing new obtained → gate rejects (no paid call).
c. **(Green)** Implement by extracting the fetch/transcript core of
   `scripts/youtube-import.ts` into `youtube-import-lib` so the CLI skill and
   the agent share one implementation (refactor with existing
   `test/unit/youtube-import` specs kept green).

→ **HV-5**: one thin YouTube reading upgrades with a transcript on staging.

### Phase 8 — ops + docs + production cutover

a. Home-box unit files committed under `ops/extract-agent/`: **systemd**
   (`extract-agent.service` one-shot + `extract-agent.timer`,
   `OnUnitActiveSec=45min` with `RandomizedDelaySec`), `EnvironmentFile=`
   pointing at the vars file (`0600`). Include the home-box bootstrap steps:
   Node ≥20, `npm ci`, `npx playwright install chromium` (+ system deps),
   `yt-dlp` on PATH. (If the box turns out to be a Mac, translate to a
   launchd plist at install time — the committed artifact is systemd.)
b. Docs: CLAUDE.md module-map + gotchas entries (agent is an API client; the
   sole-writer rule does NOT apply to it — it is realtime-writer traffic;
   Reddit/YouTube skills remain the manual fallback and the agent's `manual`
   queue names them); README operations section; delete
   `plans/015-home-server-migration.md`.
c. Staging soak: ≥3 timer-driven runs including one no-op run (empty plan →
   report + ping still fire), then point at production with
   `AGENT_MAX_PAID_ACTIONS` temporarily lowered (e.g. 5) for the first week.

→ **HV-6**: timer fires unattended on the home box; healthchecks alert
observed by killing the timer for one interval; production run report
reviewed.

## Verification commands (repo-discovered)

- Root: `npm run test:quiet` (all), `npm run test:quiet --
  test/unit/extract-agent` (agent only), `npm run typecheck`.
- SPA (Phase 5 only): `cd web && npm test && npm run build`.
- Staging deploy for HV: `npm run deploy -- --env staging --execute`; agent
  HV runs use `READING_API_URL=<staging>`.
- Evidence of success per phase: the HV items above; each is a
  human-observable corpus state change on staging.

## Risks & mitigations

- **Runaway paid spend** (worst risk): per-run action cap + per-category
  gates + attempts ceiling + dry-run default + `--only` surgical mode +
  first-week lowered cap. A crash-looping timer is bounded by cap × runs and
  by sidecar give-ups; sidecar loss re-exposes at most one cap's worth.
- **LAN SSRF** (home box sits inside the network the Worker's guard
  protects, and — unlike the Worker — has no platform-level private-egress
  block): every egress path goes through `safeFetch`, which follows
  redirects manually, re-checks `isBlockedHost` and the resolved IP on every
  hop; tier 2 re-checks initial + final URLs and aborts private-host
  subresources via a real, unit-tested route filter; `BlockedHostError`
  rows are policy-`never` (do not retry from inside the LAN what the guard
  already refused). Single exported predicate — no drifting copies.
  DNS-rebinding TOCTOU is an accepted, documented residual risk (URLs are
  self-submitted via an authed API).
- **Playwright weight/fragility**: lazy-imported, never in the Worker bundle;
  headless failures degrade to sidecar bookkeeping, never crash the run; the
  dead-man ping catches a box where Chromium broke (run crashes → no ping).
- **Reddit tightening**: anonymous fetch is best-effort by design; challenge
  → the manual skill queue, which is exactly today's workflow.
- **Race with realtime writer**: none by construction — the agent calls the
  same authed API as the SPA; ownership/idempotency is enforced server-side
  (`attemptOwnership` gates). It additionally skips pending/running rows to
  avoid wasted work. `--sole-writer` batch tooling rules do not apply.
- **Upgrade regressions** (replacing a working reading with worse content):
  `preserveReadyManifest` covers pipeline failure; the salvage-path gate
  covers content quality; `force: false` on upgrades means a concurrent
  running attempt wins a 409 rather than being clobbered.
- **`source_type` flip on upgraded readings** is deliberate and pinned by
  test (Phase 5b): once locally extracted, Worker-side reprocess reuses the
  good markdown instead of re-degrading via URL fetch.

## Stop conditions

- Any HV gate fails → stop, fix or descope that phase; later phases depend on
  earlier HVs only as listed (Phases 1–4 are shippable without Phase 5+).
- Phase 5 integration tests reveal the reprocess extension disturbing any
  existing ownership/activation test → stop and redesign the extension point
  before shipping the Worker change.
- Reddit anonymous fetch proves consistently challenged during HV-3 →
  permanently route reddit to the manual queue (descope, don't fight it).
- Paid-action anomalies during the production soak (report shows unexpected
  submit volume) → disable the timer; the corpus is untouched beyond the
  capped actions and everything is auditable via run logs + attempt logs.
