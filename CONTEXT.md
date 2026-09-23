# CONTEXT.md — domain language for `reading-lite`

The shared nouns the code is named after. Keep this in lockstep with the modules;
when a concept gets a clearer name in code, rename it here too.

## Owner resolution / claim

The protocol for answering **"who owns this URL?"** before doing any work for a
submit, a markdown import, or a lookup. Ownership is a PostgreSQL uniqueness
constraint ([ADR 0005](docs/decisions/0005-postgresql-storage.md)); the verbs
live on `PgReadingStore` (reads) and `PgReadingWriter` (writes) in
`src/modules/stores/postgres/`, and intake drives them.

- **Tenant R2 root** — `contentStoreFor` prepends `u/{tenantId}/` to every
  content key when `TENANT_DATA_PLANE=1`. Stored `key_prefix` and content keys
  stay relative (`readings/YYYY/…`). Rows are tenant-scoped whatever the gate
  says. Production and staging pin the gate on; only local stays unset.
- **URL ownership** — one `reading_urls` row per `(tenant_id, url_hash)`,
  naming the reading that owns the URL. The eager ownership claim is **per
  tenant**: two tenants saving the same URL get distinct readings.
- **Owner resolution** — `findOwnerByUrl(url)` reads the owner row, and it is
  side-effect-free: `/lookup` uses it and never claims or repairs. A `failed`
  owner is reprocessed in place; anything else is returned as-is.
- **Claiming the URL** (`PgReadingWriter.claimUrl`) — commits the reading, its
  URL row, the attempt and the job in one transaction under the tenant's
  `users` row `FOR SHARE`, and returns a claim outcome: `claimed`, `owned`
  (a concurrent claim committed first; intake re-resolves and defers to it), or
  `tenant_inactive`. An owner is never half-written, so the R2 era's
  `initializing` owner, damaged pointer, legacy-reading deep scan and pointer-CAS
  contention have no counterpart. Re-resolution is bounded: it converges or
  answers `unavailable`.

## Reading lifecycle

- **Manifest** — the API shape of a reading, projected from its `readings`
  row, current revision and attempt rows. Status is `pending` → `ready` |
  `failed`. The cross-module contract (`src/schemas/manifest.ts`); the SPA
  hand-mirrors it in `web/src/types.ts`. Rows read from PostgreSQL are parsed
  into it at the seam.
- **Attempt** — one processing run (`submit` | `reprocess` | `import`), a
  `reading_attempts` row. The manifest carries an `active_attempt` while running
  and a `last_attempt` after.
- **Reading intake** — the write-side front door for a reading: `submit` |
  `importMarkdown` | `reprocess`, each returning an **intake outcome**
  (`activated` | `existing` | `conflict` | `invalid_url` | `not_found` |
  `unavailable` | `rate_limited` | `quota_exhausted` | `guard_unavailable`)
  that the router — a thin HTTP adapter — maps onto statuses.
  Owns the claim → attempt → **attempt activation** ordering for all
  three verbs; lives in `src/intake/`. HTTP never crosses the seam: zod body
  parsing and the email defaults stay in the router, and intake takes
  already-typed inputs plus narrow deps (tenant-scoped store and writer,
  queue-or-null, services, pending TTL, tenant usage guard). `GET /lookup` is
  read-path and stays outside intake. Ready/pending/conflict returns do not
  consume a reading-quota slot; only a successfully activated attempt does.
  Request-rate still counts every write. Queue-send and pre-summarization
  failures release an undispatched reservation.
- **Attempt activation** — the eager write-and-enqueue counterpart to the
  **terminal write** and the lower half of **Reading intake**, owned by
  `activateAttempt` in `src/intake/activation.ts` (internal to intake — the
  router does not import it). After the claim or reprocess has committed the
  attempt and its job row, activation writes the captured artifacts to R2
  (raw + extracted, import paths only) under the attempt's revision keys and
  sends the queue message. Any throw before the send marks the job
  `send_failed`, rolls the reading back through `failActivation` (a new reading
  to `failed`, a reprocessed one to its prior state), and reports `unavailable`
  (503).
- **Manifest drafting** — the pure constructors for every Manifest the system
  writes, in `src/modules/manifest-drafting.ts` (a vocabulary module below
  intake, `processReading`, and the offline batch write phase, like
  `attempt-ownership.ts`). Pending drafts for the three intake verbs (the verb
  stamps the attempt trigger — a submit draft cannot carry an import attempt),
  the queue-send rollback, and the terminal builders (`ready` | `failed` |
  roll-forward) shared by the realtime and offline pipelines. The empty-content
  placeholder convention and the parse-on-return guarantee (every drafted
  Manifest passes `ManifestSchema`) live behind this seam. The module drafts,
  it does not decide: rollback-target choice, ownership gating, and every write
  stay with callers. Terminal builders take `attempt: summary | null` — null is
  the writer's explicit statement that no identifiable **attempt** ran (today's
  offline batch, whose sidecars carry no attempt identity); attempt identity is
  never fabricated.
- **List projection** — the `IndexItem` shape list, search and relationship
  targets return, projected from rows by `PgReadingStore` (`manifestToIndexItem`
  names the mapping). There is no stored list to keep in step.
- **Publication** — `PgReadingWriter.publish` is the terminal write for a
  successful attempt: one transaction that takes the tenant lock, then the
  reading lock, checks attempt ownership, then writes URL ownership, revision,
  reading, relationships, embedding and attempt in that order. A reading is
  searchable only when it owns its URL and its tenant is active; otherwise it
  is stored without an embedding. `fail` is the failure terminal: a reading
  with a published revision keeps it, so its previous content and summary stay
  together.
