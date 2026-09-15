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
```

Build a deployable environment with `CLOUDFLARE_ENV=staging` or
`CLOUDFLARE_ENV=production`. Production deploys to `next.readinglite.ai` after
every production backend release; staging deploys to
`next-staging.readinglite.ai` by manual dispatch. See
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
  Environments do not inherit bindings.
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
- **Reading detail.** `/readings/:id` reads the reading during the server
  render through `BACKEND` (`src/reading-query.ts`, the same isomorphic shape as
  identity), so it is dehydrated into the page and the browser does not ask
  again. `src/reading.ts` maps the response for both paths: the statuses with a
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
layout check that no positioned panel escapes the viewport fail the run.
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

Extending it:

- **A route or state:** add a case to `e2e/coverage.ts`. Every project picks it
  up. `prepare` reaches states that need interaction, as the open account menu
  does. A state reached by navigating between readings needs
  `serveReadingsInBrowser` (`e2e/test.ts`) first: the frontend Worker answers
  `/api/*` with 404 by design, so the browser's own reading requests are served
  from the fixture pack by a Playwright route. `e2e/specs/reading-trail.spec.ts`
  (the `reading-trail` project) covers Back, reload, and the phone jump (#371).
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
