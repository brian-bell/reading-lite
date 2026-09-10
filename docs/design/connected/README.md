# Connected prototype handoff

Captured September 9, 2026; recaptured September 10, 2026 after a warm-palette
revision. Brian selected Connected as the direction to continue, then requested
less decorative copy, tighter whitespace, and a dedicated prototype. This package
preserves that version for future implementation. It supplies evidence for
[Phase 2, issue #337](https://github.com/brian-bell/reading-lite/issues/337); its
remaining design decisions still need review.

The September 10 revision moves the light-mode surfaces from white and pale stone
to parchment and cream, adds a tiled paper grain to the page and novelty panel,
gives cards a faint warm shadow, and prefers Charter/Iowan Old Style for the lead
and source text. See the [design specification](design-spec.md#color-tokens) for
the full token table.

## Start here

- [Design specification](design-spec.md): selected direction, visual values,
  interactions, simulation boundaries, and unresolved details.
- [Implementation checklist](implementation-checklist.md): acceptance checks and
  route/action inventory to carry into the new frontend.
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
[`dcfe7a0`](https://github.com/brian-bell/reading-lite/commit/dcfe7a04dd04034e581779a53156e0904769a344).
All screenshots in this package represent that commit's runtime source.
The handoff documentation is committed afterward so it can name the exact source
revision without a circular self-reference.

The [dedicated entrypoint](../../../web/prototypes/connected/README.md) shares its
screens, authored fixtures, navigation, and simulation with
[interface-directions](../../../web/prototypes/interface-directions/README.md).
Keep both directories when copying or archiving the prototype. The commit also
contains the package lockfile and Vite/TypeScript/test configuration needed to
reproduce it. Generated build directories and dependencies are intentionally
excluded from Git.

To inspect the frozen version without changing an active checkout, run from the
repository root, choosing an unused sibling directory:

```sh
git worktree add --detach ../reading-lite-connected-reference dcfe7a04dd04034e581779a53156e0904769a344
cd ../reading-lite-connected-reference/web
npm ci
npm run prototype:connected:dev
```

Use a supported development Node version (22.12+). Port 5174 must be free.
For the current host's tailnet interface:

```sh
npm run prototype:connected:dev -- --host 100.94.252.48
```

Open [Connected](http://100.94.252.48:5174/#/library). That running server is a
convenience; the commit, files, and captures are the durable reference. Other
hosts should use their own bind address. To build: `npm run
prototype:connected:build` from `web/`. Output: `web/dist-connected-prototype/`.

## Using this package in implementation

Read the specification and replay the walkthrough, then run the frozen source
for behaviors a still image cannot convey. Implement against the existing
backend contracts and the approved TanStack Start/separate Worker direction in
[issue #335](https://github.com/brian-bell/reading-lite/issues/335). Compare the
new UI at the recorded widths with the same fixtures. Treat the prototype's
scenario toolbar, deterministic status controls, disabled key field, and hash
routes as study mechanics. Resolve the open checklist items before treating
Phase 2 as complete.
