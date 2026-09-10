# Validation record

September 9, 2026 (original capture); September 10, 2026 (warm-palette
recapture, then ink-on-paper recapture). The screenshots in this package are the
ink-on-paper round, captured from
`128c7cdf926cbcbb8206f5b654208aa3456c7d51`; the two sections below it record
earlier rounds against the commits they name. These results describe the local
capture environment, not CI.

## September 10 ink-on-paper recapture

| Check | Result |
| --- | --- |
| `npm run prototype:test` in `web/` | 25/25 passed against the captured commit |
| `npm run prototype:connected:build` | Passed |
| `npm run prototype:build` | Passed |
| Connected browser capture | All 22 JPEGs recaptured via Chrome DevTools MCP at the same 1440 × 930 and 390 × 658 pixel sizes as the previous round; each capture started from a fresh page load, and every image was inspected against its manifest caption |
| Handoff assets | All 22 hashes and dimensions recomputed into `capture-manifest.json`, with `walkthrough.html` scene data and the `screenshots.md` pixel column regenerated from it; dimensions were unchanged, so the index table needed no edit |

The serif reading matter, the paper relationship cards with their accent-ink (and
danger) left rules, and the fixed single-line key-point numbers on phone widths
are all visible in this round's captures.

Two captions required a step correction rather than a different capture. The
manifest described the phone viewport as 390 × 844 and the unavailable-source
desktop viewport as 1440 × 1000, which were the requested CSS sizes rather than
the pixels actually written; both now name the captured size, matching what
`screenshots.md` already said. The phone connections capture is taken at the
foot of the page rather than at the smooth-scroll landing point, because at
390 × 658 the “Back to the reading” action that its caption promises falls just
below the fold.

This round did not rerun `autoreview` or the production SPA test suite; the
captured commit changed only prototype CSS and the design spec, not Worker or
production SPA source. See the September 9 record below for those results.

## September 10 warm-palette recapture

Superseded by the round above. Runtime source for this round:
`dcfe7a04dd04034e581779a53156e0904769a344`.

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

## Capture notes (all rounds)

The captures are viewport screenshots, not complete page exports. Long pages
extend below the image; the phone connection panel has its own scrolled capture.
Every saved image is 1440 × 930 (desktop) or 390 × 658 (phone), and those pixel
sizes have held across all three rounds, so the images stay directly comparable.
Earlier rounds reached them by requesting 1440 × 1000 and 390 × 844 CSS px and
landing on the smaller visible content area; the ink-on-paper round emulated the
captured sizes directly. The preview's Desktop layout toggle remains selected
throughout, and the browser viewport drives responsiveness. No native phone
hardware or Safari/browser matrix was tested.

The screenshots retain visible prototype controls/disclosures. Sample names and
article text are authored fixtures. The capture manifest records raw JPEG hashes;
images have not been retouched. This is visual reference coverage, not an
accessibility audit, production integration test, or proof of every state.
The mobile numbered-list wrapping seen in the earlier rounds is fixed in the
captured commit and no longer appears in these images.

Worker tests were not rerun for this frontend prototype/documentation capture.
No Worker/API/production code, provider calls, deployment, or data migration is
part of this handoff. The source checkpoint preserves the original branch base
rather than merging newer main commits into the reference.
