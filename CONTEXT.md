# CONTEXT.md — domain language for `reading-lite`

The shared nouns the code is named after. Keep this in lockstep with the modules;
when a concept gets a clearer name in code, rename it here too.

## Owner resolution / claim

The protocol for answering **"who owns this URL?"** before doing any work for a
submit, a markdown import, or a lookup. It lives in
`src/modules/reading-claim.ts` (`ReadingClaim.resolveOwner`), not in the router.

- **Tenant R2 root** — hosted stores prepend `u/{tenantId}/` to every reading
  and index key when `TENANT_DATA_PLANE=1`. Stored `key_prefix` stays relative
  (`readings/YYYY/…`). Production and staging pin the gate on; only local
  stays unset.
- **By-url pointer** — `{tenantRoot}index/by-url/{sha256(url)}` → `{ id, key_prefix }`.
  The eager ownership claim is **per tenant**: `POST /readings` writes it
  (conditional create) before queueing work, so concurrent submits of one URL
  *within a tenant* converge on the first owner. Two tenants saving the same
  URL get distinct readings and distinct pointers.
- **Owner resolution** — the `OwnerResolution` a `resolveOwner(url)` returns:
  - `owned` — a pointer resolves to a manifest that genuinely owns the URL
    (`id`, `url`, `url_hash` all match). The caller decides what to do with it
    (a `failed` owner is reprocessed in place; anything else is returned as-is).
  - `initializing` — a fresh pointer whose manifest is not written yet, still
    inside the **grace window** (`MISSING_MANIFEST_OWNER_GRACE_MS`, 5 min, keyed
    off the `key_prefix` timestamp). The caller responds 409.
  - `unclaimed` — the URL is free to claim. `replaceEtag` is set when a **damaged
    pointer** sits in the slot and must be CAS-overwritten rather than created
    `ifNotExists`.
- **Damaged pointer** — a by-url pointer whose manifest is missing-and-stale, or
  present but owns a different id/url. Resolution **repairs** it: CAS-replace it
  onto a recovered **legacy reading**, or hand the caller a `replaceEtag` to
  overwrite it with a fresh reading.
- **Legacy reading** — a manifest discoverable by URL (`findManifestByUrl`) that
  has no live pointer, e.g. a pre-index Backlite row or a copy dropped from
  `index/list.json`. A **deep scan** (full `readings/` rebuild) is the strongest
  recovery; resolution deep-scans exactly when an existing pointer needs repair.
- **Claiming the slot** (`ReadingClaim.claimSlot`) — a freshly-minted reading
  takes the by-url slot, retrying through `resolveOwner` when a concurrent
  submit wins the race. Returns a claim outcome (`claimed` | `owned` |
  `initializing` | `contended`) rather than taking a callback, so pointer-CAS
  internals (`replaceEtag`, `PointerExistsError`) never cross the seam to
  **Reading intake** — the caller switches on the outcome and defers to the
  winning owner in place. Bounded — it converges or gives up, never recurses
  without limit.

## Reading lifecycle

- **Manifest** — the per-reading record at `{key_prefix}/manifest.json`. Status is
  `pending` → `ready` | `failed`. The cross-module contract (`src/schemas/manifest.ts`);
  the SPA hand-mirrors it in `web/src/types.ts`.
- **Attempt** — one processing run (`submit` | `reprocess` | `import`). The
  manifest carries an `active_attempt` while running and a `last_attempt` after.
- **Reading intake** — the write-side front door for a reading: `submit` |
  `importMarkdown` | `reprocess`, each returning an **intake outcome**
  (`activated` | `existing` | `initializing` | `conflict` | `not_found` |
  `unavailable` | `rate_limited` | `quota_exhausted` | `guard_unavailable`)
  that the router — a thin HTTP adapter — maps onto statuses.
  Owns the claim → pending-manifest → **attempt activation** ordering for all
  three verbs; lives in `src/intake/`. HTTP never crosses the seam: zod body
  parsing and the email defaults stay in the router, and intake takes
  already-typed inputs plus narrow deps (tenant-scoped store, queue-or-null,
  services, pending TTL, tenant usage guard). `GET /lookup` is read-path and
  stays outside intake. Ready/pending/conflict/initializing returns do not
  consume a reading-quota slot; only a successfully activated attempt does.
  Request-rate still counts every write. Queue-send and pre-summarization
  failures release an undispatched reservation.