- **Stale annotation** — a read-time overlay: a `pending` manifest past
  `PENDING_TTL_SECONDS`, or a `running` attempt past TTL, is surfaced as `failed`
  without a write. The rule lives in `src/modules/staleness.ts` (`stalenessOf`);
  `annotateStale` / `annotateStaleIndexItem` in `router.ts` are thin adapters
  that read the TTL from env and apply the verdict onto the manifest / index-item
  shape.

## Account deletion

- **Suppress** (`DELETE /api/account`, issue 195a) — recently authenticated
  session, CSRF, explicit `{ confirm: "delete" }`. Marks `users.status=deleting`
  first, then revokes sessions and API tokens. Queue admit, DLQ, digest, and
  notification skip a non-active tenant. A confirmed inactive or missing user
  skips spend and visibility. A status-lookup failure **before extract/embed**
  throws `RateLimitedError` so the queue retries. On the DLQ mark path a
  lookup failure fail-opens (write failed); act only on confirmed inactive.
  Claim and publish decide eligibility inside their own transaction, under a
  FOR SHARE lock on the `users` row, so the deletion's status UPDATE
  serializes against them: a claim that lands after the flip writes no rows,
  and a publish that holds the lock first completes whole. An ineligible
  tenant's reading is stored without an embedding, never searchable, and a
  deleting tenant's copy goes with the wipe. Wipe of the tenant's reading rows
  (embeddings with them) and then its R2 prefix is a deferred shared-queue job
  plus the */15
  cron sweep, honoring a 7-day `deleting_at` grace unless the job payload sets
  `force` (grace gates *new* wipes; cron resumes in-progress/leftover and
  preserves `force` from the wipe record).
- **Wipe progress** — the `wipe_progress` row that is a wipe's whole durable
  state: phase (`rows`, `objects`, `done`), the object cursor, and the
  `lease_seq` a conditional UPDATE
  compare-and-sets to decide which delivery owns the wipe (`changes = 0` is
  "someone else owns this"). Its **completion record** is kept after the wipe
  finishes rather than deleted — it is the evidence the later control-plane
  teardown gates its hard delete on, which is why the foreign key to `users`
  does not cascade. It is two pairs: `completed_at`/`residue` are the current
  state, which a reopen clears so the gate stays shut while a reopened pass
  runs, and `first_completed_at`/`first_residue` are the write-once history a
  failed reopen cannot erase. Users-row hard-delete, Durable Object teardown,
  and email reuse live in `account-teardown.ts` (issue 195 S4). Residue scan is
  the remaining later slice (S5). Wipe is not
  **reading purge** (`DELETE /api/readings/:id`), which deletes the reading's
  row in one transaction (URL, revisions, relationships, embedding, attempts
  and jobs cascade) and then its R2 prefix. The missing row is the deletion
  fence: a late consumer's publish, failure or attempt-log write finds no row
  and writes nothing (see
  [architecture](docs/architecture.md#reprocessing-and-recovery)).
  Production and staging
  `TENANT_DATA_PLANE=1`: the founder is a normal tenant.

## Digest delivery

- **Digest cadence** — `off` | `daily` | `weekly` on `user_settings`. Independent
  of `notify_immediate`. Opt-out is cadence `off`.
- **period_key** — local civil key the ledger is unique on: daily `YYYY-MM-DD`,
  weekly ISO week `YYYY-Www` (Monday=1). Computed in the user's IANA zone.
- **Digest job** — one `DIGEST_JOBS` message per tenant, envelope v1
  `{ tenantId, userId, period_key, cadence }` only. The consumer re-reads
  settings immediately before send. B1 stub-sends by marking the ledger `sent`
  without calling Resend.

## Relationship refresh

- **Refresh scan** — a gated nightly, founder-tenant full scan of ready readings,
  in queue shards of 25. It reuses the offline neighbourhood-drift rules and
  only reads reading data. All shards finish before judge fan-out starts.
- **Refresh cursor** — tenant `index/refresh-cursor.json`, CAS-written with scan
  targets, flagged candidates and dispatch progress. A nightly judgement cap
  reserves pending batches before send and carries the remainder to later nights.
  Judge identity is `(runAt, readingId)` across retries. This cursor is independent
  of the operator's refresh-state marker.
- **Refresh judgement checkpoint** — `relationship_refresh_jobs` keeps one
  latest run per tenant/reading. Dispatch is marked only after paid admission;
  an uncertain dispatch is not repeated by another delivery. A saved relationship
  patch and resulting-manifest hash allow CAS publication/list repair without
  another provider call. Reading purge and account teardown remove checkpoints.

## Operator surface

- **Reading API client** — the operator tools' one way of speaking to the
  reading API: `readingApiFor({ base, token, fetch })` in
  `scripts/lib/reading-api.ts`. It is the inverse of
  the router's `toHttp`: responses decode back into the **intake outcome**
  vocabulary (`activated` | `existing` | `initializing` | `conflict` |
  `not_found` | `unavailable` | `quota`) plus the client-only `http_error` and
  `transport_error`, so a 409
  initializing owner is never miscounted as a failure. The client owns transport
  retry — submit/import/lookup retry through the by-url claim's idempotency;
  **reprocess never auto-retries**, because a delivered-then-retried reprocess
  activates and bills a second attempt — and `waitTerminal` polling to a
  terminal manifest. Loop orchestration (serial iteration, skip/quit prompts,
  run summaries) stays with the individual tools.
