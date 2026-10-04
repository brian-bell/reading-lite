# Next direction: desk, threads, catalog

Specified October 3, 2026 for the epic reading-lite-kl7y, from the prototype
built in reading-lite-4tvj (PR #588). It follows the shipped
[Connected](../connected/README.md) design. Everything Connected settled stays
in force: tokens, type, navigation column, reading surface, status card,
relationship cards, return trail, status refresh contract, failure categories.
This package covers only what the new direction adds or changes.

## Start here

- [Design specification](design-spec.md): decisions, the data contract for
  each new read and write, derivation rules, routes, and screen order.
- [Acceptance matrix](acceptance-matrix.md): routes and actions with their
  outcomes, the states each new screen handles, and the checks each slice
  owns.

Browser evidence, screenshots and the walkthrough come with the release gate
(reading-lite-kl7y.11), from the real app rather than the prototype.

## Frozen source

The runnable reference is commit
[`0507dc84`](https://github.com/brian-bell/reading-lite/commit/0507dc84f3e362965df2e3b749944aeca7f6300c),
`app/prototypes/next-directions/`. Its source is deleted at the release gate
(decided October 3, 2026), so this commit becomes its only copy, as `128c7cd`
is for Connected. To run it without disturbing a checkout, from the repository
root:

```sh
git worktree add --detach ../reading-lite-next-direction 0507dc84
cd ../reading-lite-next-direction/app
npm ci
npm run prototype:dev
```

Use Node 22.12+. Vite serves on port 5175. The prototype's
[README](https://github.com/brian-bell/reading-lite/blob/0507dc84f3e362965df2e3b749944aeca7f6300c/app/prototypes/next-directions/README.md)
lists its starting hashes, scenarios, and tasks.

## Using this package

Each child of reading-lite-kl7y is a vertical slice: backend read or write,
schema in `src/schemas/`, `docs/openapi.yaml`, a `FrontendReads` method where
the server render needs it, the screen, tests, and browser evidence. Port the
prototype's pure derivations from `study.ts` with their tests where the
specification keeps them, and replace its fixtures with the
[fixture pack](../connected/fixture-pack.md) extended in reading-lite-kl7y.2.
The prototype's scenario control, sample outcomes, study clock, hash routes,
and token-overlap meaning search are study mechanics, not behavior to carry
over.
