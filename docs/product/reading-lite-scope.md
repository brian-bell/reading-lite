# Reading Lite product scope

Updated September 6, 2026; frontend wording reconciled September 10, 2026 with
[issue #335](https://github.com/brian-bell/reading-lite/issues/335). Companion to
the [product brief](reading-lite-portfolio-brief.md). This replaces the August
subscription-first roadmap, effort estimates, launch dates, and private-source
recommendation. The work below remains to be done.

## What this plan covers

Keep Reading Lite a personal project while building toward an open-source launch
with a free hosted BYOK tier. Redesign the reading interface and give each tenant
its own provider settings. Brian uses both first. Then invite a small group to
find out whether they can use the service without his help.

The free tier provides the core reading experience with user-funded AI calls
and explicit hosting limits. A future paid tier remains an option. Billing,
subscriptions, credit packs, included AI allowances, and revenue targets are not
part of this scope or prerequisites for the free launch.

## What already exists

Preserve and extend the current Worker. Replace the current React SPA with a new
React frontend built on TanStack Start and deployed as a separate Cloudflare
Worker; keep the current SPA available until the replacement and rollback checks
pass. Accounts, tenant-scoped PostgreSQL rows and R2 content roots, scoped
tokens, quotas, processing leases,
spend admission, digests, and account deletion already exist. Verify them as the
new work lands. The founder cutover is complete and must not be rerun.

The library currently supports text search and tags. API and MCP reading
workflows already exist; MCP uses bearer authentication, not OAuth. Provider
credentials and model selection are deployment-wide. There is no self-service
tenant provider configuration or full-archive export route in the current API.

Use [architecture](../architecture.md), [API](../api.md), and
[operations](../operations.md) for current behavior and known limitations.
The requirements below describe future changes, including places where the
current UI or configuration must change.

## A. UI redesign

Brian should prefer the redesigned app for daily reading. A new reader should
be able to save an article, read it, and follow its connections without help.

### Deliverables

- Start with the reading detail page. Make the source and summary readable,
  explain the novelty verdict, and let readers follow connections to other
  articles. Handle unavailable content and deleted connection targets.
- Establish typography, spacing, color, light/dark treatments, responsive
  layouts, focus states, and reusable controls. Build them in the new frontend
  with TanStack Start, TanStack Router, and TanStack Query, using the existing
  backend for authentication, storage, processing, REST, and MCP. This replaces
  the September 6 instruction to keep React Router and extend the current SPA.
  The selected direction is Connected; see its
  [design specification](../design/connected/design-spec.md).
- Apply the design to the library, text search and tags, URL capture, Markdown
  import, reprocessing, and processing status. Distinguish source failures,
  credential problems, provider limits, and hosting limits where known.
- Design provider setup and settings with the work in section B. Cover
  connected, missing, invalid, and removed-key states. Explain provider charges and show a curated
  example of connections before key setup.
- Preserve account security, token, notification, digest, and deletion workflows.
  Keep diagnostics reachable without making them the default reading view.
- Use the same typography, colors, and controls in digest mail and the launch
  page after finishing the main reading screens.

### Acceptance

- Review the library, detail, capture/status, and provider-settings designs with
  Brian before full implementation. Use representative content, including long
  titles, sparse archives, and failures.
- Complete save → processing → ready/failed → detail → related reading on
  desktop and phone layouts, with keyboard navigation and visible focus.
- Users can see when processing finishes or fails. The current SPA does not
  poll. The new frontend uses bounded automatic refresh with a manual fallback,
  as specified and tested in the
  [status refresh contract](../design/connected/acceptance-matrix.md#status-refresh-contract).
- Existing routes and actions remain available, as mapped in the
  [acceptance matrix](../design/connected/acceptance-matrix.md). Account and
  provider errors explain what users can do next. Empty search results explain
  what was searched.
- Relevant component tests, frontend tests/build, and accessibility checks pass.
  Review the screens with representative content in both color themes, including
  keyboard use and phone layouts.

Design can start now. Agree on provider behavior in section B before building
those screens. Reading screens do not depend on credential storage.

## B. Tenant-specific provider configuration

Every processing job must use the tenant's chosen settings and credentials.
It must never use another tenant's key or fall back to Brian's key.

### Deliverables

- Give each tenant separate summarization and embedding settings, with supported
  models, effort choices, and defaults. The launch recommendation is one OpenAI
  key for both roles. Confirm that choice before implementation. For each added
  provider, specify how embeddings work and which models are compatible.
- Add authenticated settings operations to connect, validate, replace, and remove
  credentials. Apply session, CSRF, and recent-auth protections appropriate to
  sensitive account changes. Return masked metadata, never stored secrets.
- Encrypt stored credentials with a separate server-held secret. Document how
  to rotate that secret and recover from failure. Resolve keys on the server;
  exclude plaintext from logs, queue messages, checkpoints, manifests, exports,
  browser persistent storage, and error responses.
- Resolve processing settings for the authenticated tenant. Move Brian's account
  to those settings in stages, with a rollback procedure that preserves readings.
  Do not silently use deployment credentials when tenant configuration is missing
  or invalid.
- Specify what happens to queued work and retries when a user changes settings
  or removes a key. Record which configuration each attempt used, without
  secrets. Do not mix incompatible checkpoints or embeddings.
- Show usage and processing limits. Record who pays for each provider request
  and track hosting capacity separately. Keep admission and lease checks inside
  retry loops. Update accounting to distinguish user-funded and operator-funded
  requests without bypassing those controls.

The current pipeline always uses OpenAI embeddings at 1536 dimensions. Preserve
that embedding space initially. Arbitrary endpoints/models, local models, and
embedding-provider migrations are deferred. Preserve existing provider adapters
and their supported behavior.

### Acceptance

- Tests with two tenants prove every dispatch uses the intended credentials and
  configuration, including retries and queue redelivery. Ordinary API/MCP reading
  tokens cannot retrieve or manage provider secrets.
- Missing, invalid, removed, or inaccessible credentials stop processing with
  an error that explains what to do next. Decryption failure also stops
  processing. None of these failures may trigger a fallback key.
- After removal is acknowledged, no subsequent dispatch is authorized using
  that credential. Already-dispatched requests may finish and incur charges;
  disclose this boundary. Replacement and concurrent jobs obey a tested policy.
- Set retry limits and recovery steps for provider timeouts, rate limits,
  insufficient credit, and unsupported settings. Retries cannot spend without
  the same admission and lease protections as the first request.
- Removing a key preserves access to existing readings, text search, captured
  content, and export. Account deletion makes provider credentials unusable
  immediately and removes stored credential material during teardown.
- Settings changes cannot silently reuse incompatible processing artifacts or
  compare vectors from incompatible embedding spaces.
- Brian uses this path before beta invitations. Relevant Worker tests/typecheck,
  API contract checks, and provider-settings UI checks pass. Get separate
  approval before paid staging validation.

Agree on key creation, replacement, removal, and the corresponding UI before
building storage and API operations. Specify the schema, encryption format, and
model allowlist in the implementation design.

## C. Data portability and launch readiness

Invited readers must be able to set up the service, recover from common
failures, export their archive, and delete their account without Brian's help.

### Deliverables

- Build a self-service archive export with available captured Markdown, raw
  originals, manifests, summaries, metadata, and connections in documented
  formats. Exclude credentials and internal security/operational records.
- Guide users through login → connect key → first save → first reading,
  with an example explaining why useful connections need reading history.
- Publish storage and processing limits, who pays, available support, and known
  capture failures. Keep URL and Markdown capture. Fix failures seen in daily
  use before adding another capture service.
- Verify account deletion and credential removal, including known vector
  residue concerns. Check the remaining production acceptance conditions even
  though the deletion code already exists.
- Prepare application source for public release under the existing MIT license:
  review tracked files and history, write setup and contribution instructions,
  and keep private reading data and secrets out of release materials.
- Update the existing privacy policy and terms to explain BYOK, retention,
  which data providers receive, and how the service stores and uses keys. Provide
  a support contact and exercise recovery for queue failures, provider failures,
  key rotation, and hosting-limit exhaustion.

### Acceptance

- Export a representative archive and compare item counts and available content
  against its source. Preserve relationships and identify missing artifacts;
  never omit them silently. The export opens outside Reading Lite and does not
  require a working AI key.
- New readers complete onboarding and the reading flow without operator help;
  the interface explains common failures and lets readers retry.
- Enforce selected hosting limits server-side and explain them in the UI.
  Record hosting cost and support effort separately from AI usage. Brian must
  choose the limits and hosting budget before opening signup.
- Exercise deletion and isolation checks in staging and resolve launch-blocking
  residue/security findings. Do not infer successful deletion from an empty R2
  prefix alone; follow the operations runbook.
- Verify extraction rejects private and link-local addresses, unsafe schemes,
  and redirects to blocked destinations. Retain the hostile-URL regression tests.
  DNS preflight does not prevent rebinding between validation and fetch. Before
  opening signup, review how to contain that risk or record Brian's explicit
  acceptance of the remaining exposure. Passing the tests alone is not approval.
- Release materials describe what the service does and its known limitations.
  Review the repository before publishing it. Get separate approval to publish
  the source or open signup.

Scheduled exports, full export re-import, competitor-specific bulk migrations,
and a polished self-hosting installer are deferred. Document the export format
for later restore and import work.

## Milestones

| Stage | Work | Exit condition |
|---|---|---|
| Personal design | Design the UI and provider settings | Brian has reviewed the screens; key creation, replacement, and removal are specified |
| Personal implementation | Build the redesign and tenant settings in small changes | Brian uses both for daily reading; existing workflows still work |
| Invited BYOK beta | Add onboarding, export, limits, and recovery | Readers use the app without help; processing failures, cost, and support effort have been measured |
| Free hosted launch | Finish launch checks and publish the source and service information | Acceptance criteria pass; Brian agrees to the hosting budget and support commitments |
| Reassess | Review real use and requests | Decide whether a paid tier or other expansion is justified |

Estimate implementation after reviewing the designs. No launch date or weekly
hours budget is set. Finish export and key handling before inviting people to
store their archives and credentials. Decide when to open signup from the beta
results.

## Rules for implementation

- Preserve tenant isolation, eager URL ownership, publication transaction order,
  deletion fences, and existing recovery contracts. Follow the rules
  in [AGENTS.md](../../AGENTS.md) and module headers.
- Synchronize API/schema, SPA types, OpenAPI, and behavioral tests for new
  interfaces. Keep refactoring limited to what the redesign needs.
- Keep the Cloudflare and React stack. No backend rewrite or generic provider
  framework is needed for the first supported BYOK path.
- Maintain the distinction between AI spending and hosting costs. Free access
  and a valid key do not imply unlimited capacity or unlimited retries.
- The [earlier economics run](../193-v2.1-handoff.md) remains deferred. These
  milestones do not authorize paid calls, budget changes, deployments, or corpus
  operations. Check the current state and get execution approval before resuming.

## Deferred work and open choices

Defer paid plans/billing, growth campaigns and SEO schedules, native apps,
RSS/newsletter ingestion, highlights/TTS, teams/public sharing, browser
extensions, hosted browser fallback, publisher-login custody, new MCP synthesis
tools, OAuth integrations, and an Obsidian plugin. Existing MCP and local recovery
workflows remain supported. Add deferred work only when use shows a need and
Brian agrees to expand the scope.

These choices are still open:

| Choice | When needed |
|---|---|
| Launch provider/model choices; whether Anthropic is included alongside OpenAI embeddings | Before finalizing onboarding and provider contracts |
| Configuration snapshot, key rotation/revocation, and retry/checkpoint semantics | Before B implementation |
| Hosting budget, archive limits, throughput, and customer spend controls | Before beta; adjust from measurements before public signup |
| Beta invitation size, support expectations, source publication timing | Before inviting readers and preparing launch |
| What a paid plan would offer | After users give us a reason to build one |
