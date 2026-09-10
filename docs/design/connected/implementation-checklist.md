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

- [ ] Review core library, reading, capture/status, and provider concepts with Brian.
- [ ] Reconcile product scope's older React Router wording with the approved
  TanStack Start frontend on a separate Worker; retain functional requirements.
- [ ] Finish the route/action inventory below against current main. This snapshot
  used `web/src/App.tsx` at the frozen revision, whose base was five commits
  behind origin/main when captured.
- [ ] Define loading, no readings, no search results, unavailable source/target,
  source failure, invalid key, provider limit, hosting limit, offline/reconnect,
  expired session, permission denied, and account-deletion states.
- [ ] Approve a status refresh contract: interval/backoff, maximum elapsed time or
  checks, pending-only admission, stop on terminal/auth/permission/unmount,
  hidden-tab pause, visible-tab resume, network-failure handling, manual fallback.
  The prototype's Check status control does not decide these rules.
- [ ] Specify readable width and rich source content: headings, links, images,
  lists, code, tables, very long titles, and long unbroken text.
- [ ] Define URL/query encoding for search/tag/page and per-reading source view;
  define back/forward, reload, deep-link, and scroll restoration behavior.
- [ ] Specify reusable navigation, reading card, tabs, relationship card, novelty,
  form, status, diagnostic disclosure, and empty/error components.
- [ ] Verify contrast and focus in both themes, keyboard-only navigation,
  screen-reader names/order, target sizes, zoom/reflow, and reduced motion.
  Keep mobile numbered points on one line and move focus meaningfully after jumps.

## Route and action inventory to finish

Existing routes below were verified in `web/src/App.tsx`. Preserve their behavior
unless an explicit migration decision replaces it. “Unspecified” means the
prototype does not supply a complete design, not permission to remove a workflow.

| Existing route or workflow | Prototype evidence | Replacement acceptance still required |
| --- | --- | --- |
| `/` | `#/library` | Keep home/auth behavior; map library search, tags, pagination, and scroll; support direct URLs/history |
| `/readings/:id` | `#/reading/:id`, `#/status/:id` | Preserve existing reading URLs; authenticated detail, source/summary, novelty, connections, missing/failed/pending |
| `/login` | Unspecified | Sign-in states, return destination, rate limits, expired sessions |
| `/login/verify`, `/auth/verify` | Unspecified | Both verification entrypoints and cross-tab continuation; clear consumed return state |
| `/account/security` | Provider concept covers a small subset | Sessions, tokens, notification/digest controls, key lifecycle, account deletion; inventory placement/actions |
| `/terms`, `/privacy`, `/dmca` | Unspecified | Keep public routes and legal content accessible |
| Unknown routes | Prototype normalizes invalid routes | Decide production fallback without breaking preserved links |
| URL submission/import | `#/capture` | Existing/pending duplicate, initializing/conflict, invalid input, queue unavailable, quotas and request limits |
| Reprocessing/recovery | Reprocess sample, Retry sample, Import a copy | Existing backend attempt ownership, confirmation where appropriate, duplicate-write avoidance, diagnostics |
| Reading deletion/account deletion | Unspecified | Existing guards and explicit confirmation; suppress inaccessible data and retain recovery/error information |
| Sample onboarding/provider settings | `#/provider` | Agree actual new route and credential contract in Phase 6 |
| Full archive export | Unspecified | Phase 6 formats, inclusion rules, progress/errors, archive completeness |
| Existing REST/MCP actions | No API calls in prototype | Preserve backend behavior; do not derive contracts from fixtures |

## Phase 3 — foundation and reading detail (#338)

- [ ] Create the approved TanStack Start application on its own Cloudflare Worker.
- [ ] Use same-origin browser API access and explicit request-scoped identity for
  server reads through the service binding. Keep the backend authoritative.
- [ ] Make authenticated reading detail the first selective SSR slice; prevent
  private readings, identity, and provider data from entering shared caches or
  static prerender output.
- [ ] Render summary/source, novelty, connections, tensions, and missing targets
  using real schemas, with the captured layout as the visual reference.
- [ ] Exercise multiple connection hops, return paths, direct links, and both
  themes at 390 px, intermediate breakpoints, 1440 px, and zoomed layouts.

## Phase 4 — daily reading workflow (#339)

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
