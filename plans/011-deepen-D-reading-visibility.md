# 011 — Deepen D: collapse Reading visibility into one module

GitHub issue: [#54](https://github.com/brian-bell/reading-lite/issues/54)
(Architecture-review "Strong" candidate.)

## Why

A reading's **visibility** is two artifacts that must move in lockstep: its row
in `index/list.json` and its vector in Vectorize. Today that invariant — *visible
iff list row and vector are both present, and only the owning attempt may change
either* — is smeared across seven functions in `src/process-reading.ts`, and the
ownership gate (`attemptOwnership`) is re-derived at four of them:

| Function | lines | touches | re-derives owner? |
|---|---|---|---|
| `commitTerminalManifest` | ~478–538 | orchestrates publish/remove/restore | via `terminalWriteState` |
| `reconcileVisibility` | ~543–556 | defensive wrapper | no |
| `terminalWriteState` | ~558–600 | computes publish/remove gates, claims missing pointer | yes |
| `restoreCurrentListVisibility` | ~640–660 | list row | yes (pointer + manifest) |
| `removeAttemptVisibility` | ~662–670 | list + vector | no (delegates) |
| `removeAttemptListVisibility` | ~672–688 | list only | yes |
| `readingCanRemoveAttemptVector` | ~690–698 | vector only | yes |

`commitTerminalManifest` is the closest thing to a home, but the publish/remove/
restore mechanics live as loose siblings around it. This is a **behavior-preserving
refactor**: the terminal-write contract (status codes, R2 writes, queue acks,
Vectorize state) is unchanged — only the *home* of the list-row + vector pairing
moves behind one seam.

## Goal / Acceptance

- One `ReadingVisibility` module exposes three verbs — **publish**, **remove**,
  **restoreIfOwner** — each taking the ownership gate once.
- The list + vector lockstep and the owner gate live behind that seam.
  `commitTerminalManifest` decides *what* (publish vs remove vs nothing); the
  module enforces *how*.
- Two adapters justify the seam: the list index (`ReadingStore`) and Vectorize
  (`SimilarityStore`).
- **Zero behavior change.** `test/integration/readings.test.ts`,
  `test/unit/process-reading/*`, and `test/integration/dead-letter.test.ts` pass
  unchanged — including lost-CAS restore and the `similarity == null` (local, no
  Vectorize) paths.
- New unit tests exercise the `ReadingVisibility` interface directly.
- `npm test` + `npm run typecheck` green; `web/` untouched.

## Not in scope

- The manifest CAS write (`writeManifestForTerminalState` /
  `replaceManifestIfCurrent`) — stays in the terminal-write spine. This is about
  visibility *after* the manifest decision.
- `terminalWriteState`'s by-url pointer claim — keep its current placement. The
  module **consumes** the resulting gate; it does not compute pointer ownership.
- Stale annotation (separate candidate, already landed in `staleness.ts`).
- Any attempt to "fix" the documented lost-CAS restore race — move it verbatim.

## Design

New file `src/reading-visibility.ts`, beside `process-reading.ts`. It absorbs the
bodies of `removeAttemptVisibility`, `removeAttemptListVisibility`,
`readingCanRemoveAttemptVector`, `restoreCurrentListVisibility`, and the publish
block currently inlined in `commitTerminalManifest` (the
`appendOrReplaceListIndexItem` + `similarity.upsert` pair).

`attemptOwnership` / `manifestToIndexItem` are already exported and shared, so the
module imports them — it does **not** copy the gate logic.

### Target interface (finalize during grilling)

```ts
// src/reading-visibility.ts
export interface PublishVector {
  embedding: number[];
  meta: { url: string; title: string; tags: string[]; created_at: string };
}

export class ReadingVisibility {
  constructor(reader: ReadingStore, similarity: SimilarityStore | null);

  // append/replace list row, then upsert vector (null similarity → list only)
  publish(manifest: Manifest, args: ProcessReadingArgs, vector?: PublishVector): Promise<void>;

  // remove list row if owned, then vector if owned (null similarity → list only)
  remove(args: ProcessReadingArgs): Promise<void>;

  // re-append the current row iff the by-url pointer still points at this reading
  restoreIfOwner(args: ProcessReadingArgs): Promise<void>;
}
```

`commitTerminalManifest` keeps the gate decision
(`canPublishVisibility` / `canRemoveVisibility` from `terminalWriteState`) and the
`reconcileVisibility` defensive wrapper, then calls one verb. The
`similarity == null` fork that currently splits `removeAttemptVisibility` vs
`removeAttemptListVisibility` at the call site is absorbed into `remove`, deleting
the `if (similarity) … else …` branch.

### The `instrument` hook (must be preserved)

The success-path publish wraps each sub-write in `run("write_indexes", …)` /
`run("upsert_vector", …)` so a stage event is logged per write (see
`CommitTerminalOpts.instrument`, ~459–461). `publish` must keep emitting those two
stage events. Pass the bound `run` instrument into `publish` (e.g.
`publish(manifest, args, vector, { instrument })`), or have `publish` accept the
`run` closure as a constructor/param. Verify against the existing stage-event
assertions in `commit-terminal.test.ts` — **do not** drop or rename the
`write_indexes` / `upsert_vector` stages.

### Three "not written" / asymmetry invariants to carry verbatim

1. **Success/failure asymmetry** — `similarity` is null on failure paths: success
   removal clears list AND vector, failure removal clears list only (plan 006
   cleanup-gate). `remove` with `similarity == null` must be list-only.
2. **Lost-CAS restore race** — `restoreCurrentListVisibility` carries a documented
   last-writer-wins residual race (comments ~646–658). Move the pointer check and
   re-append verbatim; do not narrow or close the window.
3. **`defensive` flag semantics** — failure path swallows visibility throws,
   success path propagates. Keep `reconcileVisibility` at the
   `commitTerminalManifest` layer wrapping the verb call; the defensive policy
   must **not** leak into the module.

## TDD sequence

Use `$tdd` (red-green-refactor). Run `npm run test:quiet` between steps; the
integration + `process-reading` unit suites are the characterization net.

### Step 0 — Safety net (no code change)

Confirm the green baseline before touching anything:

```sh
npm run test:quiet -- test/integration/readings.test.ts \
  test/unit/process-reading test/integration/dead-letter.test.ts
npm run typecheck
```

Note `test/integration/readings.test.ts:7` and `:1218` import
`removeAttemptVisibility` from `process-reading` — that export must survive (or be
re-exported / repointed). Track it as a rewire target.

### Step 1 — RED: spec `ReadingVisibility` directly

New `test/unit/reading-visibility/visibility.test.ts`. Reuse the fixtures from
`commit-terminal.test.ts` (the `args` / `manifest` / `readyManifest` /
`fakeVectorize` / `clearBucket` helpers — extract to a shared
`test/unit/process-reading/_fixtures.ts` or copy; copying is fine, they are small).
Drive the real `ReadingStore` over the Miniflare bucket and the real
`SimilarityStore` over `fakeVectorize`, exactly as the sibling test does.

Cases (each red against a not-yet-written module):

- **publish — owned, with vector**: writes the list row AND upserts the vector;
  the row matches `manifestToIndexItem(manifest, keyPrefix)`; the vector lands in
  `fakeVectorize.vectors` under `args.id`.
- **publish — null similarity**: constructed with `similarity = null`; writes the
  row only, no vector machinery touched (no throw).
- **publish — emits stage events**: when given the `instrument` hook, both
  `write_indexes` and `upsert_vector` stages fire (assert via a capturing
  instrument).
- **remove — owned, with vector**: deletes both the list row and the vector.
- **remove — foreign owner**: a row stamped with a different `active_attempt`
  (conflict) is a no-op — row and vector survive.
- **remove — vector gate says no**: list row removed but
  `readingCanRemoveAttemptVector` is false (e.g. manifest now owned by a newer
  attempt) → vector is **not** deleted. (Mirror the current
  `removeAttemptVisibility` two-gate behavior.)
- **remove — null similarity**: list-only; no vector call, no throw.
- **restoreIfOwner — still owns url**: by-url pointer points at this reading →
  re-appends the current row.
- **restoreIfOwner — pointer moved**: pointer points at a different id/key_prefix
  → no-op (does not resurrect the row).
- **restoreIfOwner — no manifest**: missing manifest → no-op.

### Step 2 — GREEN: move (not copy) the seven bodies

Create `src/reading-visibility.ts`. **Move** the bodies of
`removeAttemptVisibility`, `removeAttemptListVisibility`,
`readingCanRemoveAttemptVector`, `restoreCurrentListVisibility`, and the inlined
publish block into the three verbs. Import `attemptOwnership`,
`manifestToIndexItem`, `ProcessReadingArgs`, and `Manifest`. Keep every comment
(the race note, the cleanup-gate note) attached to the code it documents.

Get the new unit suite green. Do not rewire `commitTerminalManifest` yet.

### Step 3 — REFACTOR: rewire `commitTerminalManifest` and friends

Repoint the three internal call sites inside `commitTerminalManifest`:

- lost-CAS branch (~511–513): `reconcileVisibility(defensive, () => vis.restoreIfOwner(args))`
- publish branch (~517–528): `reconcileVisibility(defensive, () => vis.publish(manifest, args, opts.vector, { instrument: run }))`
- remove branch (~531–536): `reconcileVisibility(defensive, () => vis.remove(args))` — the `if (similarity) … else …` fork is gone.

Construct one `ReadingVisibility(reader, similarity)` at the top of
`commitTerminalManifest`. Keep `reconcileVisibility` and `terminalWriteState`
exactly where they are.

Then fix the surviving external import: `test/integration/readings.test.ts`
imports `removeAttemptVisibility` from `process-reading` (`:7`, used at `:1218`).
Either (a) re-export it from `process-reading` as a thin
`(reader, similarity, args) => new ReadingVisibility(reader, similarity).remove(args)`
shim, or (b) repoint the test import to the new module's `remove` verb. Prefer
(b) — repoint the test — so `process-reading` sheds the symbol rather than keeping
a compatibility alias. Confirm no other importers exist (`grep` from Step 0
showed only this one + `process-reading` internals).

Run the full net after each rewire:

```sh
npm run test:quiet -- test/integration/readings.test.ts \
  test/unit/process-reading test/integration/dead-letter.test.ts \
  test/unit/reading-visibility
npm run typecheck
```

### Step 4 — Docs

- **CONTEXT.md** — add a *Reading visibility* term under *Reading lifecycle*
  (around line 39–63): the list-row + vector lockstep owned by
  `src/reading-visibility.ts`, with `commitTerminalManifest` deciding what and the
  module enforcing how. Run `$docs` or edit directly.
- **AGENTS.md / CLAUDE.md** — add `src/reading-visibility.ts` to the *Project
  Layout* module map, next to the `process-reading.ts` and
  `attempt-activation.ts` entries, describing it as the terminal-side visibility
  seam (mirror of `activateAttempt` on the activation side).

## Risk & rollback

- **Behavior drift** — the integration + `process-reading` unit suites are the
  characterization net; they must stay green *unchanged* (only import paths may
  move). Any required assertion edit is a smell that behavior shifted — stop and
  re-examine.
- **Lost-CAS restore race** — move verbatim. Do not "fix".
- **`instrument` stage events** — easy to drop in the move. The
  `commit-terminal.test.ts` stage-event assertions guard it; keep them green.
- **`defensive` leak** — keep the try/catch in `commitTerminalManifest`, never in
  the module.
- Rollback is a clean revert of `src/reading-visibility.ts` + the
  `commitTerminalManifest` rewire — no schema, manifest, or R2 layout change.

## Done when

- [ ] `test/unit/reading-visibility/` covers publish/remove/restore × owned vs
      foreign × null similarity × stage-event emission.
- [ ] `commitTerminalManifest` no longer re-derives the owner gate in four+
      places; the three verbs each take the gate once.
- [ ] `src/process-reading.ts` no longer defines the five moved bodies; the
      `if (similarity) … else …` remove fork is gone.
- [ ] `npm test` green (integration readings + dead-letter + `process-reading/*`
      + `reading-visibility/*`), unchanged except import paths.
- [ ] `npm run typecheck` green; `web/` untouched.
- [ ] CONTEXT.md gains a *Reading visibility* term; AGENTS.md/CLAUDE.md module map
      lists `src/reading-visibility.ts`.

Commit per the `commit` skill after the GREEN rewire is fully green (one logical
commit, or split RED-test / GREEN-move / REFACTOR-rewire if preferred). Open a PR
off a feature branch — never commit to `main`.
