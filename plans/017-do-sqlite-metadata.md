# 017 — Relational Metadata on Durable Object SQLite

Move reading *metadata* out of R2 JSON (per-reading `manifest.json`, the
`index/list.json` singleton, `index/by-url/*` and `index/by-id/*` pointers,
`attempts/*.json`) into a single SQLite database owned by one Durable Object.
Content blobs (`raw.*`, `extracted.md`) stay in R2 under the existing
`key_prefix` layout. The DB becomes the **source of truth**; R2 metadata
objects are frozen at cutover and deleted after a bake period.

## Decisions (from the design interview, 2026-07-10)

1. **Context**: current Cloudflare Worker (no platform move).
2. **Engine**: Durable Object with SQLite storage (decided; D1 rejected).
3. **Truth**: the DB is authoritative for all metadata. R2 keeps blobs only.
4. **Writer topology**: ALL metadata writes go through the Worker API. The
   Node-side corpus tools become pure API clients; the laptop keeps no
   R2-write or Vectorize credentials for metadata. The sole-writer guard
   becomes deletable — every mutation passes the same DO-serialized ownership
   gates the realtime path uses.
5. **Schema shape**: one flat `readings` table (scalars as columns, arrays and
   attempt summaries as JSON TEXT columns, `summary_markdown` as TEXT) plus an
   `attempts` table (events as a JSON column).
6. **Search**: exact parity with today (`q` = case-insensitive substring over
   title/tldr/url; `tag` exact; sort `created_at` DESC; offset/limit). FTS5 is
   a separate later plan.
7. **Cutover**: big-bang backfill through an admin endpoint, rehearsed on
   staging. Rollback = redeploy the old Worker (R2 metadata untouched).
8. **Durability**: built-in DO PITR plus a nightly cron export of all rows as
   JSON to the existing R2 bucket (versioned key, keep last N). Frozen R2
   metadata deleted after ~1 month bake.
9. **DO topology**: singleton DO, **storage layer only**. Router, queue
   consumer, processing pipeline, R2 blob writes, queue.send, and Vectorize
   calls all stay in the Worker. The DO owns the schema and exposes RPC
   methods that carry today's invariants.

The external API contract is frozen: same routes, same JSON shapes, same
status codes. `web/src/types.ts` and the SPA are untouched. Plan 016 (local
extraction agent) is unaffected — it is already a pure API client.

## Why this pays for itself

The DO's serialized execution + SQL constraints delete whole problem classes,
not just code:

- `UNIQUE(url_hash)` **is** the by-url claim. `PointerExistsError`, the
  read→repair→re-resolve loop in `ReadingClaim.resolveOwner`, the
  missing-manifest grace window, cold-legacy adoption scans, deep-scan pointer
  repair, and `OwnerResolutionContentionError` all exist because a pointer and
  its manifest are two objects that can disagree. In one table they cannot.
- The row **is** the list entry. `ListIndexStore`'s CAS mutate loop, jittered
  backoff, `OWNERSHIP_RANK` URL resolution, and the full-bucket `rebuild`
  fallback are replaced by `SELECT ... ORDER BY created_at DESC`.
- Manifest etag CAS (`replaceManifestIfCurrent`) disappears: the whole
  terminal-write decision (`terminalWriteState`) runs inside one DO
  transaction, so there is no read-modify-write window to guard.
- `ReadingVisibility.restoreIfOwner`'s documented residual race (lost CAS →
  re-append vs winner's pointer change) is structurally gone.
- `listAttempts`' upload-time shortlist heuristic is replaced by
  `ORDER BY started_at DESC LIMIT ?`.
- `--sole-writer` and `soleWriterGuard` become dead code (Phase 8).

What does NOT change: attempt-ownership vocabulary (`attemptOwnership`,
`resolveAttemptId`), the staleness read-time rule (`stalenessOf`), queue/DLQ
semantics, `ProcessReadingArgs` queue message shape, the Vectorize
list+vector lockstep asymmetry (success clears list AND vector, failure is
list-only), the R2 blob layout, and every HTTP contract. Vectorize can never
join a SQLite transaction, so `ReadingVisibility`'s ordering rules survive —
only its list-row half becomes DO calls.

## Facts to pin in Phase 0 (verify, don't trust)

- DO SQLite API: `ctx.storage.sql.exec`, synchronous results,
  `ctx.storage.transactionSync`, input/output gates. Confirm a multi-statement
  sync block is atomic and non-interleaved.
