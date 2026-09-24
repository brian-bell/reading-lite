# ADR 0001: Tenant control plane

> This ADR preserves the August 16 design baseline. For shipped behavior, read
> [architecture](../architecture.md), [account deletion](../operations.md#account-deletion),
> and [paid spend](../paid-provider-spend.md). Spend accounting now reserves tenant
> and global budgets in one GlobalUsageGuard ledger; reading storage and vector
> isolation follow [ADR 0005](0005-postgresql-storage.md), which superseded
> [ADR 0002](0002-vectorize-namespace-isolation.md).

- **Status:** Accepted; vector isolation amended by ADR 0002 (2026-08-23);
  storage parts (tenant R2 key roots as the isolation boundary for reading
  state) superseded by [ADR 0005](0005-postgresql-storage.md) (decided
  2026-09-19, live 2026-09-24). The control-plane decisions stand; their
  storage moved from D1 to PostgreSQL in the same cutover.
- **Date:** 2026-08-16
- **Decision owners:** Brian Bell
- **Task:** `reading-lite-s1k.1`
- **Scope:** WS-A multi-tenant core

## Context

reading-lite currently has one shared bearer secret, global R2 keys, one
unfiltered Vectorize index, environment-level notification settings, and no
account database or atomic per-user usage coordinator. WS-A must introduce
multi-tenancy without changing the TypeScript/Cloudflare shipping base or
creating a single-tenant deployment stopgap.

The control plane has two different consistency needs:

1. Users, verified email identity, sessions, token revocation, settings, and
   policy are relational, queryable records.
2. Submission limits, concurrent-work leases, and spend reservations must be
   serialized under races.

No single Cloudflare primitive is the best fit for both. D1 is the durable,
queryable system of record. SQLite-backed Durable Objects provide the
strongly-consistent coordination points.

This ADR fixes the contracts every later WS-A slice consumes. It does not add
bindings, migrations, routes, or runtime code.

## Decision

Use:

- one D1 control-plane database per environment for durable relational state;
- one SQLite-backed Durable Object per tenant for tenant counters,
  reservations, and leases;
- one singleton SQLite-backed Durable Object for global counters,
  reservations, and serialized enforcement of the D1 global kill switch;
- a dedicated Durable Object guard for unauthenticated magic-link abuse;
- R2 for tenant reading artifacts and indexes; and
- Vectorize for tenant-filtered similarity.

Do not add KV. Credential revocation must take effect on the next request, so
every authenticated request validates its D1 credential and account row.

The tenant boundary is the user account in v1:

```ts
declare const tenantIdBrand: unique symbol;
declare const userIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };

// V1 invariant: the values are equal, while the types retain their meaning.
export interface TenantContext {
  tenantId: TenantId;
}
```

Teams and organizations are explicitly out of scope. There is no separate
tenant row or identifier. New control-plane identifiers are random UUIDv4
values with type prefixes such as `usr_`, `ses_`, `tok_`, and `ml_`. The
canonical user ID is also the canonical tenant ID value. IDs are validated
before they can enter a path, vector ID, Durable Object name, or query.

Persistence and queue-control timestamps are integer Unix milliseconds.
External APIs and human-facing logs use ISO 8601. Clocks and ID generation
remain injectable in tests.

## D1 control-plane model

Each local, staging, and production environment has a separate
`reading-lite-control` D1 database. Production uses an `enam` primary-location
hint and makes no jurisdiction or residency guarantee. D1 global read
replication is disabled for v1 so credential revocation and account status do
not depend on replica bookmarks. If replication is enabled later, auth reads
must start on the primary or carry an adequate D1 Session bookmark.

Use checked-in, forward-only Wrangler migrations and thin typed repositories
over prepared D1 statements. Do not add an ORM. Migrations follow
expand, backfill, then contract; destructive cleanup waits for a later release.
Application releases must tolerate the intended pre/post migration overlap.
Rollback redeploys compatible code rather than applying down-migrations.

The conceptual schema is:

### `users`

- `id` — prefixed UUID primary key and tenant identifier.
- `email_canonical` — trimmed, lowercased email, unique.
- `email_display` — the verified address as entered for display and delivery.
- `status` — `active`, `suspended`, or `deleting`.
- `email_verified_at_ms`, `created_at_ms`, `updated_at_ms`.
- lifecycle timestamps for suspension and deletion when applicable.

The current verified email lives on `users`; there is no general identity
table. OAuth and multiple linked identities are out of scope. Email addresses
are plaintext D1 columns, protected by platform encryption, narrow repository
access, and log redaction. Do not strip dots, `+tags`, or apply
provider-specific normalization. Lowercasing the complete address is a
deliberate consumer-email restriction: although SMTP local parts can
technically be case-sensitive, v1 treats case variants as one identity. This
matches the selected product behavior but must be revisited before claiming
support for case-sensitive enterprise mail systems. When a login request
matches an existing canonical address, always deliver the challenge to that
row's already verified `email_display`, never to a differently cased address
from the new request. Case folding can deny a second case-distinct mailbox an
account, but it cannot redirect the first account's login link to that mailbox.

Suspending an account atomically revokes its current sessions and API tokens.
Reactivation requires a new magic-link session and new tokens. `deleting`
denies login, authenticated requests, and queued paid work until deletion
finishes. After tenant R2, Vectorize, Durable Object, reservation, and
operational usage state is purged, the D1 user and dependent rows are removed.
The email may then create a new account with a new user/tenant ID; it never
recovers access to old data.

### `user_settings`

A one-to-one, foreign-keyed row with typed columns and a schema version:

- immediate reading completion/failure notifications;
- digest cadence: `off`, `daily`, or `weekly`;
- IANA time zone;
- local delivery hour; and
- weekly delivery weekday.

New users default to immediate notifications on, digest off, and `UTC` until
they select a time zone. Bulk imports never emit per-item email. The only v1
notification destination is the verified account email; a second destination
would require its own verification lifecycle.

Queue messages carry only item-level notification intent, such as a request to
suppress one item. The consumer reads current settings and current verified
email immediately before delivery so an opt-out or email change takes effect
for already queued work.

### `sessions`

- selector ID (`ses_...`) primary key and `user_id` foreign key;
- HMAC of the random secret and hash-key version;
- created, authenticated, last-seen, idle-expiry, absolute-expiry, and
  revocation timestamps;
- a short, sanitized user-agent label; and
- an optional revocation reason.

Do not store raw IP history. Coalesce `last_seen_at_ms` writes, initially to at
most once per hour.

Browser sessions have a 30-day inactivity timeout and 90-day absolute expiry.
An account may have at most ten active sessions. Creating an eleventh can
revoke the least-recently-used session after warning. A session row is
soft-revoked and retained only through expiry plus a short cleanup window.

### `api_tokens` and `api_token_scopes`

`api_tokens` stores selector ID, user ID, name, format, HMAC, hash-key version,
created/expiry/revoked/last-used timestamps, and sanitized user-agent metadata.
`api_token_scopes` stores checked `(token_id, scope)` rows with a composite
primary key.

The fixed v1 scopes are:

- `readings:read`;
- `readings:write`; and
- `readings:import`.

Scopes do not imply one another. Route guards require the exact documented
scope; the UI may offer common bundles. Similarity/novelty requests perform a
paid embedding and require `readings:write`. Scope and expiry are immutable;
changing authority means creating a replacement and revoking the old token.

Tokens must expire, default to 90 days, and may never exceed 90 days. An
account may have at most ten active API tokens; creating another requires
explicit revocation. Full token material is returned exactly once. Subsequent
views show only name, safe prefix, scopes, and timestamps. Revoked token
metadata is retained through expiry plus a short cleanup window.

The existing `READER_API_TOKEN` is imported once as a `format=legacy` D1 token:
HMAC the complete existing secret, grant all three scopes, and impose the same
90-day maximum. It is not a permanent environment-to-founder fallback. The old
Worker secret remains unused only for a bounded code-rollback window and is
then destroyed.

### `auth_challenges`

A shared challenge table records login and email-change challenges:

- selector ID, purpose, canonical/display target email, and optional user ID;
- HMAC and hash-key version;
- issued and expiry timestamps;
- state: `issued`, `claimed`, `consumed`, or `revoked`;
- redemption/idempotency claim ID and claim timestamp; and
- completion metadata without bearer material.

Issuing a new challenge revokes any prior unconsumed challenge for the same
canonical email and purpose. Links expire after 15 minutes and are single use.

D1 `batch()` is atomic but does not provide an interactive JavaScript
transaction whose later statements consume earlier results. Redemption
therefore uses an idempotent claim/complete state machine:

1. conditionally claim the newest unexpired challenge with a redemption ID;
2. idempotently create or resolve the user and default settings;
3. issue one logical session for the redemption; and
4. mark the challenge consumed.

Retries by the same claimant resume. A competing claimant fails. The flow must
not burn a link halfway through account creation or return duplicate live
sessions after a lost response.

### `signup_invites`

Invites are persisted eligibility records keyed by canonical email with
created, expiry, and consumed timestamps. They are not long-lived invitation
bearer URLs. An invited address still completes the normal 15-minute
magic-link flow.

Signup policy is `closed`, `invite_only`, or `open`. Existing active users can
request login links in every mode. Unknown users are provisioned on successful
redemption only when current policy permits it. Eligibility is rechecked at
redemption.

Environment defaults are:

- local: `open`;
- staging: `invite_only`;
- production bootstrap: `closed`;
- production beta: explicitly changed to `invite_only`; and
- production launch: explicitly changed to `open`.

### `tenant_limits`

A one-to-one row stores explicit effective limits and a monotonically
increasing `policy_version`. It does not store a plan enum that guard code must
interpret. WS-B may calculate effective limits from billing entitlements
later.

The row defines the units and non-null values needed by submission, monthly
reading, concurrent work, and daily spend guards. Missing or invalid limits
never mean unlimited. A founder bootstrap receives explicit safe placeholder
values; s1k.9 calibrates production values from economics and staging load
tests.

### `system_policy`

A singleton, versioned policy row stores at least:

- signup mode;
- global paid-work enabled/disabled kill switch;
- effective global guard policy; and
- the current policy/catalog versions used by guards.

An authenticated local operator CLI changes this row. There is no public admin
route. Founder bootstrap, invites, policy changes, and recovery tools use
explicit environment selection, are dry-run by default, require `--execute`
for writes, confirm production targets, use idempotency keys, and redact
output.

There is no permanent `auth_events` table in v1. Active/recent credential rows
provide the user-facing security metadata. Magic-link sends/redemptions and
auth failures go to structured, redacted operational logs with bounded
retention.

## Credential and browser security

Sessions, magic links, and normal API tokens use:

```text
<public selector>.<256-bit random secret>
```

D1 indexes the selector and stores only an HMAC of the secret. HMAC comparisons
are constant-time. A D1-only disclosure does not reveal usable bearer
credentials.

Each environment has one versioned 256-bit root auth secret. HKDF derives
domain-separated keys for `session`, `api_token`, `magic_link`, `csrf`, and
`rate_limit`. D1 rows record the key version. The Worker accepts an active and
previous root during a bounded rotation window; successful credential use
under the previous key lazily re-HMACs the row. The previous key can be retired
after the 90-day maximum credential lifetime. Root secrets never live in D1.

The legacy imported token is the only no-selector exception. Validation HMACs
the complete presented value under active/previous keys and looks up the
indexed digest.

Magic-link email points to a same-origin SPA verification page with the secret
in the URL fragment. The page immediately removes the fragment from visible
history without making a network request, then presents an inert confirmation
control. Only an explicit user gesture POSTs the secret to the redemption
endpoint. Fragments are not sent in HTTP requests or referrers, and scanner
GETs or passive JavaScript rendering cannot consume the challenge. Disable
click tracking for auth emails. Automated browser scanners that synthesize
user gestures remain a residual risk; the one-time 15-minute window bounds it.

Session cookies are host-only `__Host-` cookies with `Secure`, `HttpOnly`,
`Path=/`, and `SameSite=Lax`. A new session is issued after redemption; no
pre-auth session is promoted. Session-authenticated mutations additionally
require:

- exact same-origin validation; and
- a session-bound, domain-separated CSRF token in a custom header.

Bearer-token requests are exempt from CSRF checks. If a request contains both
an `Authorization` bearer and a session cookie, the explicit bearer wins. An
invalid bearer returns `401`; it never falls back to the cookie.

Cookie/session endpoints are same-origin only. Explicit allowlisted origins
may call reading endpoints using scoped bearer tokens, without cookies or
credentialed CORS.

A fresh magic-link authentication within ten minutes is required to create an
API token, change login email, or delete the account. Credential revocation is
protective and does not require recent auth, but session requests still require
CSRF protection. Revoking all sessions logs out the caller too.

Changing login email requires recent auth and verification of the new address.
The unique canonical email is swapped atomically, the old address receives a
security notification, and all other sessions and API tokens are revoked.

Send security notifications, without bearer material, after API-token
creation, login-email change, all-session revocation, suspension, and account
deletion start/completion. Do not send a redundant second email for every
ordinary magic-link login.

Mailbox access is the sole v1 account-recovery factor. There is no operator
email override, recovery code, social identity, password, or TOTP backdoor.

All auth responses use `Cache-Control: no-store`. Authorization headers,
cookies, magic-link fragments/bodies, and token-creation responses are
redacted from logs and diagnostics.

## Authenticated principal contract

Middleware authenticates once, joins the credential to an active user, and
stores a discriminated principal in Hono context. Handlers never parse
credentials or infer scopes.

```ts
export type ApiScope =
  | "readings:read"
  | "readings:write"
  | "readings:import";

export type AuthenticatedPrincipal =
  | {
      kind: "session";
      tenantId: TenantId;
      userId: UserId;
      sessionId: string;
      authenticatedAtMs: number;
    }
  | {
      kind: "api_token";
      tenantId: TenantId;
      userId: UserId;
      tokenId: string;
      scopes: ReadonlySet<ApiScope>;
    };
```

V1 enforces `tenantId === userId` at principal construction. Keep both fields
so auth identity and data boundary are explicit. Route-group middleware
requires a principal and exact scope before creating any tenant-scoped store.

Account suspension/deletion takes effect on the next request because auth reads
D1 every time. Token and session revocation also take effect on the next
request; there is no positive cross-request cache.

## Queue tenant contract

Authorization happens at ingress. The queue receives a minimal, versioned,
runtime-validated envelope, not the Hono principal or bearer material:

```ts
export interface ProcessReadingEnvelopeV1 {
  version: 1;
  tenant: {
    tenantId: TenantId;
  };
  actor:
    | { kind: "session"; credentialId: string }
    | { kind: "api_token"; credentialId: string }
    | { kind: "operator"; operationId: string };
  job: ProcessReadingArgs;
}
```

The actor is for audit and revocation behavior, not serialized authorization.
No scopes or user-provided policy values cross the queue boundary. Before paid
work, the consumer:

1. validates the envelope and prefixed IDs;
2. loads the tenant and requires `active`;
3. for API-token-origin work, re-loads the token and required scope so revoking
   a leaked token cancels unpaid queued jobs; and
4. loads current policy before requesting guard reservations.

Logging out or revoking a browser session does not cancel work already accepted
from that session. Suspending/deleting the account always stops unpaid work.

Unknown envelope versions, absent tenant IDs, or malformed IDs fail closed
before D1 tenant mutation, R2, Vectorize, or provider access. Emit a redacted
high-severity metric/log and acknowledge malformed messages; retrying malformed
input cannot heal it. An already-written pending manifest can surface through
the existing stale annotation and operator reconciliation.

There is no implicit founder fallback and no unversioned queue decoder. The
tenant envelope cutover uses a brief maintenance window: stop submissions,
drain the old queue and active attempts, deploy the required v1 producer and
consumer together, then reopen.

## Tenant-scoped data plane

Validated `TenantContext` constructs a tenant-scoped store once. Do not pass a
raw tenant ID to every method and do not rely on route-level filtering:

```text
u/{tenantId}/readings/...
u/{tenantId}/index/by-id/...
u/{tenantId}/index/by-url/...
u/{tenantId}/index/list.json
```

The store derives every path internally. Hosted code cannot construct a global
reading store.

Vector identities and metadata are redundantly tenant-scoped:

> **Amended by ADR 0002:** the isolation primary is the Vectorize
> *namespace*, not a metadata filter, and no `tenant_id` metadata index is
> created. The tenant-prefixed vector ID and the `tenant_id` metadata stamp
> below stand; the "exact filter required" and index-readiness requirements
> do not. See ADR 0002 for the current contract.

```text
vector id:  {tenantId}:{readingId}
metadata:   tenant_id = {tenantId}
query:      exact tenant_id filter required
```

The tenant-prefixed vector ID prevents accidental cross-tenant overwrite or
delete; the mandatory metadata filter prevents cross-tenant similarity
results. A reading ID from another tenant returns the same result as an unknown
ID. Cloudflare Vectorize requires filterable properties to be indexed: create
and verify readiness of the `tenant_id` string metadata index before any tenant
vector upsert or filtered query. Treat a missing/unready metadata index as a
failed deployment prerequisite, not as permission to query without a filter.

Only server-fetched, unauthenticated public URL captures with explicit
`public_fetch` provenance may enter a future global extraction cache.
User-supplied markdown, extension/browser DOM, paywalled or session-derived
content, summaries, connections, manifests, and user metadata never do.

## Atomic guards and accounting

### Durable Object topology

- `TenantUsageGuard`, addressed by `idFromName(tenantId)`, serializes one
  tenant's token buckets, reading-quota reservations, spend reservations, and
  concurrent-work leases.
- `GlobalUsageGuard`, addressed by one fixed name, serializes the global kill
  switch's current enforced version, global spend/concurrency counters, and
  global reservations.
- `AuthRateGuard` enforces short-lived HMAC-keyed limits for unauthenticated
  magic-link requests and a global Resend-send ceiling.

Use new SQLite-backed Durable Object namespaces. Persist every state needed
after hibernation. Use alarms for reservation/lease cleanup; alarms and cleanup
are idempotent.

D1 is the source of truth for effective tenant/system policy. Durable Objects
own live counters, reservations, leases, and the last D1 policy version they
have synchronously accepted for enforcement. Every policy change increments a
monotonic version. Before a guard decision, the guard loads current policy
directly through its D1 binding, atomically rejects older versions, applies a
newer version, and evaluates the operation against the stored version. Callers
cannot supply limits. Operator policy updates wait for the affected global or
tenant guard to acknowledge the new version before reporting success. During
propagation, a guard applies the more restrictive of a stored and newly loaded
policy. A tightened limit or paid-work-disabled policy therefore cannot be
replaced by a stale caller value.

### Submission and reading quota

Rate-limit every request separately from paid-work quota. Only a request that
successfully activates a new processing attempt reserves a submission/monthly
reading slot. Returning an existing ready or pending owner does not consume a
paid-work slot.

Reserve the reading slot before enqueue so the API can reject immediately.
Release it after a definitive failure before summarization dispatch. Once a
summarization request is dispatched, the reading slot is consumed even if a
later stage fails because provider cost was incurred. Request-rate limits still
bound repeated fetch failures.

### Spend

Represent money as non-negative integer microdollars. Daily and monthly period
boundaries are UTC. Floating-point money is forbidden.

Before every paid outbound request:

1. bound its input/output bytes or tokens;
2. resolve a known provider/model in a versioned checked-in price catalog;
3. calculate a conservative maximum at catalog price plus an initial 25%
   safety margin;
4. reserve that maximum under a deterministic
   `readingAttempt + stage + retryOrdinal` operation ID; and
5. mark the reservation `dispatched` immediately before network dispatch.

Unknown models, missing prices, unbounded requests, stale policy, or unavailable
guards fail closed. Provider-account budget alerts/limits are defense in depth,
not a substitute for application guards.

Every outbound retry has its own deterministic reservation because a timeout
or 5xx may still be billable. Use provider idempotency keys where supported.
After a response, reconcile reserved maximum to actual usage under the recorded
price/catalog version.

An undispatched abandoned reservation may expire and release. Once dispatched,
an unknown outcome counts at the full reserved maximum until explicit
reconciliation or period rollover. A crash may temporarily under-utilize a
tenant's allowance but must never create room to overspend.

### Cross-object reservation saga

Tenant and global objects cannot commit atomically. Use an idempotent,
tenant-first saga:

1. reserve under the operation ID in `TenantUsageGuard`;
2. reserve the same operation in `GlobalUsageGuard`;
3. if the global reservation denies, compensate the tenant reservation; and
4. on an uncertain response, treat the reservation as held/denied until an
   idempotent retry or safe expiry resolves it.

Repeated operations return the existing decision and never double-charge.
Reconciliation uses the same operation identity. A policy limit below current
usage denies new work but does not pretend an already dispatched provider call
can be canceled.

### Concurrency

Tenant and global concurrency permits are expiring, fenced leases. A permit
holder presents the current fencing token before state transitions that assume
ownership. Leases may expire after a bounded crash timeout; spend reservations
follow the stricter dispatched rules above.

When no permit is available, enqueue the same reading attempt ID with a bounded
delay and acknowledge the current delivery. If delayed enqueue fails, retry the
current message. Permit acquisition and reading-attempt ownership are
idempotent so duplicate deliveries cannot begin duplicate paid work. Temporary
contention does not consume the provider-error retry budget and does not make a
reading terminally failed.

Guard outcomes are typed:

- request rate, concurrency, and tenant quota: `429` with `Retry-After` and/or
  `reset_at`;
- global kill switch or unavailable guard: `503`;
- suspended/deleting account: `403`;
- invalid credentials: generic `401`.

Queue consumers use typed internal outcomes rather than HTTP status codes.

Concurrency exhaustion, a disabled global paid-work policy, or a temporarily
unavailable guard produces a typed `defer_paid_work` outcome. The consumer
keeps the same attempt pending, releases its concurrency leases, and cancels
an undispatched reservation only after the owning Durable Object positively
confirms the idempotent cancellation. Any uncertain reservation remains held
under the conservative saga rules. The consumer delayed-enqueues the same
attempt ID and acknowledges the current delivery; if delayed enqueue fails, it
retries the current message. Deferral does not consume provider-error retries,
enter the DLQ, clear attempt ownership, or write a terminal failed manifest.
Dispatched spend reservations retain the conservative rules above. Policy may
impose a maximum deferral age, after which an operator-visible policy
failure—not a guessed tenant or released dispatched cost—resolves the strand.

A deterministic tenant quota/spend denial is different: it produces
`quota_exhausted` with `reset_at`. The consumer performs the normal
ownership-gated terminal commit to a visible, retryable failed state, preserving
an earlier ready manifest where existing reprocess rules require it. It
releases leases and only positively canceled undispatched reservations, does
not consume provider-error retries or enter the DLQ, and does not automatically
loop a message until the next day/month. The user can reprocess after
`reset_at`. A monthly reading denial should normally be caught at ingress; this
consumer path covers tightened or changed policy after enqueue.

If guard storage is unavailable, corrupt, or under restore, paid work fails
closed. Restore SQLite Durable Object state with point-in-time recovery or
reconcile from durable meter events after WS-B provides them. Never reset a
counter to zero to restore availability.

## Magic-link abuse controls

Magic-link request responses are generic and do not disclose whether a user or
invite exists. `AuthRateGuard` uses short-lived, domain-separated HMACs of the
canonical email and coarse client IP; it stores neither raw value. Enforce
per-email, per-IP, and global Resend ceilings.

In `open` signup mode, the client obtains Turnstile uniformly for every
magic-link request so the UI and response do not reveal whether the address is
known. The server requires a valid result before provisioning an unknown
address; known-user login remains protected by the limiter even if a future
server optimization does not require that result. Invite-only beta uses the
limiter without Turnstile. Turnstile success is not account identity and does
not bypass the magic link.

Local development uses an injected local-only mail sink accessible through test
interfaces or a loopback-only dev page, never production bindings or general
logs. Staging uses Resend with a recipient allowlist.

## Threat model

### Session theft

Controls:

- opaque high-entropy secret, HMAC-only D1 storage;
- host-only Secure/HttpOnly/SameSite cookie;
- same-origin and CSRF checks on mutations;
- 30-day idle and 90-day absolute expiry;
- immediate D1 revocation, ten-session cap, recent session metadata;
- recent magic-link auth for authority-increasing/destructive actions; and
- security notifications for sensitive changes.

Residual risk: XSS executing in the application origin can act as the user even
without reading the cookie. CSP, output escaping, dependency hygiene, and the
frontend security review remain required. Mailbox compromise is account
compromise in v1.

### API-token leakage

Controls:

- high-entropy show-once token;
- HMAC-only storage with key rotation;
- exact least-privilege scopes;
- immutable authority, 90-day maximum, ten-token cap;
- no token material in logs, queue messages, email, or later UI;
- immediate revocation on each request; and
- consumer recheck so revocation cancels unpaid queued work.

Residual risk: an attacker can act within granted scope until detection and
revocation. Already dispatched provider work may be billable and is charged
conservatively.

### Magic-link theft and account enumeration

Controls:

- 15-minute, newest-only, single-use challenges;
- URL fragment plus user-confirmed POST, with click tracking disabled;
- claim/complete state machine;
- generic request responses;
- HMAC-keyed email/IP/global send limits; and
- a uniform open-mode Turnstile UI before unknown-address provisioning.

Residual risk: anyone who obtains an unconsumed link can use it within its
window. Same-browser binding is deliberately rejected because cross-device
email use is normal. A sufficiently aggressive scanner that synthesizes a user
gesture could consume a link despite the inert confirmation page.

### Cross-tenant key and vector access

Controls:

- validated tenant principal at the HTTP seam;
- required versioned tenant queue envelope;
- no implicit founder/default tenant;
- tenant-scoped store construction;
- tenant prefixes on every R2 reading/index path;
- tenant in Vectorize namespace, vector ID, and metadata stamp (ADR 0002;
  originally "ID and required metadata filter");
- account and API-token rechecks before paid queue work;
- unknown/cross-tenant IDs are indistinguishable; and
- two-user route, queue, recovery, DLQ, and operator-path tests as later WS-A
  release gates.

Residual risk: direct operator credentials can access multiple tenants. Keep
them out of hosted request paths and constrain them to dry-run-first tools.

### Control-plane disclosure or restore

A D1-only disclosure exposes account emails and non-secret metadata but not
usable credential secrets. A Worker/root-secret compromise defeats application
HMAC protection and requires root rotation plus credential invalidation.

A whole-D1 Time Travel restore can resurrect credentials revoked after the
restore point. Every production restore therefore:

1. enters maintenance/paid-work-disabled mode;
2. rotates the active auth root;
3. invalidates all restored sessions and API tokens unless individually
   reconciled;
4. requires fresh magic-link login and token creation; and
5. reopens only after tenant/system policy reconciliation.

A Durable Object restore that could lower spend state remains fail-closed until
reconciled.

## Environment and deployment implications

### Local

- Local Miniflare D1 and SQLite Durable Object namespaces only; no remote
  control-plane bindings.
- Vite proxies `/api` so SPA and Worker are one browser origin.
- Signup mode is open.
- An injected local mail sink makes links testable without logging secrets.
- Local Durable Object storage does not provide production PITR; tests must not
  claim that it does.

### Staging

- Separate D1 database and Durable Object namespaces.
- A single staging host serves Pages plus Worker `/api/*` routes.
- **Update (2026-09-10, issue #265 S7/S9):** staging dual-serves
  `staging.readinglite.ai` (canonical) and `staging.readinglite.app`.
  `reading-lite-staging.bbell.dev` is retired. The original single-host
  sentence above is left as written.
- Signup is invite-only and Resend recipients are allowlisted.
- Rehearse D1 migration/restore, credential invalidation, counter failure, queue
  drain, founder copy/reconciliation, and rollback before production.

### Production

- Separate D1 and Durable Object resources with no staging sharing.
- `reading-lite.bbell.dev` remains one origin: Pages serves the SPA and Worker
  routes serve `/api/*`.
- **Update (2026-09-05, issue #265 S4):** production dual-serves
  `readinglite.ai` (canonical), `readinglite.app` (additional public host), and
  `reading-lite.bbell.dev` (compatibility/rollback). Same-origin still means
  Pages plus Worker routes on one hostname; sessions remain host-scoped across
  that trio. The original single-origin sentence above is left as written.
- **Update (2026-09-10, issue #265 S9):** both `bbell.dev` hosts are retired.
  Production dual-serves `readinglite.ai` and `readinglite.app` only. The S4
  trio sentence above is left as written.
- Production begins closed, then moves to invite-only for beta and open at
  launch through audited policy changes.
- Record a D1 Time Travel bookmark/timestamp before migrations and bulk
  operator changes. Do not create routine plaintext account SQL exports without
  a separate encrypted-backup policy.

## Rollout and rollback

### Auth/control-plane rollout

1. Create isolated D1/SQLite Durable Object resources and apply additive schema
   migrations without changing current request behavior.
2. Run an idempotent founder-bootstrap CLI keyed by canonical founder email. It
   creates or resolves the random founder user/tenant, default settings,
   explicit limits, and the 90-day legacy-format API-token row in one
   resumable operation.
3. Deploy principal-aware D1 API-token auth while old clients continue using
   the imported secret.
4. Add magic-link/session auth in dual mode and verify founder login,
   replacement scoped tokens, CSRF behavior, and security notifications.
5. Disable/revoke the legacy-format token. Retain the old Worker secret unused
   only for the bounded code-rollback window, then destroy it.

Schema rollback deploys prior compatible code. D1 Time Travel is reserved for
data/schema corruption and triggers the credential-invalidating restore
procedure.

### Queue envelope cutover

There is no legacy payload decoder:

1. stop submission producers;
2. wait for the main queue, retries, active attempts, and DLQ handling to drain;
3. verify no live pending attempt depends on an unversioned message;
4. deploy the v1 producer and consumer together; and
5. reopen submissions.

This intentionally replaces s1k.3's earlier requirement to tolerate in-flight
legacy messages. A permanent or shape-guessed founder fallback would weaken the
isolation invariant.

### Founder data cutover

Develop tenant-only paths behind a disabled cutover gate. Do not deploy A4
tenant-only reads before the founder data migration is ready.

In one maintenance window:

1. disable writes and paid work, then drain queues;
2. record counts, hashes, D1 bookmark, R2 inventory, and vector inventory;
3. ~~create the Vectorize `tenant_id` string metadata index and block until
   its readiness is verified~~ — deleted by ADR 0002: namespaces need no
   provisioning, so there is no Vectorize deployment prerequisite;
4. copy, rather than move, all founder R2 objects to `u/{founderTenantId}/...`;
5. upsert `{founderTenantId}:{readingId}` vectors into the founder namespace
   with `tenant_id` metadata while retaining legacy un-namespaced bare-ID
   vectors (amended by ADR 0002);
6. reconcile objects, hashes, pointers, list rows, attempts, connections, and
   vectors;
7. activate tenant-only hosted paths; and
8. retain legacy objects/vectors through a bounded observation window.

Rollback disables tenant mode and redeploys the prior Worker while legacy data
still exists. Delete legacy objects/vectors only after staging rehearsal,
production reconciliation, observation, and explicit sign-off.

## Account deletion

Deletion is an idempotent workflow, not one D1 transaction:

1. mark `deleting`, revoke credentials, and block tenant/global guards
   (`DELETE /api/account`, issue 195a). Production `TENANT_DATA_PLANE=1`: the
   founder is a normal tenant — deleting that account suppresses the founder
   prefix the same way as any other. Do not special-case. This step does not
   invent GlobalUsageGuard teardown (s1k.9.2). `DELETE /api/readings/:id` is
   a different verb (one-reading purge);
2. stop unpaid queued work and release reservations that are safe to release;
3. delete tenant R2 prefixes and tenant vectors;
4. remove tenant records from the global guard;
5. call `deleteAlarm()` and then `deleteAll()` on the tenant Durable Object
   (the current Worker compatibility date predates alarm-inclusive
   `deleteAll()` behavior);
6. delete tenant-linked operational usage state and irreversibly de-identify
   any allowed aggregate metrics; and
7. cascade-delete D1 user/control-plane rows.

Only future merchant-of-record records that must be retained for legal/payment
purposes are exempt; the product must not promise deletion of an external
processor's legally required records.

## Rejected alternatives

### D1 only

D1 is suitable for relational records, but conditional updates across
submission, concurrency leases, spend reservations, and global policy would
spread retry/serialization logic throughout callers. Durable Objects give each
guard one strongly-consistent coordinator and fencing point.

### Durable Objects only

Per-object state is awkward for account lookup by email, token administration,
operator queries, migrations, settings, and global user lifecycle. It would
turn relational control-plane work into bespoke indexes.

### KV cache or KV revocation store

KV's eventual consistency creates an avoidable revocation window. V1 scale
does not justify a positive auth cache.

### Stateless JWT sessions

Individual and all-session revocation would require server state or a
blocklist, eliminating the claimed simplicity. Opaque D1 sessions expose less
authority in a stolen database.

### Managed auth provider or Cloudflare Access

The v1 identity surface is deliberately narrow: verified email magic links,
sessions, and scoped API tokens. A managed provider would introduce another
user-ID source, webhook consistency, deletion dependency, cost, and migration
surface while D1 is still required for settings, policy, and tokens.

### Separate tenant ID

Teams and organizations are out of scope. A separate tenant table adds joins
and migration states without serving a v1 invariant. Semantic branded types
leave a future migration path.

### Provider-specific email normalization

Stripping Gmail dots or plus tags can merge distinct mailboxes at other
providers and create account-takeover risk.

### Same-browser magic links

Binding a link to a pre-auth browser cookie breaks normal desktop/mobile mail
flows. Short expiry, one-time use, scanner-safe POST redemption, and rate
limits provide the chosen tradeoff.

### Cross-origin session cookies

Pages-to-`workers.dev` cookies require weaker `SameSite=None` behavior and face
third-party-cookie blocking. Every environment uses a same-origin SPA/API
topology.

### Long-lived founder or missing-tenant fallback

Any default tenant makes malformed/new code capable of reading or mutating the
founder corpus. Cutovers drain old queues and fail closed.

### Long-lived dual-read founder overlay

Merging global and tenant list indexes/ownership through the migration period
would create a second set of CAS and dedupe semantics. A gated maintenance
cutover is smaller and safer.

## Consequences

- Every authenticated request adds a D1 credential/account lookup. This is
  accepted for immediate revocation and expected beta scale.
- Guard operations add Durable Object calls and a conservative distributed
  saga. They may deny valid work after ambiguous failures, but they do not fail
  open on spend.
- The global guard is a serialization point. Expected queue concurrency is
  tiny; shard only after measurement.
- Magic-link auth is first-party security-sensitive code. It requires focused
  state-machine, cookie, CSRF, concurrency, and redaction tests.
- One D1 database keeps lifecycle/policy operations simple. Split metering only
  if measured size, retention, or workload demands it.
- Immediate notification behavior remains familiar while digest remains opt-in.
- No account-recovery factor exists beyond the verified mailbox in v1.
- The founder data cutover requires a brief maintenance window.

## Required validation in follow-on slices

- D1 repository tests for unique email, status, expiry, revocation, key
  rotation, challenge claiming, email change, and deletion transitions.
- Concurrent magic-link redemption tests, including crash/resume and scanner
  GET behavior.
- Cookie, CSRF, origin, mixed-credential precedence, CORS, redaction, and
  recent-auth tests.
- Scope matrices for every route and API-token cancellation of unpaid queued
  work.
- Runtime queue-envelope tests for unknown version, missing tenant, malformed
  actor, and malformed prefixed IDs.
- Durable Object concurrency tests for duplicate reservation IDs, compensation,
  ambiguous dispatch, lease fencing, stale policy, kill switch, alarm retries,
  and restore fail-closed behavior.
- Two-user integration tests for every hosted and operator path, including
  by-ID/by-URL/list ownership, raw/content/diagnostics, similarity, connections,
  reprocess, recovery, terminal visibility, and DLQ.
- Local and staging smoke tests for same-origin cookies, local mail sink,
  recipient allowlist, resource isolation, queue drain, D1 restore credential
  invalidation, and founder migration rollback.

## Revisit triggers

Revisit this ADR only when evidence changes one of its constraints:

- teams or organizations enter scope;
- D1 auth latency is measured as material;
- global Durable Object throughput is measured as a bottleneck;
- jurisdiction/residency requirements become end-to-end product requirements;
- a second identity/recovery factor is approved; or
- meter retention requires a separate database.

Implementation details may be refined in dependent tasks, but changes to tenant
identity, fail-closed behavior, revocation consistency, queue versioning, or
spend reservation semantics require a superseding ADR.

## Cloudflare references

- [D1 database API: `batch()` and Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 global read replication and consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 data location and jurisdictions](https://developers.cloudflare.com/d1/configuration/data-location/)
- [SQLite-backed Durable Object storage and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
