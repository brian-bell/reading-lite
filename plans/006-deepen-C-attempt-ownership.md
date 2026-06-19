# 006 — Deepen C: one attempt-ownership rule (+ a latent cleanup-gate bug fix)

**Status:** planned
**Branch base:** `codex/issue-33-idempotent-url-submits`
**Companion plans:** 004 (reading claim), 005 (commit terminal — Step 4 folds in the verdict half of this plan)

## Two parts

1. **Bug fix (standalone, lands first):** unify the inconsistent "legacy-pending" rule between the
   manifest and list cleanup gates.
2. **Deepening (folds into plan 005, Step 4):** one `attemptOwnership` verdict as the single source
   of truth for all five sites that ask "does this attempt still own the reading?", removing the 6×
   `attemptId ?? at_${id}` duplication.

---

## The five sites and their (different, on purpose) rules

| Site | Question | Rule |
|---|---|---|
| `readingCanWriteAttemptArtifacts` (mid-flight gating of `write_raw`/`write_extracted`) | may I write artifacts? | `active===id` **OR** (`active undefined && status==="pending"`) |
| `terminalWriteState` inline (`activeAttemptMatches` / `activeAttemptConflict`) | may I write terminal manifest / publish / remove? | `active===id` **OR** legacy-pending **OR** (`allowLastAttempt && last===id`); conflict = `active defined && active!==id` |
| `manifestBelongsToAttempt` (gate **vector** removal) | did this attempt produce the current manifest? | `active===id` **OR** `last===id` **OR** (`active undefined && status pending`) |
| `listItemBelongsToAttempt` (gate **list-row** removal) | did this attempt produce the current row? | (`id && key_prefix` match) **AND** [`active===id` **OR** `last===id` **OR** (`active undefined && **last undefined** && status pending`)] |
| `markDeadLettered` guard | is this DLQ message still current? | `active===id` only |

**A single boolean predicate would be wrong** — these differ for real reasons:

- terminal-write needs `allowLastAttempt` because `markFailed` stamps `last_attempt` *before*
  computing terminal state (the attempt has already finished).
- cleanup checks `last_attempt` because the published row/manifest may carry this attempt as `last`.
- dead-letter is strict `active`-only: a newer attempt taking over means the DLQ message is stale and
  must not clobber.

So the deepening is **not** "collapse to one predicate" — it's "give the vocabulary one source of
truth."

---

## Part 1 — the latent bug

The divergent clause:

- `manifestBelongsToAttempt` (vector gate): `active undefined && status === "pending"`
- `listItemBelongsToAttempt` (list gate): `active undefined && **last undefined** && status === "pending"`

For a pending reading with `active_attempt === undefined` **and** a `last_attempt` set, the manifest
gate says "belongs" while the list gate says "doesn't."

### Why it isn't currently firing (the twist)

The only caller of `manifestBelongsToAttempt` is `readingCanRemoveAttemptVector`, reached only
*inside* `removeAttemptVisibility` **after** the list removal already succeeded:

```ts
async function removeAttemptVisibility(reader, similarity, args) {
  if (!(await removeAttemptListVisibility(reader, args))) return;   // stricter list rule gates here
  if (!(await readingCanRemoveAttemptVector(reader, args))) return; // looser manifest rule, downstream
  await similarity.delete(args.id);
}
```

The stricter list rule dominates; the manifest rule's extra permissiveness is dead in this path. The
integration test at `readings.test.ts:953` only exercises the agreeing state
(`active undefined && last undefined && pending` → both fire, vector deleted). The disagreeing state
is unreachable through the HTTP surface today — but it's constructible with a crafted seed, and it
breaks the moment the vector gate is called without the list gate first, or reordered.

### Direction: unify to the stricter `isVacantPending`

`active undefined && last undefined && status === "pending"`. Refuse to delete a vector for a reading
whose manifest carries a `last_attempt` (a signal another attempt touched it and we may not own it).
Provable no-op in today's call graph → cannot regress the passing tests.

### TDD cycle (standalone commit, before plan 005)

