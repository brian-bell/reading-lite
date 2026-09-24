# ADR 0002: Vectorize tenant isolation via namespaces

> This ADR preserves the August 23 decision and its implementation plan.
> Until the 2026-09-24 PostgreSQL cutover, staging and production pinned tenant
> mode and account wipe took vector IDs from D1 `vector_ledger`, seeded from R2
> before deletion. The tenant cutover tooling is retired. See [current architecture](../architecture.md) and
> [account deletion](../operations.md#account-deletion).

- **Status:** Superseded by [ADR 0005](0005-postgresql-storage.md) (decided
  2026-09-19, live 2026-09-24), which moved embeddings to pgvector with
  row-level tenant scoping. The Vectorize index stays frozen until
  `reading-lite-gh351` retires it.
- **Date:** 2026-08-23
- **Decision owners:** Brian Bell
- **Task:** `reading-lite-s1k.6.1`
- **Scope:** WS-A multi-tenant core
- **Amends:** ADR 0001 (vector isolation in "Tenant-scoped data plane",
  the "Cross-tenant key and vector access" controls, and steps 3 and 5 of
  the "Founder data cutover")

## Context

ADR 0001 mandated metadata-filter isolation for Vectorize: `tenant_id`
metadata on every vector, an exact `tenant_id` filter on every query, and a
verified `tenant_id` string metadata index as a deployment prerequisite.

The implementation (`src/modules/stores/similarity-store.ts`, landed with the
`TENANT_DATA_PLANE` gate) chose Vectorize **namespaces** instead: a namespaced
query structurally cannot match a vector in another namespace, so isolation
does not depend on every present and future query site remembering a filter
clause. That matches how the rest of the data plane is proven — a tenant-scoped
store constructed once from a validated `TenantContext`, not per-call
discipline — and it removes an entire operational failure class: Vectorize
metadata indexes must be created and verified per environment, and only cover
vectors upserted *after* index creation, so an ordering mistake yields vectors
silently invisible to filtered queries.

The divergence must be resolved before the founder-corpus migration plan
(`reading-lite-s1k.6.1`) can state its vector readiness and reconciliation
contracts, because ADR 0001's cutover step 3 (create and verify the metadata
index) has no implementation target under the namespace design.

One piece of ADR 0001's design is not covered by namespaces alone:
`deleteByIds` is namespace-blind (a vector ID is unique per index, so a delete
crosses namespaces). With bare reading IDs, platform-level protection against
cross-tenant overwrite/delete rests entirely on the app-layer owner gate.

## Decision

Tenant vector isolation uses three redundant layers, all derived from the
validated `TenantContext` at store construction, none from per-query
discipline:

```text
namespace:  {tenantId}            — the query partition (platform-enforced)
vector id:  {tenantId}:{readingId} — overwrite/delete protection
metadata:   tenant_id = {tenantId} — audit/reconciliation stamp only
```

1. **Namespace is the isolation primary.** Hosted code builds the store via
   `similarityStoreFor`; while `TENANT_DATA_PLANE=1` every upsert and query
   carries the tenant namespace. No metadata index is created and no query
   filter is used. A cross-tenant similarity match is structurally impossible,
   not merely forbidden.
2. **Vector IDs are tenant-prefixed when the data-plane gate is on.** The
   store composes `{tenantId}:{readingId}` internally from its own namespace
   for upsert and delete, and strips its own prefix from query match IDs so
   callers continue to see bare reading IDs. Because the ID embeds the tenant,
   the namespace-blind `deleteByIds` can only ever address the calling
   tenant's vector; deleting or overwriting another tenant's vector would
   require composing that tenant's ID, which tenant-scoped store construction
   prevents. This closes the one gap namespaces leave open.
3. **`tenant_id` metadata is stamped but never filtered on.** It exists so
   `get-vectors` output and migration reconciliation can attribute a vector
   without decoding its ID, and as a breadcrumb if a filter-bearing feature is
   ever added. No metadata index is provisioned for it. If a future feature
   needs Vectorize filters, that feature creates its index then and accounts
   for the after-creation-only coverage rule (existing vectors would need
   re-upsert).

