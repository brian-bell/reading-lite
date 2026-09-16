# ADR 0003: New frontend Worker topology, server reads, and rollout hosts

- **Status:** Accepted; hosts and release amended 2026-09-13 (see
  [Amendment](#amendment-2026-09-13-preview-hosts-from-phase-3))
- **Date:** 2026-09-10
- **Decision owners:** Brian Bell
- **Task:** [#338](https://github.com/brian-bell/reading-lite/issues/338), under
  [#335](https://github.com/brian-bell/reading-lite/issues/335)
- **Scope:** New TanStack Start frontend, Phases 3–5
- **Amends:** #338's instruction to "forward existing backend routes under the
  same browser origin"; the frontend does not proxy backend routes

## Context

[#335](https://github.com/brian-bell/reading-lite/issues/335) replaces the React
SPA with a TanStack Start frontend on its own Cloudflare Worker. The backend
Worker stays authoritative for authentication, tenant isolation, storage,
processing, REST, and MCP. The accepted design is in the
[Connected specification](../design/connected/design-spec.md) and
[acceptance matrix](../design/connected/acceptance-matrix.md).

Today each public host is served by two things:

- Cloudflare Pages (project `reading-lite`) serves the SPA on `readinglite.ai`,
  `readinglite.app`, and the two staging hosts. `web/public/_redirects` sends
  every path to `index.html`.
- The backend Worker (`reading-lite`, `reading-lite-staging`) owns only
  `/api/*`, `/health`, and `/mcp*` on those hosts, through the routes in
  [`wrangler.toml`](../../wrangler.toml). When routes overlap, the most specific
  pattern wins.

Constraints that shape this decision:

- The session cookie is `__Host-session`: host-only, `Secure`, `HttpOnly`,
  `SameSite=Lax`. A sign-in on one host does not carry to another.
- Magic links return only to origins in `PUBLIC_WEB_ORIGINS`
  ([`origin.ts`](../../src/control-plane/origin.ts)). Any other host falls back
  to `WEB_BASE_URL`.
- `cookieAuthAllowed` accepts a session cookie on a GET without an `Origin`
  header only when `Sec-Fetch-Site` is `same-origin`. A server render triggered by
  a typed URL (`none`) or an email link (`cross-site`) cannot satisfy that by
  forwarding browser headers, and faking the header would bypass the check.
- `@tanstack/react-start` 1.168 requires Node ≥22.12. The operator machine stays
  on Node 20.19 for `ops` (see [operator Node](../operations.md#operator-node)).
- Production releases run in the `deploy-production-release` concurrency group:
  the Worker deploys first, then the SPA deploys the same tested SHA, refusing a
  stale `main`.

## Decision

### Package

The frontend lives in a new top-level `app/` package with its own
`package.json`, lockfile, Wrangler config, and CI job on Node 22. `web/` is not
modified for the new frontend and is retired only after the Phase 5
observation period.

Approved dependencies, pinned to exact versions in `app/`:

- Runtime: `@tanstack/react-start`, `@tanstack/react-router`,
  `@tanstack/react-query`, `react`, `react-dom`, `react-markdown`,
  `rehype-sanitize`.
- Development: `@cloudflare/vite-plugin`, `@vitejs/plugin-react`, `vite`,
  `wrangler`, `typescript`, `vitest`, `@testing-library/react`.
- Type and test support (development, approved September 10, 2026; mirrors
  `web/`): `@types/react`, `@types/react-dom`, `jsdom` as the Vitest DOM
  environment, `@testing-library/jest-dom`, `@testing-library/user-event`.
- Browser evidence (development, approved September 10, 2026 for
  [#374](https://github.com/brian-bell/reading-lite/issues/374)):
  `@playwright/test`, `@axe-core/playwright`.
- Response projection (runtime, approved September 14, 2026 for
  [#371](https://github.com/brian-bell/reading-lite/issues/371)): `zod`, to
  parse `GET /api/readings/:id` at the API seam.
- Source rendering (runtime, approved September 14, 2026 for
  [#372](https://github.com/brian-bell/reading-lite/issues/372)): `remark-gfm`,
  so tables in imported Markdown render as tables beside `react-markdown` and
  `rehype-sanitize`.

Anything else needs separate approval. The Wrangler config keeps
`nodejs_compat`, uses `@tanstack/react-start/server-entry` as `main`, and enables
observability.

### Routing: route precedence, no proxy

- The frontend Worker is attached with a `host/*` route on each host it serves.
- The backend keeps its existing, more specific `/api/*`, `/health`, and `/mcp*`
  routes. Browser API calls and MCP traffic reach the backend directly and never
  pass through the frontend.
- The frontend does not forward backend paths. If a misconfigured route ever
  delivers `/api/*`, `/health`, or `/mcp*` to it, it returns 404 rather than
  rendering or proxying, so the fault is visible.
- Pages stays deployed. Rolling back a host means deleting that host's frontend
  `/*` route; Pages serves it again with no rebuild.
- After every route change, a smoke check confirms that `/health` answers from
  the backend and `/` answers from the frontend on each affected host.

### Browser requests

Browser code calls same-origin `/api/*` exactly as the current SPA does: session
cookie, CSRF token from `/api/whoami`, and the existing error semantics. No
bearer material enters browser storage.

### Server reads: backend RPC entrypoint

- The backend exports a named `WorkerEntrypoint` for frontend reads. It is
  reachable only through a service binding, never from the internet.
- Its methods are read-only and allowlisted: at least `whoami` and reading
  detail. The frontend passes the incoming request's `Cookie` header and the
  request host.
- The entrypoint runs the normal session authentication and tenant resolution,
  treating this internal caller as same-origin. It dispatches through the
  existing handlers so responses, including 401, 403, 404, and 412, match the
  HTTP API. It never accepts mutations and never issues cookies.
- The Phase 3 PR finalizes the method shape, with tests proving that a request
  without a valid session gets 401 and that one tenant's cookie cannot read
  another tenant's reading.

### Rendering and caching

- Reading detail (Summary view) is the first server-rendered authenticated
  route. The Source view and diagnostics load in the browser. Sign-in, verify,
  and account pages render in the browser initially.
- Each server render creates its own QueryClient. No identity or reading data is
  held in module scope. Dehydrated data (including the session's CSRF token from
  `whoami`) appears only in that response.
- Authenticated HTML is sent with `Cache-Control: private, no-store`. It is
  never prerendered, never written to the Cache API or KV, and never served from
  a shared cache. Only hashed static assets are publicly cacheable.
- Public legal pages may be prerendered because they contain no identity.

### Hosts and rollout

| Stage | Hosts | Notes |
| --- | --- | --- |
| Local | `localhost` | App dev server proxies `/api` to `wrangler dev` on :8787, as `web/` does; loopback requests already count as same-origin |
| Phase 4 daily use | `next.readinglite.ai` (production) | Frontend `next.readinglite.ai/*`; backend `next.readinglite.ai/api/*` and `/health`; add `https://next.readinglite.ai` to `PUBLIC_WEB_ORIGINS`. Separate sign-in. Proxied DNS record required. Deploys need separate authorization |
| Staging switch | `staging.readinglite.ai`, `staging.readinglite.app` | Both hosts move together once Phase 4 reaches parity. This is the cutover and rollback rehearsal. Before then, staging runs only the old SPA. **Decided 2026-09-16** after the #412 daily-use review: the staging frontend owns `host/*` on both hosts, over the Pages custom domains that stay bound as the rollback target |
| Staging preview (amended) | `next-staging.readinglite.ai` (staging) | Same shape as `next.readinglite.ai` on the staging Worker pair. Deployed from Phase 3 by manual dispatch. See the amendment |
| Production cutover (Phase 5) | `readinglite.ai`, `readinglite.app` | Add frontend `/*` routes. Rollback deletes them. Retire `next.readinglite.ai` and its allowlist entry afterwards |

Each environment's frontend binds only the backend Worker of the same
environment. A CI check fails when a frontend environment's service binding
names another environment's backend.

Notification and digest links keep using `WEB_BASE_URL`. `/readings/:id` is the
same in both frontends, so those links work before and after cutover.

### Build and release

- `app/` builds only on Node ≥22.12, in CI or another managed Node 22 runtime.
  The operator's Node 20.19 `ops` path does not build it.
- Until Phase 5, the frontend deploys only to `next.readinglite.ai`, manually
  and with separate authorization.
  > **Amended 2026-09-13:** the frontend deploys from Phase 3 to the preview
  > hosts only: production after every production backend release, staging by
  > manual dispatch.
- Phase 5 adds the frontend to the `deploy-production-release` concurrency group
  and the same-SHA artifact chain, alongside or in place of the SPA deploy, with
  the same stale-`main` refusal.

## Consequences

- The first deployed environment is production's `next` host, ahead of staging.
  (Amended 2026-09-13: `next-staging` deploys first.)
  The two-tenant server-render isolation tests and the cache-header tests must
  pass in CI before that first deploy.
- MCP and API latency and behavior are unchanged, and a frontend outage does not
  affect them.
- Rollback depends on Cloudflare route precedence, which the per-host smoke check
  verifies after every change.
- The backend gains one internal entrypoint and one allowlist entry, each with
  tests. The allowlist entry is temporary.
- Pages keeps deploying on every merge until the old SPA is retired, so it stays
  available as the rollback target.
- Staging switches at Phase 4 parity, before Phase 5's account pages exist in the
  new frontend. Until they land, staging account pages are unavailable in the
  browser; use local development or the API for account checks there.

## Alternatives considered

- **Frontend proxies all backend routes** (#338's original wording). This adds a
  hop and a failure point to every API and MCP call, and it makes rollback a
  redeploy instead of a route change. Rejected.
- **Forward browser headers for server reads.** Typed URLs and email links would
  fail authentication, so direct reading links could not server-render. Rejected.
- **Set `Sec-Fetch-Site: same-origin` on server reads.** This bypasses a backend
  check instead of handling it. Rejected.
- **No server rendering for authenticated pages.** Avoids the backend change but
  drops #335's first SSR goal. Rejected.
- **Move `staging.readinglite.app` first.** Declined in favor of moving both
  staging hosts together at Phase 4 parity.

## Amendment (2026-09-13): preview hosts from Phase 3

Brian wants to use the new frontend against real data while Phases 3–4 are
built, instead of waiting for Phase 4 daily use. This amends the host table and
release section above; routing, server reads, caching, and the apex cutover and
rollback are unchanged.

- **Hosts.** `next.readinglite.ai` (production) and `next-staging.readinglite.ai`
  (staging) serve the frontend from Phase 3. `next-staging` is a first-level
  subdomain so the zone's Universal SSL certificate covers it
  (`next.staging.readinglite.ai` would not be). Each host has a frontend
  `host/*` route and backend `/api/*` and `/health` routes, no `/mcp*` route,
  no Pages attachment, and a `PUBLIC_WEB_ORIGINS` entry. Both hosts and entries
  are retired after the Phase 5 cutover.
- **Order.** Staging deploys first. The backend routes and allowlist entry go
  live before a host's frontend route, so `/api/*` never reaches the frontend.
- **Production release.** The frontend deploys to `next.readinglite.ai` after
  every production backend release, as a job in the production SPA release
  workflow: same released SHA, same `deploy-production-release` group, same
  stale-`main` refusal. It is a job in that workflow rather than a separate
  workflow because a concurrency group keeps only one pending run, and a second
  workflow queued behind the Worker release could cancel the SPA release or be
  cancelled by it. The SPA and frontend jobs do not depend on each other, so a
  frontend failure never blocks the SPA that serves the apex hosts.
- **Staging release.** The staging backend is deployed by hand, so the staging
  frontend deploys by manual workflow dispatch after it.
- **Unchanged.** Both staging hosts still move to the new frontend at Phase 4
  parity as the cutover rehearsal, and the apex hosts cut over in Phase 5 with
  rollback by route deletion.
