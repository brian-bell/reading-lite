# Connected prototype handoff

Captured September 9, 2026; recaptured twice on September 10, 2026, after a
warm-palette revision and then an ink-on-paper revision. Brian selected Connected
as the direction to continue, then requested less decorative copy, tighter
whitespace, and a dedicated prototype. This package preserves that version for
future implementation. It supplies evidence for
[Phase 2, issue #337](https://github.com/brian-bell/reading-lite/issues/337); its
remaining design decisions still need review.

The warm revision moves the light-mode surfaces from white and pale stone to
parchment and cream, adds a tiled paper grain to the page and novelty panel,
gives cards a faint warm shadow, and prefers Charter/Iowan Old Style for the lead
and source text. The ink-on-paper revision that followed sets every piece of
reading matter — reading and page titles, library card titles, relationship
titles, and content headings — in that same serif at weight 400, leaving Inter
for UI chrome, and replaces the filled relationship blocks with paper cards
carrying an accent-ink left rule. See the
[design specification](design-spec.md#color-tokens) for the full token table.

## Start here

- [Design specification](design-spec.md): selected direction, visual values,
  interactions, simulation boundaries, and unresolved details.
- [Acceptance matrix](acceptance-matrix.md): route/action parity, screen states,
  and the approved status refresh contract.
- [Implementation checklist](implementation-checklist.md): acceptance checks to
  carry into the new frontend, by phase.
- [Fixture pack](fixture-pack.md): the named local seed states Phase 3/4
  slices develop against (`npm run seed:local`).
- [Screenshot index](screenshots.md): 22 desktop and phone captures with exact
  reproduction steps.
- [Walkthrough](walkthrough.html): offline screenshot replay with captions,
  previous/next controls, and optional playback. This is a sequence of captured
  states, not a continuous video or a replacement for the interactive prototype.
- [Capture manifest](capture-manifest.json): filenames, dimensions, source revision,
  and SHA-256 hashes for every screenshot.
- [Validation record](validation.md): checks, results, and limitations.

## Frozen source

The runnable reference is commit
[`128c7cd`](https://github.com/brian-bell/reading-lite/commit/128c7cdf926cbcbb8206f5b654208aa3456c7d51).
All screenshots in this package represent that commit's runtime source.
The handoff documentation is committed afterward so it can name the exact source
revision without a circular self-reference.

The prototype source was removed from the working tree with the legacy `web/`
SPA (reading-lite-gh335.3); this commit is now its only copy. There, the
[dedicated entrypoint](https://github.com/brian-bell/reading-lite/tree/128c7cdf926cbcbb8206f5b654208aa3456c7d51/web/prototypes/connected) shares its screens,
authored fixtures, navigation, and simulation with
[interface-directions](https://github.com/brian-bell/reading-lite/tree/128c7cdf926cbcbb8206f5b654208aa3456c7d51/web/prototypes/interface-directions), and `web/`
holds the package lockfile and the Vite/TypeScript/test configuration needed to
reproduce it. PR #352 was merged with a merge commit so that this SHA stays
reachable from `main`.

To run it without changing an active checkout, from the repository root,
choosing an unused sibling directory:

```sh
git worktree add --detach ../reading-lite-connected-reference 128c7cdf926cbcbb8206f5b654208aa3456c7d51
cd ../reading-lite-connected-reference/web
npm ci
npm run prototype:connected:dev
```

Use Node 22.12+. Port 5174 must be free (the `app/` dev server uses it too).
Add `-- --host <bind-address>` to serve on another interface, then open
`http://<bind-address>:5174/#/library`. To build: `npm run
prototype:connected:build` from that `web/`. The commit, the specification, and
the captures are the durable reference.

## Using this package in implementation

Read the specification and replay the walkthrough, then run the frozen source
for behaviors a still image cannot convey. Implement against the existing
backend contracts and the approved TanStack Start/separate Worker direction in
[issue #335](https://github.com/brian-bell/reading-lite/issues/335). Compare the
new UI at the recorded widths with the same fixtures. Treat the prototype's
scenario toolbar, deterministic status controls, disabled key field, and hash
routes as study mechanics. Resolve the open checklist items before treating
Phase 2 as complete.
