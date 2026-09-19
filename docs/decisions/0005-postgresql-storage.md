# ADR 0005: PostgreSQL, pgvector, and R2 storage

- **Status:** Accepted; in progress on the `epic/postgres-storage` candidate
  branch. Nothing here is live until the cutover (`reading-lite-gh350`).
- **Date:** 2026-09-19
- **Decision owners:** Brian Bell
- **Task:** `reading-lite-gh347.1`, under `reading-lite-gh347` and the epic
  `reading-lite-gh346`
- **Scope:** Reading-side storage: readings, URL ownership, published
  revisions, relationships, and embeddings. D1 control-plane tables move in a
  later slice.
- **Supersedes:** the storage parts of
  [ADR 0001](0001-tenant-control-plane.md) (tenant R2 key roots as the
  isolation boundary for reading state) and all of
  [ADR 0002](0002-vectorize-namespace-isolation.md) (Vectorize namespaces), at
  cutover. Until then both still describe production.

## Context

Reading state lives in R2 as JSON: a manifest per reading, `index/list.json`
maintained by compare-and-set, and by-url and by-id pointers. Embeddings live
in Vectorize, isolated by namespace. This has two costs.

- A failed reprocess restores the previous manifest but not the content
  artifacts it overwrote
  ([reprocessing and recovery](../architecture.md#reprocessing-and-recovery)).
  Closing that needs immutable revision keys and a transactional publish,
  which object storage cannot give. This is the strongest product-facing
  reason to move.
- Every list, search, lookup and relationship read is a whole-index read, and
  every terminal write is a CAS loop over one object.

Brian is the only user, so the epic uses one maintenance-window cutover: build,
import, rehearse, switch, retire. There is no dual write, legacy read fallback
or gradual rollout.

## Decision

PostgreSQL becomes authoritative for reading state and embeddings. Captured
content stays in R2, addressed by the relative keys the rows store.

### Step 0 choices

- **Neon**, project `reading-lite` in `aws-us-east-1`, PostgreSQL 18 with
  pgvector 0.8.x. Branches: `main` (production), `dev`, `rehearsal`.
- **Hyperdrive** per environment, bound as `HYPERDRIVE`. The Worker connects
  with **node-postgres (`pg`) and plain SQL**; there is no ORM. `pg` runs on
  workerd at compatibility date 2024-12-30 with `nodejs_compat`; no
  compatibility change was needed.
- **Direct connection strings** for GitHub Actions and operators (migrations,
  the importer). The laptop copy lives outside the repository in
  `~/.config/reading-lite/neon.env`.
- **Hyperdrive query caching is disabled on every config.** Hyperdrive caches
  SELECTs for up to 60 seconds by default. Both frontends invalidate after a
  write and never poll, so a cached list or detail would show stale data after
  a submit. Local and test Hyperdrive is a passthrough, so no test can catch
  this: #349 and #350 must create their configs with caching disabled, and
  staging is the first place a stale read could show.

### The seam

`src/modules/db/sql.ts` exposes a small `Sql` interface (`query`,
`transaction`, `end`) over one per-request client. Stores take `Sql`, never a
`pg` client, so they are injectable and Node scripts reuse them over a direct
connection. Hyperdrive pools in transaction mode, so session state does not
survive between statements: anything session-scoped must be `SET LOCAL` inside
`transaction`.

Type parsers are set once in the seam. `date` returns the `YYYY-MM-DD` string
(pg's default is a JS `Date` at local midnight, a day off west of UTC), and
`timestamptz` returns ISO-8601 UTC with milliseconds, matching
`services.now()`. Manifests whose stored timestamps lack milliseconds are an
importer (#348) decision.

### Schema

`db/migrations/0001_reading_schema.sql`. Identity, ownership, state and queried
fields are relational columns; summary and diagnostic data are JSONB.

- `readings`: one row per reading, with the stored relative `key_prefix`
  (never re-derived: imported prefixes need not follow `buildKeyPrefix`), the
  list and detail fields, and the content state every status requires.
- `reading_urls`: tenant-scoped URL ownership, unique per `(tenant_id,
  url_hash)`. Separate from `readings` because the corpus holds failed orphan
  duplicates of one URL and only one reading owns it.
- `reading_revisions`: what a publish produced, with relative R2 `raw_key` and
  `extracted_key`. A revision exists only once a reading has been published;
  the Manifest projection takes content fields from `readings`.
- `reading_relationships`: connections and tensions, with a `position` so the
  ordered arrays round-trip exactly. The foreign key covers the source only;
  detail reads tolerate missing targets, as they do today.
- `reading_embeddings`: `vector(1536)`, kept out of `readings` so list scans
  never touch it.

### Tenant isolation, restated for rows

R2 isolated tenants by key root and Vectorize by namespace. PostgreSQL isolates
by row:

- every table has `tenant_id` as the first column of its primary key;
- every foreign key includes `tenant_id`, so a cross-tenant reference cannot be
  expressed;
- stores are only constructed from a validated `TenantContext`
  (`pgReadingStoreFor`, `pgSimilarityStoreFor`), which parses the tenant id
  exactly as `tenantKeyRoot` does, and every query is `WHERE tenant_id = $1`.

No tenant is exempt from deletion; the wipe path moves to PostgreSQL in a later
slice and must keep the rules in
[account deletion](../operations.md#account-deletion).

### Similarity is an exact scan, with no HNSW index

The plan was one HNSW cosine index with `SET LOCAL hnsw.iterative_scan =
strict_order`, because HNSW applies the tenant filter after the graph walk.
Testing on PostgreSQL 18.2 with pgvector 0.8.1 showed that is not enough. With
a 400-vector tenant inserted beside a 5-vector tenant, the incrementally built
graph reached only 388 of 413 rows under any `ef_search`, either
`iterative_scan` mode, and a 100x `scan_mem_multiplier`; the small tenant got
zero neighbours. Only a full `REINDEX` made every row reachable. Vectors that
sit outside a larger cluster lose their backlinks as the cluster grows, which
is exactly a small tenant beside a large one.

So `reading_embeddings` has no vector index. Similarity is an exact cosine
scan over one tenant's rows, found through the primary key: always complete,
tenant-isolated by construction, and cheap at thousands of rows per tenant.
The scaling path is a per-tenant (partial or partitioned) index, not a shared
graph. This deviates from the slice's original "cosine index" criterion, using
the fallback the plan named.

Score is `1 - (embedding <=> query)`, matching Vectorize's cosine metric, so
`SIMILARITY_FLOOR`, `aboveFloor`, `excludeSelf` and `summarizeSimilarity` are
reused unchanged. Only ready readings are returned, and titles, tldrs and tags
come from the reading row instead of copied vector metadata.

### Text search

`q` keeps today's semantics: a case-insensitive substring over title, tldr,
url and keywords, and a case-insensitive exact tag, with stored tags keeping
their case. It uses `strpos`, so `%` and `_` need no escaping. There is no
trigram index yet; `pg_trgm` is the scaling path. List order is
`created_at DESC, id DESC`; the id tiebreak is a deliberate change from
today's stable sort on `created_at` alone.

### Migrations

A small `pg`-based runner (`scripts/pg-lib/migrate.ts`,
`npm run ops -- db migrate`), not node-pg-migrate: no new dependency, it runs
on the Node 22 ops floor, and it matches the numbered-SQL style of the D1
migrations. `db/migrations/NNNN_name.sql`; `migrations/` stays D1's.

- applied files are recorded in `schema_migrations` with a checksum;
- the runner takes `pg_advisory_lock`, so it needs a direct connection;
- one transaction per file, forward-only;
- it refuses when an applied file changed or disappeared, or a pending file is
  older than an applied one.

Replacing `d1 migrations apply` in the Worker deploy belongs to a later slice.

### Slicing: the runtime is never split between stores

Decision (Brian, 2026-09-19). Slice 1a builds and tests the PostgreSQL read
stores without wiring them; slice 1b switches the router's reads and the write
path together. About 100 integration tests submit, drain the queue, then GET
the result; with reads on PostgreSQL and writes on R2 they would all need a
throwaway projector. FrontendReads and MCP both dispatch through the Hono
routes, so the router is the only read surface and 1b switches it in one place.

In place of router wiring, 1a's end-to-end proof is a parity suite: the local
fixture pack is seeded into R2 and into PostgreSQL through one shared mapping
(`scripts/pg-lib/manifest-rows.ts`, also used by `seed:local` and the #348
importer), and the old and new stores must return identical list, detail,
relationship-target and lookup results.

`/lookup` stays side-effect-free: owner resolution is a pure SELECT, pinned by
running it in a `READ ONLY` transaction. The URL row and its reading commit
together, so the "initializing" outcome disappears; a row is owned and null is
unclaimed.

### Per-environment cutover flag

The candidate's `wrangler.toml` binds Hyperdrive, so a mistaken merge or
deploy must not ship it. `scripts/ops-lib/postgres-cutover.ts` holds a
checked-in `POSTGRES_CUTOVER_ENABLED = { staging: false, production: false }`.
`ops deploy worker` refuses an environment that binds Hyperdrive while its
flag is false, before the readiness preflight, migrations or upload: plan mode
reports the refusal, `--execute` exits 2, and execute also refuses a
placeholder Hyperdrive id. The flag is per environment because #349 deploys
the candidate to staging as the rehearsal: #349 flips staging on the branch,
#350 flips production in a reviewable commit that travels with the release.
`deploy-spa.yml` gates the SPA and `app/` jobs on the Worker workflow
succeeding, so a refusal stops the whole release.

### Local and CI Postgres

Tests never connect to Neon. CI's Worker job runs a
`pgvector/pgvector:0.8.1-pg18` service; locally the same image is the
docker-compose `postgres` service on host port 54329. Vitest's globalSetup
creates and migrates the test database (one per checkout locally, so worktrees
never truncate each other or trip migration drift), then truncates the reading
tables; store tests mint a tenant id per test, so parallel files never collide.
The run always forces the workers pool's Hyperdrive string to that database.
The workers pool reaches it through the `HYPERDRIVE` binding's local
connection string. See [local Postgres](../operations.md#local-postgres).

## Consequences

- Reads become keyed queries; the list-index CAS loop, by-url and by-id
  pointers, and Vectorize namespaces all retire at cutover.
- `preserve_ready_manifest` has no column: revisions replace it, and 1b owns
  the failed-reprocess restore.
- Relationship rows are unique per source, kind and target. Today's schema
  does not promise that, so the mapper keeps the first occurrence and reports
  the rest; #348 checks the real corpus before relying on it.
- The project is on Neon's free plan with scale-to-zero, so the first query
  after idle pays a cold start. #349 measures it; #350 decides whether
  production needs a paid plan.
- In 1b the HTTP tests all use one fixed founder id across parallel files
  against one shared database. 1b must choose a database per vitest worker,
  per-file founder ids, or serial files.