- Migrations: `[[migrations]] new_sqlite_classes = ["ReadingMetadata"]` in
  wrangler.toml (per env), schema versioning via `PRAGMA user_version` applied
  in the constructor under `blockConcurrencyWhile`.
- vitest-pool-workers DO support: DO binding in `wrangler.test.toml`,
  `runInDurableObject` from `cloudflare:test`, and whether per-test isolated
  storage resets DO SQLite (it should — pin it).
- Workers RPC: `extends DurableObject`, typed method calls from both the fetch
  router and the queue consumer via `env.READING_META.get(idFromName("main"))`.
- Value/row size ceilings for DO SQLite (2 MB-class per-value limits) vs our
  largest fields (`summary_markdown`, `preserve_ready_manifest_json`,
  `events_json`) — expected orders of magnitude of headroom; confirm.
- PITR on SQLite-backed DOs: 30-day horizon, bookmark API
  (`getCurrentBookmark` / `onNextSessionRestoreBookmark`) — write down the
  actual restore runbook, not just "PITR exists".
- Cron triggers per environment (`[triggers] crons`) + `scheduled` handler
  coexisting with fetch/queue handlers in `src/index.ts`.
- FTS5 availability in DO SQLite — pin the fact for the later search plan,
  build nothing.
- Miniflare local dev: DO SQLite persists locally, so `wrangler dev` gains
  working list/detail/lookup (queue/Vectorize stay absent — same 503 story).

## Schema (v1)

```sql
PRAGMA user_version = 1;

CREATE TABLE readings (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,          -- the by-url claim, structurally
  key_prefix TEXT NOT NULL,               -- R2 blob location (unchanged layout)
  source_type TEXT,                       -- 'url' | 'markdown'
  status TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
  error_json TEXT,                        -- ManifestError
  active_attempt_json TEXT,               -- ProcessingAttemptSummary
  last_attempt_json TEXT,                 -- ProcessingAttemptSummary
  preserve_ready_manifest_json TEXT,      -- full prior-ready snapshot
  title TEXT,
  tldr TEXT,
  tags_json TEXT,                         -- string[]
  keywords_json TEXT,
  people_json TEXT,
  orgs_json TEXT,
  novelty_verdict TEXT,
  connections_json TEXT,                  -- Connection[]
  summary_markdown TEXT,
  content_type TEXT NOT NULL,
  content_status TEXT NOT NULL CHECK (content_status IN ('captured','raw_only','failed')),
  content_bytes INTEGER NOT NULL,
  extracted_bytes INTEGER,
  content_sha256 TEXT NOT NULL,
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  usage_json TEXT
);
CREATE INDEX readings_created_at ON readings (created_at DESC);
CREATE INDEX readings_status ON readings (status);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  reading_id TEXT NOT NULL,               -- no FK cascade; readings are never
  url TEXT NOT NULL,                      -- deleted except via corpus-drop,
  url_hash TEXT NOT NULL,                 -- which removes attempts explicitly
  key_prefix TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT,
  events_json TEXT NOT NULL DEFAULT '[]'  -- ProcessingAttemptEvent[]
);
CREATE INDEX attempts_reading ON attempts (reading_id, started_at DESC);
```

Notes:

- `active_attempt`/`last_attempt` stay as JSON summaries **on the readings
  row** (not joins) so `attemptOwnership` keeps reading the exact
  `{active_attempt, last_attempt, status}` shape from a single row — the
  ownership gates port without change.
- The zod `ManifestSchema` remains the row↔manifest codec: a `rowToManifest` /
  `manifestToRow` pair in the DO module, parse-at-seam preserved (DB reads are
  a seam like R2 reads were).
- `manifestToIndexItem` becomes a SELECT projection; `ListIndexItem` stays the
  wire shape.

## The `ReadingMetadata` DO — RPC surface

Class `ReadingMetadata` (new `src/metadata/`), binding `READING_META`,
singleton via `idFromName("main")`. Pure decision logic stays in shared
modules (`attempt-ownership.ts`, `staleness.ts`, a new pure
`terminal-write-decision.ts` extracted from `process-reading.ts`); DO methods
wrap decisions + row mutations in `transactionSync` so every gate evaluates
against current state with no interleaving.

- `resolveOwner(url, urlHash): { kind: "owned", manifest } | { kind: "unclaimed" }`
  — one SELECT. The `initializing` and damaged-pointer verdicts have no
  equivalent (activation is atomic), so the router's owner switch loses two
  arms.
