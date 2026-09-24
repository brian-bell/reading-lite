# Connected implementation checklist

Use with the [design specification](design-spec.md) and the frozen revision in
[README](README.md). This is a handoff checklist, not a claim that Phase 2 or
production acceptance has passed. Issue links retain the existing milestone
structure; no new product features or release dates are implied.

## Baseline preserved

- [x] Record Brian's preference for Connected, removal of decorative copy,
  compact spacing, and dedicated entrypoint.
- [x] Preserve runnable source, dependency lockfile, shared fixtures, and commands.
- [x] Capture desktop/phone reference states and both themes.
- [x] Record simulation boundaries and validation limitations.

## Phase 2 — design decisions and acceptance (#337)

Drafted September 10, 2026 in the [design specification](design-spec.md#phase-2-specification)
and [acceptance matrix](acceptance-matrix.md). Brian reviewed and accepted every
item on September 10, 2026.

- [x] Review core library, reading, capture/status, and provider concepts with
  Brian: accepted September 10 without further prototype changes.
- [x] Reconcile product scope's older React Router wording with the approved
  TanStack Start frontend on a separate Worker; retain functional requirements.
- [x] Route/action parity matrix against current main (4031711): accepted, in the
  [acceptance matrix](acceptance-matrix.md#routes). Capture lives only on `/save`;
  only ready readings confirm before reprocessing; reading deletion stays out of
  the UI.
- [x] Loading, empty, no-results, unavailable source/target, failure categories,
  offline, expired session, permission denied, and account-deletion states:
  accepted, in the [acceptance matrix](acceptance-matrix.md#states). Failure
  categories use a frontend mapping pinned by a test; an already-saved URL opens
  the existing reading with a notice.
- [x] Status refresh contract: approved September 10, with acceptance checks in the
  [acceptance matrix](acceptance-matrix.md#status-refresh-contract).
- [x] Readable width and rich source content: accepted, in
  [source content](design-spec.md#source-content). Images load only when clicked.
- [x] URL encoding, back/forward, reload, deep links, and scroll restoration:
  accepted, in [routes and navigation state](design-spec.md#routes-and-navigation-state).
  The trail stays in history state; the view switch replaces the history entry.
- [x] Reusable components: accepted, in [components](design-spec.md#components).
  Theme control in navigation; Details is one collapsed section.
- [x] Contrast, focus, keyboard, target size, zoom, and reduced motion: accepted, in
  [themes and contrast](design-spec.md#themes-and-contrast) and
  [keyboard, focus, and motion](design-spec.md#keyboard-focus-and-motion). Focus
  moves to the page heading after route changes. Screen-reader and zoom checks
  run against the implementation in Phases 3–4.
- [x] Map prototype-only data (author, publication, key points, novelty text,
  relationship titles) to real fields: see [data mapping](design-spec.md#data-mapping).
  Relationship targets are enriched at read time (Brian, September 10).

## Phase 3 — foundation and reading detail (#338)

- [x] Add read-time `relationship_targets` to `GET /api/readings/:id` with schema,
  OpenAPI, SPA type, and test updates (#367).
- [x] Add the backend's read-only frontend `WorkerEntrypoint` (whoami, reading
  detail) per [ADR 0003](../../decisions/0003-frontend-worker-topology.md#server-reads-backend-rpc-entrypoint),
  with 401 and cross-tenant tests.
- [x] Create the approved TanStack Start application in `app/` on its own
  Cloudflare Worker, with pinned approved dependencies and a Node 22 CI job.
- [x] Use same-origin browser API access and explicit request-scoped identity for
  server reads through the service binding. Keep the backend authoritative.
- [x] Return 404 from the frontend for `/api/*`, `/health`, and `/mcp*`; add a CI
  check that each environment's service binding targets the same environment.
- [x] Make authenticated reading detail the first selective SSR slice; prevent
  private readings, identity, and provider data from entering shared caches or
  static prerender output.
- [ ] Render summary/source, novelty, connections, tensions, and missing targets
  using real schemas, with the captured layout as the visual reference.
- [ ] Exercise multiple connection hops, return paths, direct links, and both
  themes at 390 px, intermediate breakpoints, 1440 px, and zoomed layouts.

## Phase 4 — daily reading workflow (#339)

- [ ] Stand up `next.readinglite.ai`: add it to `PUBLIC_WEB_ORIGINS`, add the
  backend `/api/*` and `/health` routes and the frontend `/*` route, and verify
  route precedence. The first deploy needs separate authorization and passing
  isolation and cache-header tests. *Superseded: the host was retired after the
  apex cutover (reading-lite-gh335.2); do not re-add it.*
- [ ] Implement backend-backed library search, tags, pagination, and return state.
- [ ] Implement URL capture and Markdown import through existing intake outcomes.
- [ ] Implement the approved bounded status refresh and manual fallback; ensure
  labels reflect backend state without fabricating step-level progress.
- [ ] Distinguish source, credential, provider-limit, hosting-limit, transport,
  and backend-unavailable failures; offer the appropriate recovery.
- [ ] Preserve attempt ownership and successful prior material during reprocessing
  according to backend contracts; avoid automatic retry of ambiguous paid writes.
- [ ] Compare representative real content with the reference captures, including
  incomplete/old manifests and long source content.

## Later parity and release gates (#340–#342)

- [ ] Complete account/session/token/notification/digest/deletion parity.
- [ ] Agree provider contracts, key storage/validation/rotation/removal semantics,
  in-flight jobs, billing disclosure, and key-free access to existing material.
- [ ] Complete sample onboarding and full archive export.
- [ ] Keep the existing SPA available until replacement and rollback checks pass.
- [ ] Demonstrate independent frontend release/rollback with the existing release
  guards; make invited beta/open signup/source publication separate decisions.

For each implementation slice, attach its relevant acceptance checks, automated
results, and desktop/phone evidence. The fixture page size, fake processing
sequence, and provisional provider copy should not silently become backend rules.
