# app — TanStack Start frontend

The replacement for the `web/` SPA, on its own Cloudflare Worker. Topology,
approved dependencies, caching, and rollout are in
[ADR 0003](../docs/decisions/0003-frontend-worker-topology.md); the design is the
[Connected specification](../docs/design/connected/design-spec.md). Node 22.12+
is required; the operator's Node 20 `ops` path does not build this package.

## Commands

```sh
npm ci
npm run dev          # :5174; /api proxies to the backend's `npm run dev` on :8787
npm run typecheck
npm test             # unit/component tests, plus the service-binding check
npm run build        # dist/client (assets) and dist/server (Worker + wrangler.json)
npm run test:smoke   # runs the built Worker in workerd; build first
npm run test:browser # browser evidence: themes, viewports, axe, keyboard; build first
npm run test:browser:ci # the essential subset CI runs
```

Build a deployable environment with `CLOUDFLARE_ENV=staging` or
`CLOUDFLARE_ENV=production`. Production deploys to `next.readinglite.ai` after
every production backend release; staging deploys to
`next-staging.readinglite.ai`, `staging.readinglite.ai`, and
`staging.readinglite.app` by manual dispatch. See
[New-frontend preview hosts](../docs/operations.md#new-frontend-preview-hosts).

To sign in locally, request a link at `http://127.0.0.1:5174/login` and open
`verify_url` from `/api/dev/mailbox?email=…` on the backend. The backend builds
that link from `WEB_BASE_URL`, which points at the old SPA on :5173, so start
the backend with `npm run dev -- --var WEB_BASE_URL:http://127.0.0.1:5174` or
change the link's port. The session cookie ignores the port, but the stored
return path is per origin.

## Rules this package enforces

- **Backend paths.** `/api`, `/api/*`, `/health`, and `/mcp*` return 404 from
  `src/start.ts` before rendering. The backend's more specific routes own them;
  the frontend never proxies.
- **Caching and policy.** Every rendered response is `Cache-Control: private,
  no-store` and carries `Content-Security-Policy: img-src 'self' https: data:`
  (`src/server/request-policy.ts`): the page's own images, the remote `https:`
  images a reader loads in the Source view, and the `data:` grain in
  `tokens.css`, nothing broader. Only `/assets/*` (content-hashed) is publicly
  cacheable, via `public/_headers`.
- **Service bindings.** Each environment's `BACKEND` binding in
  `wrangler.jsonc` names the backend Worker of the same environment and its
  `FrontendReads` entrypoint. `test/backend-bindings.test.ts` reads both configs
  through Wrangler and fails on a crossed binding or a missing entrypoint.
  Environments do not inherit bindings. Both deploy workflows then run
  `node scripts/check-build.ts <env>` on the built `dist/server/wrangler.json`,
  which is what `wrangler deploy` uploads: it must target that environment,
  match `wrangler.jsonc` on name, routes, services, and `workers_dev`/
  `preview_urls`, and pass the same binding guard.
- **Identity.** Server renders read `whoami` through `BACKEND`
  (`src/identity-query.ts`), forwarding only the incoming `Cookie` header and
  host; the browser calls same-origin `/api/whoami`. Both map the response in
  `src/identity.ts`: 401 is signed out, any other failure (403 included) shows
  neither the account menu nor the sign-in link. `getRouter()` creates the
  QueryClient, so each request has its own, and dehydrates it into that
  response only. Browser writes use `src/api/client.ts`, which takes the CSRF
  token from the caller's QueryClient, never from module state. Local
  `npm run dev` reaches the backend's `npm run dev` for both paths; the smoke
  tests bind a stub entrypoint (`smoke/backend-stub.js`).
- **Sign-in.** `/login` requests a magic link (Turnstile when login-options
  returns a site key; `?step_up=1` locks the signed-in email). `/auth/verify`,
  the mailed path, and its `/login/verify` alias redeem the fragment credential
  only on Continue. Return paths go through `src/auth/return-path.ts`: an
  allowlist of `/` (`q`, `tag`, `offset`), `/readings/:id` (`view`), `/save`,
  and `/account/security`, with other parameters dropped. The path is stored in
  localStorage when a link is requested, for the tab that opens the link, and
  cleared whenever it is consumed. Pages under `src/routes/_authed` redirect a
  signed-out reader to `/login?next=<URL>`; signed out, `/` shows the form in
  place.
- **Session state.** `src/auth/session.ts` builds the request's QueryClient.
  A 401 from any query or mutation shows "Your session ended" at that URL,
  with sign-in back to it; a 403 is never a sign-out, and an identity that
  cannot be determined shows its own retryable state rather than the sign-in
  form. Sign-in and sign-out drop every account-scoped query. A failed logout
  revokes nothing, so `signOut` re-reads identity and keeps the reader signed
  in when the session survived; when that read answers as a different reader,
  the previous account's queries are dropped and the menu reports an account
  change with a reload, not a failed sign-out (acceptance matrix, Account
  changed).
  Single-use sign-in material stays in component state, never in module state,
  because these modules are loaded during server renders too. The legacy SPA's
  `reading-lite.bearerToken` entry is removed at boot
  (`src/auth/legacy-storage.ts`) until the old SPA is retired. Search
  parameters stay plain strings (`src/search.ts`).
- **Account.** `/account/security` lists browser sessions from
  `GET /api/auth/sessions` in the browser (ADR 0003: account pages are not
  server-rendered). Revoke one is `DELETE /api/auth/sessions/:id`; revoke-all
  is `POST /api/auth/sessions/revoke-all` after a confirm dialog. Revoking this
  device or every session drops the account without calling logout — the
  backend already expired the cookie — and the signed-in guard sends the reader
  to sign in. 403 and 412 are the shared state pages (403 offers Back to
  library), a 401 is the shell's expired-session page, offline is a notice over
  whatever was loaded, and a 5xx is the retryable server error. The list and
  writes are pinned with `x-expected-tenant` like the library's reads. The
  backend enforces that pin on `/api/auth/sessions…` (`requireExpectedTenant`),
  so a mid-page cookie switch 412s the list instead of showing the other
  account's sessions.
- **Library.** Signed in, `/` reads the page `?offset=` names from `GET /api/readings`
  during the server render through `BACKEND.list` (`src/library-query.ts`), so
  it is dehydrated and hydration makes no list request; a client-side visit
  calls same-origin `/api/readings`. Both paths map the response in
  `src/library.ts` as reading detail does (403 and 412 are values, 401 and
  anything else throw) and pin the read with `x-expected-tenant`. Only `q`,
  `tag`, and `offset` cross the binding; the 20-row page size is the backend's.
  Signed out, the loader reads nothing and the sign-in form renders in place.
  `src/library-search.ts` snaps `offset` as the current SPA does (parseInt,
  down to a 20-row page, the first page written without it) but keeps the
  URL's own string, so no spelling redirects. Previous and Next are links to
  the neighbouring page and are not preloaded, so a pointer remaining on Next
  after a step does not fetch the following page; an offset past the end
  offers the first page. The browser-evidence stub adds 24 generated rows
  past the fixture pack's 19 for pages two and three (`e2e/library-page.js`);
  the pack is unchanged.
  Each card is a title link (the URL when there is no title) stretched over
  the card, the summary lead clamped at three lines, and the hostname; a
  reading that is not simply ready carries a text badge above the title
  (`src/library-card.ts`, #415): "Processing" for pending rows and running
  attempts, "Failed" with the failure category's headline, and "Reprocess
  failed" on a ready row whose last attempt was a failed reprocess. A row's
  tags are links under the hostname, raised above the stretched title link,
  each to the library filtered by that tag.
- **Library filters.** `q` and `tag` (#417) are passed to the backend as the
  URL spells them (it trims and lowercases); an empty one is left out of the
  URL. The filter bar's form navigates to the trimmed draft, and each active
  filter is a chip whose link removes it; every filter change drops `offset`
    (`searchForFilters`), keeping any other parameter in place. The library
  stays mounted through a filter change, but the control used is gone once
  it lands (a chip, an empty page's link, a tag with the rows), so it records
  where focus goes: the field after a search or a clear, the chip after a
  tag. The request names the filters it navigates to and is dropped unless
  those are the filters that arrive. Tag links and chips are not preloaded;
  the tag a page is filtered by is text on its cards. An empty
  page names the filters (`libraryEmptyOf`, `libraryEmptyCopy`): "No readings
  yet." with Save a reading, "No readings match “q”" and/or "tagged T" with
  Clear search and Clear tag, and a page past the end with its number and
  First page. The browser-evidence stub answers the `reader-empty` session
  with no rows for the empty state.
- **Library states.** `src/library-state.ts` picks the acceptance matrix's
  common state from the list query (#416), and the page renders the same
  state components as reading detail (`src/components/ReadingStates.tsx`):
  403 and 412 replace the library with their own heading: 412 offers Reload,
  and 403 offers nothing, since the matrix's "Back to library" has nowhere to
  go from the library itself and a 403 never ends the session. A 401 is the
  shell's expired-session page at the library's URL, and any other failure is
  the retryable server error. A page that replaces the one on screen takes
  the focus it held (a state page for the library's, the library for a state
  page's Retry), so it is announced; `PageStateFocus` in
  `src/components/PageHeading.tsx` is that mechanism, shared with the save
  page, and the marker it renders must stay the page's immediate sibling for
  its cleanup to see the focused element. Offline is a notice with Retry above
  whatever was loaded: React Query pauses a fetch started without a network
  (`fetchStatus: "paused"`) and continues it on `online`, and a fetch that
  threw while offline (`NetworkError.offline`, recorded by `apiFetch` when it
  threw) reads the same way until the reconnect refetch answers. Loading keeps the "Library" heading
  with `aria-busy` on the content region and "Loading…" after 300 ms. The
  route's loader waits for the page on the server and only starts it in the
  browser (`loadLibraryPage`), so a page change mounts the busy page at once
  and a read that fails or cannot run shows its state there. A list that
  fails during the server render is not dehydrated, so the HTML is the busy
  library and the browser's own request shows the outcome, as for a reading.
- **Library refresh.** A page with a row being processed (`isProcessing`) is
  asked for again every 15 s (#409) on the same bounded watch as a reading
  (`src/status-refresh.ts`, `src/components/use-status-watch.ts`): paused while
  the tab is hidden, stopping at 16 minutes, after three failed checks, or once
  no row on the page is active. The watch belongs to the page's query, so
  another page or filter, or a reload, starts a new one, and a page with no
  active row makes no timed requests. A finished row's badge changes in place,
  with nothing announced and focus left where it was. A failed check keeps the
  rows; after three, a quiet "Couldn't check status." note (not a live region,
  no button) stays until another read of the page answers. A read that fails
  offline is the offline state at once, and one with no check to blame (no
  active row, or past the cap) is still the server-error state.
- **Reading detail.** `/readings/:id` reads the reading during the server
  render through `BACKEND` (`src/reading-query.ts`, the same isomorphic shape as
  identity), so it is dehydrated into the page and the browser does not ask
  again — except while the reading is being processed. Then the page checks
  its status on the bounded schedule of the [status refresh
  contract](../docs/design/connected/acceptance-matrix.md#status-refresh-contract)
  (`src/status-refresh.ts`, `src/components/use-status-watch.ts`): 3 s, then
  5 s, then 15 s, paused while the tab is hidden, stopping at 16 minutes or
  after three failed checks, with "Check status" for one more at any time. A
  failed check keeps the reading on screen and the card says so. When the
  attempt finishes, a polite live region says how, and the library's queries
  are invalidated. `src/reading.ts` maps the response for both paths: the statuses with a
  page of their own — 404, 403, and the 412 expected-tenant mismatch — are
  values, so they travel in the dehydrated cache, while 401 and anything
  unexpected throw, the first into the expired-session page and the second into
  a retryable server-error state. The read is pinned with `x-expected-tenant` to
  the account the page was rendered for, so another tab signing this browser in
  as someone else is caught rather than silently rendering their reading.
  `src/reading-failure.ts` maps a failed manifest's `error.code` and stage to
  the acceptance matrix's categories, pinned against the fixture pack by
  `test/reading-failure.test.ts`. A 200 body is parsed through the zod
  projection in `src/reading.ts`: only `id`, `url`, and `status` are required,
  every other field the app reads is optional and null-tolerant, unknown fields
  pass through, and a malformed field the app does read is the retryable
  "unexpected body" error rather than a crash in a component.
- **Source view.** `?view=source` selects the Source tab (`src/reading-view.ts`:
  any other value is Summary); the tabs (`src/components/ViewTabs.tsx`) follow
  the ARIA pattern and switch by replacing the history entry with the
  location's state kept, so Back leaves the reading and a reload keeps the view.
  Only ready readings have tabs. The extracted Markdown is fetched in the
  browser from same-origin `/api/readings/:id/content` once the view is
  selected (`src/source-query.ts`, `src/api/source.ts`), never in a loader or
  through `BACKEND`, so it is not part of the server render; a manifest whose
  `content_status` is not `captured` shows the unavailable state without a
  request, and a 404 shows it after one; a 403 and the 412 mismatch show their
  own states in the view, with no Retry. `src/components/ReadingSource.tsx`
  renders through `remark-gfm` and `rehype-sanitize` with no raw HTML, source
  headings demoted one level under the title, links opening in a new tab with
  `rel="noopener noreferrer nofollow"` and site-relative hrefs resolved against
  the reading's URL (`src/components/ExternalLink.tsx`, shared with the
  summary), and every image as its alt text and host with a "Load image"
  button offered for `https:` URLs only; a loaded image carries
  `referrerpolicy="no-referrer"` and stays loaded across a tab switch. Loading
  and failure (with Retry) stay inside the view; the novelty panel sits below
  either view at the same readable width.
- **Details.** One native `<details>` at the foot of the reading column
  (`src/components/ReadingDetails.tsx`), collapsed in the server render and
  operable from the keyboard without script. Keywords, people, organizations,
  and the similarity numbers behind the novelty verdict come from the manifest
  and are in the page from the start; a missing value is omitted, never shown
  as a dash. Diagnostics and the attempts they carry are fetched in the browser
  from same-origin `/api/readings/:id/diagnostics` only once the section is
  opened (`src/diagnostics-query.ts`, `src/api/diagnostics.ts`), pinned like
  the reading, through the loose projection in `src/reading-diagnostics.ts`;
  loading, failure with Retry, and the 403/412 states stay inside the section.
  "Open as file" fetches the extracted Markdown or the raw capture on click
  (`src/api/files.ts`) and opens it in a new tab as a blob URL, as the SPA
  does — but always as `text/plain` (`src/reading-files.ts`): a blob page runs
  in this app's origin, so a raw HTML capture opened with its stored type
  would execute the captured page's scripts against `/api/*` with the session
  cookie. The extracted file follows the Source view's `content_status` rule;
  the raw file is always offered and a 404 says so in place.
- **Connections and tensions.** Cards come from the manifest's `connections`
  and `tensions` plus the read-time `relationship_targets` map
  (`src/reading-relationships.ts`): an id absent from the map is the removed
  card, a pending or failed target links with a text badge. Following a card
  records a trail in router history state (`src/reading-trail.ts`): at most ten
  hops of previous id, title, and reason, stamped with the document load that
  wrote them. Only a trail from the current load renders, so a reload or a
  shared link keeps the reading and drops the trail, and the server never
  renders one. "Back to {title}" is history back when there is history, else a
  link carrying the trail popped by one hop. On phones the "Connections &
  tensions" jump and "Back to the reading" move focus without touching the URL,
  scrolling smoothly only under `prefers-reduced-motion: no-preference`.
- **Save.** `/save` is under `src/routes/_authed` (#431), so signed out it
  redirects to `/login?next=%2Fsave` rather than rendering. The page
  (`src/components/SavePage.tsx`) is the ARIA tabs component with one tab, URL,
  selected in local state rather than the URL, so Markdown can join it later
  without a deep link to maintain. `src/save.ts` holds both pure halves:
  `saveUrlProblem` mirrors the backend's `webUrl()` in `src/schemas/api.ts`
  (parseable, http(s) only) so an obvious typo costs no round trip, and
  `submitFromResponse` maps what `POST /api/readings` answered — 202 to the
  accepted reading (only `id` is read; the reading's own page reads its
  status), 400 to a field error in the backend's own words, a 200 manifest or a
  409 that names an id to the reading that already owns the URL, and 403 and
  412 to the shared states as values, so a 412 keeps its `acting_tenant` as the
  reads do. What a 200 says about that reading decides the notice it opens with
  (#432): ready is "Already in your library", being processed — `isProcessing`
  in `src/reading.ts`, shared with the status card and the library badge — is
  "Already saved and still processing", and a 409 names an id and no state, so
  it says nothing. A rejection from either side renders in the same place: a
  paragraph under the field, linked by `aria-describedby` with `aria-invalid`
  on the input, and focus moved back to it. Anything left throws an `ApiError`,
  so a 401 is the shell's expired-session page and the rest is the retryable
  server error. The form's submit and the offline notice's Retry are the same
  call, so a retry cannot slip past the field's rule, and Save is
  `aria-disabled` rather than `disabled` while a save runs: a disabled button
  is blurred, and the reader would lose the place the next state page is meant
  to take. A save that lands sets a polite `role="status"` message — "Saved."
  only when something was saved, "Opening the reading…" for one already in the
  library — invalidates every `["library", …]` query, and navigates to
  `/readings/:id`; the form moves no focus itself, so the route change's
  heading focus stands. Those steps run in `mutate`'s own callbacks, not the
  mutation's: query-core keeps a paused mutation after the page is gone and
  resumes it later, and a mutation-level callback would then navigate a reader
  who has moved on. The save drops that reading from the cache too, which never
  goes stale on its own, so the page cannot render a copy read before the save
  under a notice taken from the manifest the backend just answered with. That notice
  travels in router history state (`src/save-notice.ts`), never in the URL, and
  renders at the top of the reading column above the status card, in a
  `role="status"` paragraph that is always there so what lands in it is
  announced. It belongs to the history entry like the return trail, and is
  stamped with the document load the same way: Back to that entry shows it
  again, while a reload or a plain link to the reading shows none, and the
  server never renders one. Offline has the library's two shapes and they differ here:
  a save held paused is sent when the connection returns, so its notice says
  so and offers no Retry (a second submit would claim the URL twice), while a
  save that failed with the network already gone offers the Retry. A refusal
  that will pass keeps the form too (#433): `submitFromResponse` reads a 429
  that names a `limit` as `limited` (that window and the `reset_at` it can
  format) or, for the usage guard's own body, `guard-unavailable`, and any 503
  as `unavailable` with the `id` it may name. `limit` is a string, not an
  enum, for the reason `reading.ts` keeps the backend's enums open: a window
  added later gets the generic "You've reached a limit." rather than costing
  the reader the URL they typed. Each renders as an inline `InlineNotice`
  above the tabs — "You've reached the request rate limit."
  ("hourly"/"monthly" reading limit for the quotas), plus " It resets at …"
  when the reset parses; "Limits can't be checked right now."; "Saving is
  unavailable right now." with an "Open the reading" link only when the 503
  named one, and never the operator-facing error string. A 503 that names a
  reading is a failed owner the backend rewrote in place, so that reading's
  query is dropped and the library invalidated before the link is offered, as
  a 202 does. Every one offers "Try
  again", live immediately rather than counting down to a reset, which is the
  same `trySubmit` the form and the offline Retry use. The sentence is also
  set as the page's polite announcement, and the notice renders with
  `live={false}`, because the `form-status` region was already on the page and
  a region inserted with its text inside it is not announced. Pressing "Try
  again" moves focus back to the field first, since the button it belongs to
  goes with the notice, and a save the field itself refuses clears the notice
  too, so a field error is never shown beside a retry for the URL just edited.
  A 429 that names neither a limit nor the guard still throws. `src/api/save.ts` is
  the browser's POST, with the CSRF token and the tenant pin as the library's
  reads have.
- **Theme.** A `theme` cookie (`system`, `light`, `dark`; no identity) is read
  during the server render and sets `<html data-theme>`. System leaves the
  attribute off and follows `prefers-color-scheme`. Tokens in
  `src/styles/tokens.css` use `light-dark()`.

`src/routeTree.gen.ts` is generated by the router plugin during `dev` and
`build`. It is committed so `typecheck` works on a fresh checkout.

## Browser evidence

`npm run test:browser` (after `npm run build`) runs the Playwright suite in
`e2e/`. It serves the built Worker through Wrangler's test harness — the same
arrangement as `test:smoke`, so Workers Assets and the `BACKEND` service
binding are real — with `e2e/backend-stub.js` standing in for the backend. The
stub answers `whoami` for a canned session and serves reading detail from
`e2e/fixtures/fixture-pack.json`, the fixture pack (#366) projected the way
`GET /api/readings/:id` projects it. The browser clock is pinned to the
snapshot's `generated_at`, so the `pending` fixture stays pending and evidence
is reproducible.

Every covered route and state runs at 390 px and 1440 px in light and dark:
axe (WCAG 2.2 AA), the keyboard pass (skip link first and landing on main,
focus order, a visible focus indicator on every tab stop, no focus trap), and a
layout check that no positioned panel escapes the viewport fail the run. The
two skip-link checks are about the document rather than the theme, so each
viewport runs them in its light project only; the tab walk runs in all four.
Reduced motion and zoom — 200% of the desktop window, and the 320 px reflow
floor — run for the shell. `e2e/specs/reading-cache.spec.ts` (the
`reading-cache` project) records every request a server-rendered reading page
makes and fails if the browser asks for the reading or identity again after
hydration, or when the reader leaves for the library and returns (#370).

The focus indicator is measured on the element the reader sees, as a rendering
that changes when focus arrives: the theme options focus a transparent radio
whose ring belongs to the label, so reading the focused element's own outline
would keep passing after that rule broke. `e2e/specs/focus-check.spec.ts` (the
`checks` project) suppresses the rule and fails if the check does not. Screenshots go to `e2e/screenshots/` and are
uploaded by CI for review; they are not pixel-diff baselines, because the
design spec uses system fonts and wrapping differs by machine.

CI runs the essential scope, `npm run test:browser:ci` (`e2e/scope.ts`): the
cases marked `essential` in `e2e/coverage.ts` — the major states of each route:
the library signed out, signed in, searched, empty, session-ended, and failed;
sign-in and save; a ready, pending, failed, and missing reading; one trail hop;
Source; open Details; and the account sessions list — in the `phone-dark` and
`desktop-light` projects, so both viewports and both themes are still covered,
plus the behaviour specs and `checks`. Reduced motion and zoom, the other
matrix projects, and the remaining states run only in the full
`npm run test:browser`, which is the local verification before a frontend
change ships.

Extending it:

- **A route or state:** add a case to `e2e/coverage.ts`. Every project picks it
  up; mark it `essential` only if it is a major state of a route, so CI stays
  short. `prepare` reaches states that need interaction, as the open account
  menu does. A state reached by navigating between readings needs
  `serveReadingsInBrowser` (`e2e/test.ts`) first: the frontend Worker answers
  `/api/*` with 404 by design, so the browser's own reading requests are served
  from the fixture pack by a Playwright route. `e2e/specs/reading-trail.spec.ts`
  (the `reading-trail` project) covers Back, reload, and the phone jump (#371).
  A case whose state needs an answer to a write routes it in `stub`, fulfilling
  only that method and calling `route.fallback()` for the rest, so the page's
  own reads still reach the Worker (`save-rejected-url`, `save-already-saved`).
- **A behaviour only a browser shows:** add a spec under `e2e/specs/` and a
  project in `playwright.config.ts` that matches it, as `save` does for the
  request the save form makes, its client-side navigation (#431), and the
  one-time notice a reload drops (#432).
- **A fixture state:** add it in the repo root's `test/fixtures/local-seed.ts`,
  run `npm run fixtures:app` there, and commit the regenerated
  `e2e/fixtures/fixture-pack.json`. `test/unit/fixtures/app-fixture-pack.test.ts`
  fails while it is stale.
- **A viewport or theme:** add a project in `playwright.config.ts`.
- **Another host:** `E2E_BASE_URL=https://host npm run test:browser` runs the
  same suite against a running host instead of starting the harness, with
  `E2E_SESSION_COOKIE` supplying a real session. Its reading cases are still
  pinned to fixture ids, so it cannot pass against a real host yet (#392). For
  route precedence after a deploy or route change, use
  `scripts/smoke-host.sh https://host`.

The local harness runs on `http://127.0.0.1`, where a browser refuses the
`Secure`-only `__Host-session` cookie, so the signed-in state uses the plain
name the stub also accepts (`e2e/sessions.ts`); against an https host the real
name is used.