**RED** — export the two predicates (or a `__test` shim) and pin the divergence directly, since
integration can't reach it cleanly. New file `test/unit/process-reading/attempt-ownership.test.ts`:

```ts
it("manifest and list gates agree on a pending reading that has a last_attempt but no active_attempt", () => {
  const args = { id: "rd_X", keyPrefix: PREFIX, attemptId: "at_OTHER", /* url, urlHash */ };
  const divergent = { active_attempt: undefined, last_attempt: { id: "at_PRIOR", ... }, status: "pending" };
  // today: manifestBelongsToAttempt → true, listItemBelongsToAttempt → false  (the bug)
  expect(manifestBelongsToAttempt(args, manifest(divergent)))
    .toBe(listItemBelongsToAttempt(args, item(divergent)));   // RED: true !== false
});
```

Plus one integration regression with the crafted seed (list row vacant-pending, manifest
pending-with-`last_attempt`) asserting the vector is **kept** under a stale successful cleanup.

**GREEN** — one line: tighten `manifestBelongsToAttempt`'s legacy clause to also require
`last_attempt === undefined`, matching the list rule.

**Verify** — full suite green; `readings.test.ts:953` (vacant-pending) still deletes the vector,
proving no regression.

---

## Part 2 — the verdict (folds into plan 005, Step 4)

After plan 005 has collapsed the terminal write (`terminalWriteState` is now private to
`commitTerminalManifest` and is the biggest consumer of these rules), introduce the verdict.

### B.4a — introduce the verdict (RED first)

Extend `test/unit/process-reading/attempt-ownership.test.ts` with one case per table row, including
the now-fixed vacant-pending rule:

```ts
interface AttemptOwnership {
  isActive: boolean;         // active_attempt.id === attemptId
  isLast: boolean;           // last_attempt.id === attemptId
  isLegacyPending: boolean;  // active undefined && status pending             (write-side gates)
  isVacantPending: boolean;  // active undefined && last undefined && pending  (cleanup gates — the fixed rule)
  hasConflict: boolean;      // active defined && active !== attemptId
}
function attemptOwnership(manifest: Manifest | null, args: ProcessReadingArgs): AttemptOwnership;
```

The `attemptId ?? \`at_${args.id}\`` fallback is defined **once**, inside `attemptOwnership` —
deleting the 6 scattered copies.

### B.4b — port each consumer onto the verdict (suite green after each)

- `readingCanWriteAttemptArtifacts` → `o.isActive || o.isLegacyPending`
- `terminalWriteState` (private to `commitTerminalManifest`) → write:
  `o.isActive || o.isLegacyPending || (allowLast && o.isLast) || manifest === null`; conflict:
  `o.hasConflict`
- `readingCanRemoveAttemptVector` → `o.isActive || o.isLast || o.isVacantPending`
- `listItemBelongsToAttempt` → `(id/key_prefix match) && (o.isActive || o.isLast || o.isVacantPending)`
- `markDeadLettered` guard → `manifest === null || o.isActive`

### B.4c — delete

`manifestBelongsToAttempt`, `listItemBelongsToAttempt`, and the inline matching in
`terminalWriteState`. Grep-confirm `at_${` and the raw `active_attempt?.id === attemptId`
comparisons survive in exactly one place (`attemptOwnership`).

---

## Ordering & rationale

1. **Part 1 bug fix** — behavioral change, own red test + commit, independently revertable.
2. **Plan 005 (B)** — behavior-preserving structural collapse of the terminal write.
3. **Part 2 verdict (in 005 Step 4)** — behavior-preserving consolidation that *keeps* the fix
   unified by construction.

Each layer is separately green and separately reversible.

## Done when

- The divergent-state unit test passes and an integration regression pins "vector kept".
- `attemptOwnership` is the single definition of the `at_${id}` fallback and the active/last/pending
  rules; the five sites compose its booleans.
- `manifestBelongsToAttempt` / `listItemBelongsToAttempt` are deleted.
- Full integration suite green.
</content>
