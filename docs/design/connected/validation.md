# Validation record

September 9, 2026 (original capture); September 10, 2026 (warm-palette recapture).
Runtime source: `dcfe7a04dd04034e581779a53156e0904769a344`. These results describe
the local capture environment, not CI.

## September 10 recapture

| Check | Result |
| --- | --- |
| `npm run prototype:test` in `web/` | 25/25 passed (run before the recapture, against the same commit; no source changed since) |
| `npm run prototype:connected:build` | Passed (same commit) |
| `npm run prototype:build` | Passed (same commit) |
| Connected browser capture | 22 JPEGs recaptured via Chrome DevTools MCP at 1440 × 1000 and 390 × 844 CSS px, downsampled to 1440 × 930 and 390 × 658 pixel images |
| Browser interactions exercised during capture | Source/Summary tab switch, connection follow and return, search and tag filter, URL save through pending and Check status to Ready, Failed capture recovery view, Markdown tab, Provider preview states, mobile Connections & tensions jump and return, all seven sample scenarios |
| Handoff assets | All 22 image hashes and dimensions recomputed and written into `capture-manifest.json`; `screenshots.md` and `walkthrough.html` regenerated from it |

This recapture did not rerun `autoreview` or the production SPA test suite;
only CSS tokens, the design spec, and screenshot assets changed, not app code
or production source. See the September 9 record below for those results,
still valid because no source file they cover has changed since.

## September 9 original capture

| Check | Result |
| --- | --- |
| `npm run prototype:test` in `web/` | 25/25 passed across comparison and Connected test files |
| `npm run prototype:connected:build` | TypeScript and dedicated Vite build passed |
| `npm run prototype:build` | TypeScript and comparison Vite build passed |
| `npm run build` in `web/` | Production SPA TypeScript/build passed |
| `npm test` in `web/` | 128/130 passed; two existing login-return storage failures |
| Structured closeout review (`autoreview --mode local`) | No accepted/actionable findings in runtime prototype/config changes |
| Connected browser capture | 22 JPEGs visually inspected at 1440 × 1000 and 390 × 844 CSS px; representative light/dark and failure states |
| Browser interactions | Source switch, connection follow/return, retained search/tag filter, URL pending-to-ready, mobile connection jump/return exercised |
| Browser errors | No error-level entries returned by the browser log check at capture closeout |
| Handoff assets | All 22 image hashes/dimensions, local Markdown links, and replay JavaScript syntax verified |
| Walkthrough browser check | Previous/next, scene selection, image loading, playback advancement/pause, and final-scene boundary checked; no error-level log entries |

The two SPA failures are `returns to Security after Continue when next is the
security path` and `returns to a localStorage next after a new-tab verify hop`
in `web/src/App.test.tsx`. Both expect the consumed login-next storage value to
be cleared; the old value remains. Earlier runs reproduced them with prototype
tests excluded, and one earlier isolated SPA run passed 130/130. They also
reproduce on `main` outside this branch, so they predate this work and are not
a regression from it. Production source/tests were not changed to address this
separate problem.

Runtime review command: the installed `autoreview` helper with `--mode local`
and a prompt describing the isolated fixture-only prototype. Review covered the
runtime/configuration changes before their source checkpoint; subsequent handoff
prose, screenshot files, and replay received local link/asset and browser checks.

## Capture notes (both rounds)

The captures are viewport screenshots, not complete page exports. Long pages
extend below the image; the phone connection panel has its own scrolled capture.
Desktop captures request 1440 × 1000 CSS px; phone captures request 390 × 844.
The saved images are downsampled to the visible content area (1440 × 930 and
390 × 658), excluding browser chrome outside the CSS viewport. The preview's
Desktop layout toggle remains selected in both, and the browser viewport drives
responsiveness. No native phone hardware or Safari/browser matrix was tested.

The screenshots retain visible prototype controls/disclosures. Sample names and
article text are authored fixtures. The capture manifest records raw JPEG hashes;
images have not been retouched. This is visual reference coverage, not an
accessibility audit, production integration test, or proof of every state.
The mobile numbered-list wrapping is recorded in the specification as an issue
to resolve in implementation.

Worker tests were not rerun for this frontend prototype/documentation capture.
No Worker/API/production code, provider calls, deployment, or data migration is
part of this handoff. The source checkpoint preserves the original branch base
rather than merging newer main commits into the reference.
