# CONTEXT.md — domain language for `reading-lite`

The shared nouns the code is named after. Keep this in lockstep with the modules;
when a concept gets a clearer name in code, rename it here too.

## Owner resolution / claim

The protocol for answering **"who owns this URL?"** before doing any work for a
submit, a markdown import, or a lookup. It lives in
`src/modules/reading-claim.ts` (`ReadingClaim.resolveOwner`), not in the router.

- **Tenant R2 root** — hosted stores prepend `u/{tenantId}/` to every reading
  and index key when `TENANT_DATA_PLANE=1`. Stored `key_prefix` stays relative
  (`readings/YYYY/…`). Production/staging leave the gate off until the founder
  corpus is copied (s1k.6).
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