- **Attempt activation** — the eager write-and-enqueue counterpart to the
  **terminal write** and the lower half of **Reading intake**, owned by
  `activateAttempt` in `src/intake/activation.ts` (internal to intake — the
  router no longer imports it). Intake claims the by-url slot, then
  `activateAttempt` writes artifacts (raw
  + extracted, import paths only) → manifest → by-id pointer (all but reprocess)
  → list index → queue message under one canonical ordering. Any throw before the
  send rolls the slot back to a `failed` (retryable `QueueSendError`) manifest and
  reports `unavailable` (503). Same lockstep discipline as
  `commitTerminalManifest` on the terminal side.
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
- **List index** — `{tenantRoot}index/list.json`, maintained on every terminal
  write (idempotent on `id`) so list/search never go stale. Each tenant has its
  own CAS object; a deep scan lists only that tenant's `readings/` prefix.
- **Reading visibility** — a reading is publicly visible iff its **list index**
  row and its Vectorize vector are both present, and only the attempt that owns
  the reading may change either. That list+vector lockstep and the owner gate
  live in `src/reading-visibility.ts` (`ReadingVisibility`), exposing three verbs:
  `publish` (append row + upsert vector), `remove` (remove row + delete vector,
  list-only when there is no Vectorize binding — the success/failure asymmetry),
  and `restoreIfOwner` (re-sync the row after a lost manifest CAS).
  `commitTerminalManifest` decides *what* to do (publish / remove / nothing) and
  the module enforces *how*. It is the terminal-side mirror of `activateAttempt`.
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
  skips spend and visibility. A D1 status-lookup failure **before extract/embed**
  throws `RateLimitedError` so the queue retries. After a terminal CAS, and on
  the DLQ mark path, lookup failure fail-opens (publish/keep, or write failed);
  compensate/remove only on confirmed inactive. Visibility publish/remove
  throws after that CAS log-and-continue so a deleting-tenant hide failure
  cannot `markFailed` over the ready object. `commitTerminalManifest`
  rechecks status immediately before visibility publish and again immediately
  after (compensate with `visibility.removeForDeletedTenant` if the tenant
  flipped deleting in between — the deletion fence deletes the vector directly
  rather than gating on the `index/list.json` row, which a concurrent wipe may
  already have removed). Wipe of tenant R2 + Vectorize is a deferred shared-queue
  job plus the */15 cron sweep, honoring a 7-day `deleting_at_ms` grace unless
  the job payload sets `force` (grace gates *new* wipes; cron resumes
  in-progress/leftover and preserves `force` from the wipe record). It
  re-derives reading ids from R2 on every pass and never persists them.
  Vectorize `deleteByIds` is async — embeddings may take a short time to
  disappear.
- **Wipe progress** — the D1 `wipe_progress` row that is a wipe's whole durable
  state: phase, both cursors, and the `lease_seq` a conditional UPDATE
  compare-and-sets to decide which delivery owns the wipe (`changes = 0` is
  "someone else owns this"). Its **completion record** is kept after the wipe
  finishes rather than deleted — it is the evidence the later control-plane
  teardown gates its hard delete on, which is why the foreign key to `users`
  does not cascade. It is two pairs: `completed_at_ms`/`residue` are the current
  state, which a reopen clears so the gate stays shut while a reopened pass
  runs, and `first_completed_at_ms`/`first_residue` are the write-once history a
  failed reopen cannot erase. Users-row hard-delete, Durable Object teardown,
  and email reuse live in `account-teardown.ts` (issue 195 S4). Residue scan is
  the remaining later slice (S5). Wipe is not
  **reading purge** (`DELETE /api/readings/:id`). Purge writes an existence-only
  tombstone at `index/deleted/{id}` before corpus deletes; the terminal
  publisher rechecks it the same way it rechecks `users.status=deleting`,
  and does not reclaim by-url or write a new terminal manifest under a
  confirmed tombstone. A confirmed tombstone on skip-write, lost-CAS,
  `canWriteManifest=false`, markFailed/DLQ, or after a terminal CAS also
  deletes prefix objects.
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
- **Refresh judgement checkpoint** — D1 `relationship_refresh_jobs` keeps one
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
