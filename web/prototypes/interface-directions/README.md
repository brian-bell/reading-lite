# Interface directions — issue 336

Three clickable interface prototypes for Brian's Phase 1 design review. This is
an isolated Vite entrypoint using the web project's existing React toolchain.
The production SPA entrypoint, backend, routing contracts, and deployments are
unchanged. Choosing TanStack Start and integrating the selected design belong
to later phases of issue 335.

Brian is continuing with the [dedicated Connected prototype](../connected/README.md).
It incorporates his requests to remove decorative interface copy and tighten
spacing. This comparison remains available as a reference; no elements to
borrow from the other directions have been requested.

## Open locally

From `web/`, run `npm ci` if needed, then `npm run prototype:dev`. Open the local
URL printed by Vite. Direct starting points on that origin:

- `/#/editorial/reading/attention` — spacious source/summary page, with novelty
  and connections below the reading.
- `/#/workbench/library` — compact archive, metadata, and a quick-look pane;
  desktop reading detail retains the result list.
- `/#/connected/reading/attention` — source/summary beside connections and
  tensions; a reading trail provides context and a return action.
- `/#/editorial/review` — the shared tasks, comparison, and decision form.

The direction switcher retains the current screen and reading for comparison.
Phone constrains the surface to approximately 390 px and activates the same CSS
container breakpoints as a narrow browser. The layout also adapts to an actual
phone-width window. Light and dark controls apply to all prototype screens.

## Shared tasks and samples

All directions use `samples.ts`: seven authored readings, invented authors and
publications, and fixed relationships. No production corpus or external media
is included. The on-screen review lists the same tasks for every direction:

1. Read the lead essay's summary and source, assess novelty, follow the garden
   connection and friction tension, and return to the original reading.
2. Search for `gardens`, filter by Knowledge, open the result, and return with
   filters intact. Try pagination and the long-title sample.
3. Capture a URL or import Markdown, check the pending state, reach ready or
   failed, and recover. Compare source, credential, provider-limit, and
   hosting-limit errors.
4. Enter the sample library from provider setup. Preview missing, connected,
   invalid, and removed keys, and retain library access after removal.
5. Use the global scenario selector for the sparse archive, unavailable source,
   deleted connection, long title, pending capture, and failed capture.

The source tab remains separate from the summary. Sparse mode does not pretend
to have enough archive history for comparisons. Removed targets retain the
connection explanation and provide a return path.

## Simulation boundaries

- There is no API proxy, provider client, backend import, or live processing.
- URL capture always uses the authored slow-work sample. It never fetches the
  URL. Markdown input is kept as plain source text in memory; its summary and
  novelty explicitly say analysis has not run.
- `Check status` deterministically advances a sample to the chosen outcome.
  `Retry sample` demonstrates a successful next attempt. This is a manual
  refresh concept, not a decision about production polling or retry semantics.
- Provider entry is disabled. Connect/replace/remove change only a sample
  state. OpenAI is presented as a proposed choice, with no model or price claim.
- Captures, filters, source tabs, and provider states last for the page session.
  Reload restores the shared fixtures. Only an explicitly saved design decision
  persists in browser storage (`reading-lite-design-decision-336`).
- Saving or downloading a decision does not post to GitHub or update the issue.
  The comparison form has no preselected direction. Brian's current direction
  is recorded above and in the dedicated prototype's README.

## Validation

From `web/`:

```sh
npm run prototype:test
npm run prototype:build
npm test
npm run build
```

Prototype tests have a dedicated Vitest configuration and are run separately
from the production SPA tests. Both test commands above are required when
changing this study's behavior. This keeps simulated navigation and browser
storage out of the normal SPA test run.

The prototype build checks its own TypeScript and outputs to the ignored
`web/dist-prototypes/` directory. The normal SPA build still outputs to
`web/dist/` and does not include the prototypes. Component tests exercise the
three reading/search/capture journeys, edge states, provider removal, Markdown,
comparison controls, keyboard tabs, pagination, and local decision persistence.
They do not measure visual layout or replace Brian's desktop/phone and theme
review. Connected was subsequently captured at desktop and phone widths in
light and dark themes for the September 9 handoff.

Validation on September 9, 2026: all 25 prototype checks and the dedicated,
comparison, and production SPA builds passed. Structured review reported no
actionable findings.
The existing SPA suite was inconsistent: one isolated run passed 130/130; later
runs, including one excluding all prototype tests, failed two login-return
storage assertions (128/130). The failures concern clearing `loginNext` after
magic-link continuation. Production code and existing tests were not changed.

## Phase 1 decision

Use **Review & choose** to select a direction, record elements to borrow and
notes, then save locally or download the decision as Markdown. Share that
decision in the task before proceeding to Phase 2. This prototype work does not
deploy a frontend or authorize implementation of the selected direction.