- `activate(activation): { ok: true } | { ok: false, conflict: manifest }` —
  the metadata half of `activateAttempt`: atomically claim-or-verify the
  `url_hash` slot, upsert the readings row to pending with `active_attempt`,
  insert the attempts row. Called by the router AFTER R2 blob writes, BEFORE
  `queue.send` (ordering unchanged; blobs-before-visibility survives).
- `rollbackActivation(args, error)` — the `QueueSendError` funnel:
  failed-flip, or restore from `preserve_ready_manifest_json` semantics for
  reprocess (ports `manifestForQueueSendFailure`).
- `commitTerminal(args, manifest, policy): { visibility: "publish" | "remove" | "none" }`
  — runs the ported `terminalWriteState` + row write in one transaction and
  returns the vector instruction; the Worker's `ReadingVisibility` then does
  the Vectorize upsert/delete (asymmetry rules unchanged). Replaces manifest
  etag CAS, `removeListIndexItemIf`, and `restoreIfOwner`.
- `getReading(id)`, `getByUrl(urlHash)`, `list(params)` (parity semantics:
  LIKE over title/tldr/url with escaped `%_`, tag via `json_each`,
  `total_filtered` via COUNT), `listAttempts(readingId, limit)`.
- `recordAttemptEvent(attemptId, event)` / `finishAttempt(...)` — replaces
  `writeAttempt` re-puts during pipeline stages.
- `markDeadLettered` support: the existing read-verify-then-markFailed flow
  becomes one gated DO method.
- Admin: `backfillUpsert(manifest, attempts[])` (idempotent by id),
  `exportAll(cursor)` (paged dump for backfill verification, corpus-audit,
  and the nightly export), `stats()`.

`ReadingStore` shrinks to a blob store: `writeRaw/readRaw/writeExtracted/
readExtracted/listReadingObjects/buildKeyPrefix`. Everything else on it is
deleted with `list-index.ts` and `reading-claim.ts`'s resolver loop.

## Worker API additions (for batch tools + ops)

All under the existing bearer auth; paths outside `/readings*` need a
`wrangler.toml` route addition (`reading-lite.bbell.dev/admin*`) — remember
Pages serves unmatched paths, so the route MUST be added with the endpoints.

- `POST /admin/backfill` — body: manifest JSON + attempts[]; calls
  `backfillUpsert`. Also used by the cutover script.
- `GET /admin/export?cursor=` — paged row dump (corpus-audit's new read path,
  backfill verification, and what the cron writes to R2).
- `POST /admin/batch/activate` — batch-pipeline activation: accepts target
  metadata + inline artifacts (markdown/raw), Worker writes blobs to R2 then
  calls `activate` with no queue send. Replaces `activation-phase.ts`'s and
  `prepare-fresh-markdown.ts`'s direct R2 writes.
- `POST /admin/batch/commit-terminal` — accepts the terminal manifest + the
  summary embedding (1536 floats); Worker runs `commitTerminal` + the
  Vectorize half server-side. Replaces `write-phase.ts`'s direct R2/Vectorize
  writes and removes the laptop's Vectorize credential.
- `POST /admin/drop` — corpus-drop's metadata+vector removal, server-side.

`scripts/corpus-lib` keeps its pipeline shape (prepare → similar → validate →
submit → poll → write) but its R2/Vectorize clients are replaced by these
endpoints via the existing `api.ts` client. `--sole-writer` is deleted (Phase
8), because batch terminal writes now pass the same in-DO ownership gates as
realtime writes — a concurrent realtime attempt wins or loses the gate
atomically instead of clobbering.

## Phases (TDD; red/green per repo convention)

Full verification at every phase boundary: `npm run test:quiet`,
`npm run typecheck`, `cd web && npm test && npm run build`.

### Phase 0 — Fact-pinning spike

Tiny throwaway-quality tests (kept if cheap) proving: DO binding in the
vitest workers pool + `runInDurableObject`, `transactionSync` atomicity,
`PRAGMA user_version` migration-on-construct, RPC from a queue-handler
context, per-test storage isolation. Update wrangler.toml /
wrangler.test.toml with the DO class + migrations (all envs). Record the
pinned size/PITR facts at the top of this file.

### Phase 1 — DO scaffold, schema, codecs

`src/metadata/reading-metadata.ts` (DO class, migration runner, schema v1)
plus `rowToManifest`/`manifestToRow` round-trip property tests against
`ManifestSchema` fixtures (including maximal manifests:
`preserve_ready_manifest`, usage, connections). New workers-pool glob
`test/unit/metadata/**`.

### Phase 2 — RPC surface with invariants

