# 005 — Deepen B: `commitTerminalManifest` (collapse the terminal-write contract)

**Status:** planned
**Branch base:** `codex/issue-33-idempotent-url-submits`
**Companion plans:** 004 (reading claim), 006 (attempt ownership — folds into Step 4 here)

## Why

The "CAS-write the manifest, then reconcile list + vector visibility, restore on loss" sequence is
re-spelled in three places in `src/process-reading.ts`:

- the success path (`processReading`, ~l.174–205)
- the `markFailed` **preserve-ready** branch (~l.358–378)
- the `markFailed` **normal** branch (~l.399–417)

Each caller must independently know the ordering invariant. `TerminalWriteState`'s three booleans
(`canWriteManifest`, `canPublishVisibility`, `canRemoveVisibility`) are a shallow interface — nearly
as much to learn as the implementation does — and the ordering leaks into every caller.

## Target interface

```ts
async function commitTerminalManifest(
  reader: ReadingStore,
  similarity: SimilarityStore | null,   // null on failure paths → list-only visibility (preserves today's asymmetry)
  args: ProcessReadingArgs,
  manifest: Manifest,
  opts: {
    claimMissingPointer: boolean;
    allowLastAttempt?: boolean;
    defensive: boolean;                  // false: write throws propagate (success → outer catch marks failed); true: swallow (failure path)
    vector?: { embedding: number[]; meta: { url: string; title: string; tags: string[]; created_at: string } };
    instrument?: <T>(stage: ProcessingStage, fn: () => Promise<T>) => Promise<T>;  // success passes runStage-bound closure; failure omits
  },
): Promise<{ committed: boolean }>;
```

The ordering invariant lives inside, exactly once:

```
state = terminalWriteState(reader, args, { claimMissingPointer, allowLastAttempt })
if (!state.canWriteManifest) return { committed: false }          // conflict — no writes, no restore
written = writeManifest(state)  (CAS if etag, plain otherwise; defensive ? swallow : throw)
if (!written) { await restoreCurrentListVisibility(); return { committed: false } }   // CAS lost mid-flight
if (state.canPublishVisibility)      { appendIndexItem(manifest); if (vector && similarity) upsertVector() }
else if (state.canRemoveVisibility)  { removeAttemptListVisibility(); if (similarity) removeAttemptVector() }
return { committed: true }
```

`TerminalWriteState` and its three booleans become **private** to this module — the leak the
candidate targets.

### Two distinct "not written" cases (both must be preserved)

- `canWriteManifest` false (active-attempt conflict) → return, **no writes, no restore**.
- CAS lost (etag changed mid-flight) → **restore** current list visibility, then return.

### The `instrument` hook

Keeps the refactor behavior-preserving: the success path still logs
`write_manifest`/`write_indexes`/`upsert_vector` stage events via its `runStage`-bound closure; the
failure path omits it and writes plainly.

> Alternative considered (deferred): drop `instrument` and always log stages — failure paths would
> gain `write_manifest`/`write_indexes` events. Benign, arguably better, but a behavior change. Keep
> `instrument` for a strictly behavior-preserving first cut; revisit later.

### Success/failure asymmetry (preserve, do not "fix")

Success removal clears list **and** vector; failure removal clears list **only**. Encoded by passing
`similarity: null` on failure paths. This is real, not an accident — see plan 006 for the related
cleanup-gate bug, which is a *different* issue and gets fixed separately.

## TDD approach

Unit tests in `test/unit/process-reading/commit-terminal.test.ts` (cloudflare pool, real
`env.READINGS_BUCKET`, a small fake `SimilarityStore` over a fake `VectorizeIndex` mirroring
`installVectorizeStub`).

### Step 0 — Safety net

Run `npm test` → green. Note the behaviors covered by the existing stale-visibility/CAS integration
tests (`readings.test.ts` ~l.953–1259, `dead-letter.test.ts`). Note the list-vs-vector asymmetry to
preserve.

### Step 1 — RED: unit-spec `commitTerminalManifest`

Export the function for the test. Failing tests:

1. active attempt matches + owns url → manifest CAS-written, index appended, vector upserted (when `vector` given) → `committed:true`
2. active-attempt **conflict** (`active.id !== attemptId`) → `canWriteManifest` false → **no** writes, **no** restore → `committed:false`
3. **CAS loss** (stub `replaceManifestIfCurrent`→false) → `restoreCurrentListVisibility` called → `committed:false`
4. owns-write but **not** owner (`canPublish` false, `canRemove` true) → list row removed (+ vector when `similarity` provided) → `committed:true`
5. no existing manifest (`manifestEtag` absent) → plain `writeManifest`, then publish/remove per owner
6. preserve-ready manifest (caller-built) → committed + index appended (drives the `markFailed` preserve branch)
7. `defensive:true` + `writeManifest` throws → swallowed → restore → `committed:false`
8. `defensive:false` + `writeManifest` throws → **propagates** (success path relies on the outer catch → `markFailed`) — *load-bearing; assert explicitly*
9. failure-path asymmetry: `similarity:null` on the remove branch → list row removed, **vector untouched**
10. `instrument` passthrough: when provided, each sub-write is wrapped (assert the closure is invoked per stage with the right `ProcessingStage`)

### Step 2 — GREEN: extract

Pull the sequence out of the success path and both `markFailed` branches. Keep `terminalWriteState`,
`writeManifestForTerminalState`, `writeTerminalManifestDefensively`, `restoreCurrentListVisibility`,
`removeAttemptVisibility`, `removeAttemptListVisibility` as **private implementation** of the new
function (don't delete — they're the internals now). Make unit tests pass.

### Step 3 — GREEN: rewire the three call sites

- success path:
  `commitTerminalManifest(reader, similarity, args, finalManifest, { claimMissingPointer:true, defensive:false, vector:{ embedding: tldrEmbed.embedding, meta }, instrument:(s,fn)=>runStage(attempt,reader,args.keyPrefix,services,s,fn) })`
- `markFailed` preserve branch:
  `commitTerminalManifest(reader, null, args, preserveManifest, { claimMissingPointer:false, allowLastAttempt:true, defensive:true })`
- `markFailed` normal branch: same opts, failed manifest

Re-run integration after each. `markDeadLettered` flows through `markFailed`, so it's covered
transitively — assert via `test/integration/dead-letter.test.ts`.

### Step 4 — REFACTOR (folds in plan 006)

`TerminalWriteState` and its booleans no longer appear in any caller — grep-confirm. Then execute
**plan 006** (attempt-ownership verdict): `terminalWriteState` is the biggest consumer of the
attempt-ownership rules, so porting it onto the unified `attemptOwnership` verdict happens here.

## Risk & rollback

- **Test #8 (throw propagation)** is load-bearing: if the success-path manifest write stops
  propagating, failures get silently swallowed instead of marking the manifest failed.
- The success/failure **vector asymmetry** (#9) is intentional — preserve via `similarity:null`,
  don't "fix" it here.
- Each of the three rewires is an independent commit.

## Done when

- `commitTerminalManifest` has full unit coverage (cases 1–10).
- Success path and both `markFailed` branches call it; no caller references `TerminalWriteState` or
  re-spells the ordering.
- Full integration suite green.
</content>