Gate-off behavior is unchanged: while `TENANT_DATA_PLANE` is unset the store
uses no namespace and bare reading IDs, which is what keeps the pre-tenant
corpus visible until the founder cutover (ADR 0001, `reading-lite-s1k.6`).

### Founder data cutover changes

ADR 0001's cutover steps 3 and 5 are replaced:

- ~~Step 3 (create and verify the `tenant_id` metadata index)~~ is deleted.
  Namespaces need no provisioning; they exist implicitly at first upsert.
  There is no Vectorize deployment prerequisite to verify.
- Step 5 becomes: upsert `{founderTenantId}:{readingId}` vectors into the
  founder namespace with `tenant_id` metadata, while retaining the legacy
  un-namespaced bare-ID vectors.

The bare-ID/prefixed-ID split doubles as the observation-window marker: a
legacy vector and its migrated copy never collide, and reconciliation can
verify a migrated vector by fetching its prefixed ID and checking
`namespace == founderTenantId`, with the legacy bare ID still resolvable until
post-observation deletion. Account deletion (ADR 0001) deletes tenant vectors
by prefixed IDs derived from the tenant's own list index.

### Implementation deltas

Shipped behavior today is unaffected (gate off ⇒ bare IDs, no namespace).
Before the cutover gate flips, dependent tasks under `reading-lite-s1k.6`
must land:

- `SimilarityStore`: compose the prefixed ID on upsert/delete and strip it
  from query matches when a namespace is set.
- Operator vector tooling (`vectorExists`, `makeVectorizeClient`, migration
  reconciliation): probe prefixed IDs, compare namespaces, stamp `tenant_id`
  metadata for tenant selectors.
- The ADR 0001 threat-model control "tenant in both Vectorize ID and required
  metadata filter" is read as "tenant in namespace, vector ID, and metadata
  stamp; queries are namespaced".

## Consequences

- The s1k.6.1 acceptance criterion "verifies the tenant_id Vectorize metadata
  index" is satisfied by this amendment as: verify namespace + prefixed-ID +
  metadata-stamp readiness of the migration tooling; there is no index to
  create.
- Query quality and cost track tenant size: a namespaced query scans only the
  tenant's segment, so `topK` is never diluted by other tenants.
- Cross-tenant (global) similarity queries become structurally impossible from
  hosted code. No current or planned feature wants one; if that changes it is
  a revisit trigger, not a workaround.
- Vectorize allows tens of thousands of namespaces per index — no constraint
  for user-per-tenant scale.
- One metadata-index slot (of Vectorize's small per-index budget) stays free
  for future genuine filter features (tags, dates).

## Rejected alternatives

### Metadata filter as the isolation primary (ADR 0001 original)

Isolation would depend on every query site passing the filter forever; a
forgotten filter silently returns plausible cross-tenant results. Adds a
per-environment index-provisioning prerequisite with an ordering trap
(vectors upserted before index creation are invisible to filtered queries).
Rejected as per-call discipline where a structural guarantee is available.

### Namespaces with bare reading IDs (shipped interim state)

Leaves `deleteByIds` cross-namespace reach guarded only by the app-layer
owner gate. Reading IDs are unguessable UUIDs, so the residual risk is low,
but the prefix closes it at the platform layer for one line of ID
composition, and the migration gains the legacy/migrated marker for free.

### Both namespace and mandatory filter

Redundant enforcement of the same predicate at query time, while still
carrying the metadata-index prerequisite and its ordering trap — the
operational cost of the filter design without adding a guarantee the
namespace does not already provide.

## Revisit triggers

- A product feature requires cross-tenant or global similarity queries.
- Vectorize namespace limits or semantics change materially.
- A feature needs metadata filtering (create its index then; this ADR's
  no-index stance applies only to `tenant_id` isolation).

## Cloudflare references

- [Vectorize namespaces](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/#namespaces)
- [Vectorize metadata indexes and after-creation coverage](https://developers.cloudflare.com/vectorize/best-practices/query-vectors/#metadata-filtering)
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)
