# 004 — Deepen A: `ReadingClaim` (resolve the owning reading)

**Status:** planned
**Branch base:** `codex/issue-33-idempotent-url-submits`
**Companion plans:** 005 (commit terminal), 006 (attempt ownership)

## Why

The **read → match → repair → resolve** protocol for "who owns this URL?" is hand-inlined across
six places in `src/router.ts`:

- `POST /readings`
- `POST /readings/import-markdown`
- `GET /readings/lookup`
- the `createNewReadingForSubmit` catch block
- the `createNewReadingForMarkdownImport` catch block
- the self-recursive `damagedOwnerResult`

There are ~30 call sites of the resolution primitives (`readByUrlPointerWithEtag`,
`findManifestByUrl`, `replaceByUrlPointerIfCurrent`, `ownedManifestMatches`,
`isFreshMissingManifestPointer`). Understanding "what happens when I submit a URL" means bouncing
across all six. The protocol has **no module of its own** — and only `createApp` is exported from
`router.ts`, so the only seam to test it is a full HTTP round-trip against a hand-built R2 state.

## Target interface

New module `src/modules/reading-claim.ts`:

```ts
export type OwnerResolution =
  | { kind: "owned"; pointer: ByUrlPointer; manifest: Manifest }
  | { kind: "initializing"; pointer: ByUrlPointer }   // fresh pointer, manifest not yet written, within grace
  | { kind: "unclaimed"; replaceEtag?: string };        // claim is free; replaceEtag set when a damaged pointer must be CAS-overwritten

export class ReadingClaim {
  constructor(private store: ReadingStore, private services: Services) {}
  async resolveOwner(url: string): Promise<OwnerResolution>;
}
```

Behind the seam (moved out of `router.ts`):

- `ownedManifestMatches`
- `isFreshMissingManifestPointer`, `keyPrefixCreatedAtMs`
- `MISSING_MANIFEST_OWNER_GRACE_MS`
- the `findManifestByUrl({ deepScan })` legacy reconciliation
- the `replaceByUrlPointerIfCurrent` repair
- the recursion in `damagedOwnerResult` — replaced by a **bounded** loop

Callers collapse to a switch:

```ts
const res = await claim.resolveOwner(url);
switch (res.kind) {
  case "owned":        return submitResultForOwnedReading(..., res.manifest);
  case "initializing": return initializingResponse(res.pointer);                 // 409
  case "unclaimed":    return createNewReadingForSubmit(..., { replaceEtag: res.replaceEtag });
}
```

## TDD approach

Refactor of subtle, working concurrency code. Discipline: existing integration tests are the
behavioral safety net (stay green throughout); write new **unit tests against `resolveOwner`'s
interface first** (red), then extract the implementation (green).

Unit tests live in `test/unit/modules/reading-claim.test.ts` (cloudflare pool, real
`env.READINGS_BUCKET`, stubbed `services.now`/`newId`) — same idiom as
`test/unit/stores/reading-store.test.ts`.

### Step 0 — Safety net (no new code)

Record the current green baseline. The protocol's behaviors that must not regress:

- ready/pending re-submit returns the owned reading (200)
- failed re-submit reprocesses in place (202)
- fresh missing-manifest owner → 409 "still initializing"
- damaged/stale owner → repaired or replaced
- concurrent submit converges on one owner (no clobber)
- `GET /readings/lookup` owned / initializing / 404

`npm test` → green.

### Step 1 — RED: unit-spec `resolveOwner`

Failing tests against the not-yet-existing module:

1. no pointer, no legacy manifest → `unclaimed` (no `replaceEtag`)
2. pointer + matching `ready` manifest → `owned` (manifest returned verbatim)
3. pointer + matching `failed` manifest → `owned` (resolver does **not** branch on status — caller decides reprocess)
4. pointer present, manifest missing, key_prefix timestamp **fresh** (< grace) → `initializing`
5. pointer present, manifest missing, timestamp **stale** (> grace), legacy manifest exists → CAS-replaces pointer to legacy → `owned`
6. pointer present, manifest missing, stale, **no** legacy → `unclaimed` with `replaceEtag = <pointer etag>`
7. pointer present but manifest belongs to a **different** id/url (damaged) → repair or `unclaimed{replaceEtag}`
8. legacy manifest exists with **no** by-url pointer at all → claims pointer `ifNotExists` → `owned`
9. **concurrent:** another writer claims the pointer between read and CAS-replace → CAS fails → re-read **converges** on the other owner → `owned` (asserts no clobber) — *write this one first and most carefully; it encodes the core idempotency guarantee*
10. key_prefix with unparseable timestamp → not fresh → damaged/repair path
11. **bound:** persistent CAS contention terminates after N attempts (inject a contention stub) rather than recursing forever — a deliberate improvement over today's unbounded `damagedOwnerResult` recursion

### Step 2 — GREEN: extract the implementation

Move the helpers listed above out of `router.ts` into `ReadingClaim`. Convert the recursion into a
bounded loop. Make the unit tests pass without touching callers yet.

### Step 3 — GREEN: rewire callers, delete duplication

One caller at a time, re-running the integration suite after each (each is its own commit):

- `POST /readings` → `resolveOwner` + switch
- `POST /readings/import-markdown` → same. **Preserve** the import-only policy
  `deepScan: existing ? true : undefined` by folding it into the resolver so submit and import share
  one path; assert it explicitly.
- `GET /readings/lookup` → `resolveOwner` (`owned`→`{id}`, `initializing`→409, `unclaimed`→404)
- `createNewReadingForSubmit` / `createNewReadingForMarkdownImport` catch blocks → on lost claim
  race, call `resolveOwner` again
- delete `damagedOwnerResult` entirely

### Step 4 — REFACTOR

Remove now-dead helpers from `router.ts`; grep-confirm the grace constant and timestamp parsing
live only in `ReadingClaim`. Seed `CONTEXT.md` with the domain nouns **owner resolution** /
**claim**.

## Risk & rollback

- Highest-risk test is **#9** (convergence under race) — the core idempotency guarantee.
- The import-markdown `deepScan` policy difference is the one behavioral subtlety to preserve.
- Rollback is per-caller: each Step 3 rewire is an independent commit.

## Done when

- `resolveOwner` has full unit coverage (cases 1–11).
- `router.ts` contains no inlined ownership-resolution protocol; `damagedOwnerResult`,
  `ownedManifestMatches`, `isFreshMissingManifestPointer`, `keyPrefixCreatedAtMs` are gone from it.
- Full integration suite green.
</content>
