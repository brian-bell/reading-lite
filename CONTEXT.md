# CONTEXT.md — domain language for `reading-lite`

The shared nouns the code is named after. Keep this in lockstep with the modules;
when a concept gets a clearer name in code, rename it here too.

## Owner resolution / claim

The protocol for answering **"who owns this URL?"** before doing any work for a
submit, a markdown import, or a lookup. It lives in
`src/modules/reading-claim.ts` (`ReadingClaim.resolveOwner`), not in the router.

- **By-url pointer** — `index/by-url/{sha256(url)}` → `{ id, key_prefix }`. The
  eager ownership claim: `POST /readings` writes it (conditional create) before
  queueing work, so concurrent submits of one URL converge on the first owner.
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
- **Claiming the slot** (`claimByUrlSlot` in the router) — a freshly-minted
  reading takes the by-url slot, retrying through `resolveOwner` when a
  concurrent submit wins the race: it defers to that winner or retries against
  the pointer they left. Bounded — it converges or gives up, never recurses
  without limit.

## Reading lifecycle

- **Manifest** — the per-reading record at `{key_prefix}/manifest.json`. Status is
  `pending` → `ready` | `failed`. The cross-module contract (`src/schemas/manifest.ts`);
  the SPA hand-mirrors it in `web/src/types.ts`.
- **Attempt** — one processing run (`submit` | `reprocess` | `import`). The
  manifest carries an `active_attempt` while running and a `last_attempt` after.
- **Attempt activation** — the eager write-and-enqueue counterpart to the
  **terminal write**, owned by `activateAttempt` in `src/attempt-activation.ts`.
  The router claims the by-url slot, then `activateAttempt` writes artifacts (raw
  + extracted, import paths only) → manifest → by-id pointer (all but reprocess)
  → list index → queue message under one canonical ordering. Any throw before the
  send rolls the slot back to a `failed` (retryable `QueueSendError`) manifest and
  returns 503. Same lockstep discipline as `commitTerminalManifest` on the
  terminal side.
- **List index** — `index/list.json`, maintained on every terminal write
  (idempotent on `id`) so list/search never go stale.
- **Stale annotation** — a read-time overlay: a `pending` manifest past
  `PENDING_TTL_SECONDS`, or a `running` attempt past TTL, is surfaced as `failed`
  without a write. The rule lives in `src/modules/staleness.ts` (`stalenessOf`);
  `annotateStale` / `annotateStaleIndexItem` in `router.ts` are thin adapters
  that read the TTL from env and apply the verdict onto the manifest / index-item
  shape.