TDD each method against the DO directly. Port the gate tests that define
current behavior: activation conflict (claimed url_hash → conflict with
owner manifest), failed-owner reprocess-in-place, `commitTerminal` ownership
gates (active/last/vacant-pending/conflict — port from
`test/unit/process-reading` and `reading-visibility` suites), preserve-ready
restore, dead-letter flip, list parity (q/tag/offset/limit/total_filtered
cases ported from list-index tests), staleness projection, attempts ordering.
Extract `terminalWriteState` into a pure shared module as part of this phase.

### Phase 3 — Worker swap (the big one)

Point `router.ts`, `attempt-activation.ts`, `process-reading.ts`,
`reading-visibility.ts` at the DO. The existing integration suite
(`test/integration/readings.test.ts`) is the parity oracle — assertions stay,
only R2-seeding fixtures become DO/backfill seeding. `activateAttempt` keeps
its ordering and 202/503 envelope but its four metadata writes collapse into
one `activate` call; `ReadingVisibility` keeps the vector half and delegates
the list half. `GET /readings/lookup` stays side-effect-free trivially (a
SELECT). Delete becomes possible but do NOT delete legacy modules yet — they
back the deployed Worker until cutover; quarantine behind the old entry
points instead.

### Phase 4 — Admin endpoints + corpus-lib as API client

New endpoints above, TDD at router level; rewrite `corpus-lib`'s
`r2-reads.ts` / `activation-phase.ts` / `write-phase.ts` /
`prepare-fresh-markdown.ts` / audit + drop tools onto them (their Node-pool
unit tests re-target a stubbed API client). Delete `--sole-writer` plumbing
here or in Phase 8 — keep the flag as a no-op with a deprecation stderr note
until cutover completes.

### Phase 5 — Backfill + verification tooling

`scripts/backfill-metadata.ts`: list R2 manifests (`READINGS_PREFIX` scan +
`attempts/*`), POST each to `/admin/backfill`, idempotent, dry-run by
default, `--execute`, resumable. Verifier: diff `GET /readings` (full
pagination) and N sampled `GET /readings/:id` + `/diagnostics` between the
old deploy and the backfilled new one; also diff `/admin/export` row count vs
R2 manifest count. Rehearse the entire cutover on staging: `staging:setup`,
seed real-ish corpus, backfill, verify, exercise submit/reprocess/import/
batch-recover end to end.

### Phase 6 — Production cutover

Runbook (execute manually, checklist in this file): stop submitting → drain
queue (confirm zero in-flight) → deploy new Worker (routes incl. `/admin*`)
→ backfill → run verifier → smoke: one submit, one reprocess, one lookup.
Rollback: redeploy previous Worker — R2 metadata is frozen-in-place and
still-correct. Gap to accept: any reading created AFTER cutover exists only
in the DB; rollback would orphan it (re-import by URL). Keep the rollback
window short.

### Phase 7 — Nightly export cron

`scheduled` handler in `src/index.ts` → `exportAll` → write
`metadata-backup/YYYY-MM-DD.json` to the R2 bucket, prune to last 14.
`[triggers]` in production (and staging for rehearsal). A restore script
(`scripts/restore-metadata.ts` = backfill script pointed at a backup file)
plus the PITR runbook from Phase 0 complete the durability story.

### Phase 8 — Bake, then burn

After ~1 month clean: corpus tool deletes frozen R2 metadata objects
(`*/manifest.json`, `index/*`, `*/attempts/*`; dry-run default). Delete dead
code: `list-index.ts`, `ReadingClaim`'s resolver loop +
`PointerExistsError` + contention error, pointer/manifest/attempt methods on
`ReadingStore`, `restoreIfOwner`, `soleWriterGuard` + flag, rebuild paths,
and their tests. Update README.md and AGENTS.md (module map, gotchas — the
sole-writer and CAS paragraphs come out; DO + backup runbooks go in).

## Risks / accepted trade-offs

- **Single DO = single serialization point and a fixed home region.** Every
  metadata op is an extra hop. Acceptable for a single-user service; not a
  scaling architecture, and not trying to be.
- **Vectorize remains outside the transaction.** The lockstep is still
  ordering + gates, not atomicity — unchanged from today, now with fewer
  races on the list half.
- **Rollback-after-cutover data gap** (Phase 6 note).
- **DO storage is opaque** compared to inspectable R2 JSON — mitigated by the
  nightly JSON export and `/admin/export`.
- **wrangler.test.toml/staging/production config drift** — the DO binding and
  migrations must land in all four config blocks; Phase 0 checklist item.
