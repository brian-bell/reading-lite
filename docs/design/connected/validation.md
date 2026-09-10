# Validation record

September 9, 2026. Runtime source: `e121cf1cd669cd6d84c547bcbcba3abba68b9bab`.
Host Node: v25.8.1. These results describe the local capture environment, not CI.

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
tests excluded, and one earlier isolated SPA run passed 130/130. Production
source/tests were not changed to address this separate problem.

Runtime review command: the installed `autoreview` helper with `--mode local`
and a prompt describing the isolated fixture-only prototype. Review covered the
runtime/configuration changes before their source checkpoint; subsequent handoff
prose, screenshot files, and replay received local link/asset and browser checks.

The captures are viewport screenshots, not complete page exports. Long pages
extend below the image; the phone connection panel has its own scrolled capture.
Desktop captures use 1440 × 1000; phone captures use 390 × 844. The preview's
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
rather than merging five unrelated newer main commits into the reference.
