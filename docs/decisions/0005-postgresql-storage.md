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

`src/modules/db/sql.ts` exposes a small `Sql` interface (`query`, `execute`
for a statement's row count, `transaction`, `end`) over one per-request client. Stores take `Sql`, never a
`pg` client, so they are injectable and Node scripts reuse them over a direct
connection. Hyperdrive pools in transaction mode, so session state does not
survive between statements: anything session-scoped must be `SET LOCAL` inside
`transaction`.

Type parsers are set once in the seam. `date` returns the `YYYY-MM-DD` string
(pg's default is a JS `Date` at local midnight, a day off west of UTC), and
`timestamptz` returns ISO-8601 UTC with milliseconds, matching
`services.now()`. `int8` returns a number and throws past 2^53 (pg's default
is a string). Manifests whose stored timestamps lack milliseconds are an
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

### Writes, publication and purge (slice 1b)

Slice 1b switched the router's reads and the whole write path together.

- **Attempts and jobs.** `db/migrations/0002_attempts_and_jobs.sql` adds
  `reading_attempts` (the attempt log, the paid checkpoint, and the content
  keys the attempt captured) and `reading_jobs` (durable job intent:
  `queued`, `sent`, `done`, `send_failed`, `dead`). A job row commits with the
  claim or reprocess that asks for the work, before the queue send, so a failed
  send leaves a recoverable record. Only the reading DLQ writes `dead`.
  Activation is idempotent on the attempt id and keeps a stored checkpoint.
- **Claims.** One transaction inserts the reading, its `reading_urls` row with
  `ON CONFLICT DO NOTHING`, the attempt and the job. A losing claim rolls back
  and re-resolves the owner. The 409 `initializing` response and the
  pointer-contention outcomes are gone from the API, since neither can happen.
- **Publication.** `PgReadingWriter.publish` locks the reading row, verifies
  attempt ownership, settles URL ownership, then writes the revision, the
  reading, its relationships, the embedding, and the attempt and job rows, in
  one transaction. This replaces the ledger-before-manifest ordering, the
  list-index CAS helpers and `ReadingVisibility`. A failed transaction rolls
  back whole and throws `PublishCommitError`, which requeues rather than
  failing the reading, the contract the vector ledger's fail-closed write used
  to carry. Only a URL's owner is searchable, and only for an active
  tenant: since 1c.3 the transaction locks the tenant's `users` row FOR SHARE
  and reads `status` there, so account deletion serializes against publication
  instead of being compensated for afterwards.
- **Immutable revision keys.** Each attempt writes its content under
  `{key_prefix}/revisions/{attemptId}/`, named in `layout.ts`. A failed
  reprocess changes only the attempt summaries, so the published content,
  summary, relationships and embedding stay intact together. That closes the
  divergence reading-lite-psu characterized and makes `preserve_ready_manifest`
  unnecessary, so it is gone from the queue message too. Content of a failed or
  superseded attempt is deleted once the reading no longer points at it.
- **Content keys before publication.** A never-published reading's content is
  found through its latest capturing attempt's row (not an unpublished
  revision); an imported reading no attempt has touched keeps the legacy
  spelling under its stored `key_prefix`.
- **Purge and the deletion fence.** Purge deletes the reading row in one
  transaction, cascading to every child, then deletes the R2 prefix twice. The
  missing row is the fence: a late consumer's publish, failure or attempt-log
  write finds nothing and writes nothing. The R2 tombstone is gone. A purge
  that dies between the rows and the objects cannot be resumed by DELETE; the
  account wipe removes the leftover bytes.
- **Connections.** HTTP routes share one client per request. The queue
  consumer and the scheduled jobs use `sqlSessionFor`: one client reused while
  it keeps being used, replaced after 10 seconds idle or after any error, so a
  connection left idle across a provider call is never trusted. A first
  version opened a client per statement; under CI's parallel load that
  flooded the local Hyperdrive proxy (every open is a full handshake where
  nothing pools) and timed tests out.
- **Account wipe.** In 1b the wipe deleted the tenant's reading rows after its
  objects phase and kept its Vectorize and vector-ledger phases. Slice 1c.2
  replaced both; see "Control plane wired" below.

### Control-plane tables (slice 1c)

`db/migrations/0003_control_plane.sql` recreates the D1 control plane
(`migrations/`) in PostgreSQL. Decisions (Brian, 2026-09-19):

- **Timestamps are `timestamptz`.** Every `*_at_ms INTEGER` becomes `*_at
  timestamptz`; the `_ms` suffix goes with the unit. The TypeScript domain stays
  epoch milliseconds. `src/control-plane/pg-time.ts` is the only conversion:
  `toTimestamp(ms)` for parameters, `fromTimestamp(iso)` for rows, which arrive
  through the seam's ISO parser, so the millisecond survives both ways.
  `relationship_refresh_jobs.run_at` was ISO text compared with `<`; as
  `timestamptz` it compares by instant and the collation hazard is gone.
- **Flags are `boolean`**, JSON held as text is `jsonb`, and
  `dev_mail_outbox.id` is `bigint GENERATED BY DEFAULT AS IDENTITY`, so an
  import can keep the old ids.
- **Microdollar ceilings are `bigint`.** The seam parses `int8` to a number and
  throws past 2^53 rather than lose precision. Other integers stay `integer`.
- **Foreign keys are D1's set, and none cascades.** Teardown reads
  `wipe_progress` to decide it may delete the `users` row, so a cascade would
  destroy that evidence as it is needed; teardown deletes account-owned rows
  explicitly. `account_deletions` has no foreign key, because it outlives the
  row it describes. PostgreSQL always enforces these.
- **`vector_ledger` and `vector_ledger_retained` are not recreated.** The
  ledger existed because Vectorize cannot list a tenant's vectors, so ids had
  to be recorded before every upsert. An embedding is now a row of
  `reading_embeddings` that deletes with its reading in one transaction, so
  there is nothing to keep in step. Vectors written before cutover are left to
  Vectorize's retirement at cutover.
- **`wipe_progress` drops its Vectorize-only columns** (`vector_cursor`,
  `mutation_ids`, `index_count_sampled`, `index_count_start`, `probe_attempts`,
  `probe_saw_residue`, `seed_cursor`, `seed_completed_at_ms`). Its phases are
  `objects`, `rows`, `done`: R2 objects go first and the reading rows and
  embeddings after them, keeping the rule that a wipe deletes rows after
  objects. Both completion pairs stay, as history.

`fromSql` (`src/control-plane/db.ts`) is the PostgreSQL `ControlPlaneDb`.
Control-plane SQL keeps its `?` placeholders and the adapter numbers them
(`$1`, `$2`, …), skipping string literals, quoted identifiers and `--`
comments. `run` and `batch` report row counts through the seam's `execute`,
which is what every compare-and-set in the control plane reads. `batch` is one
transaction; given a transaction handle instead of a `Sql`, every call joins
the caller's transaction, for the sites that must lock before they act.
`isUniqueConstraintError` recognises SQLSTATE `23505`. PostgreSQL aborts a
transaction on any failed statement (every later one fails with `25P02`), and
D1 did not; the control plane catches unique violations and carries on
(redeem's `email_taken`, challenge issue's retry, the wipe lease race). So
inside a caller's transaction each `run` and `batch` runs in its own
savepoint: a failed call undoes only itself, and the transaction stays usable.
The Node test harness does the same for statements outside a transaction,
matching autocommit, and runs them bare inside one, matching production.

A module's SQL cannot serve both stores: the column names and parameter types
differ. So each module moves to PostgreSQL whole, in the slice that wires it
(1c.2 to 1c.4), together with its Node unit tests, which leave the
better-sqlite3 helper for `test/helpers/pg-rollback.ts` at the same time. 1c.1
ships the schema, the seam, the adapter and the helpers, tested on PostgreSQL
directly, and leaves the runtime on D1.

#### Control plane wired (slice 1c.2)

The plan sliced the wiring by module (auth in 1c.2, eligibility, digests and
refresh jobs in 1c.3, the wipe in 1c.4). That cut cannot be made at the data:
D1 enforces foreign keys, and `digest_deliveries`, `relationship_refresh_jobs`,
`wipe_progress` and `vector_ledger` all reference D1 `users`, which eligibility,
the digest pipeline and the wipe also read directly. Once sign-in created users
in PostgreSQL, every later-slice module would have found no user. Decision
(Brian, 2026-09-19): 1c.2 switches the whole control-plane store at once, with a
direct port of every module; 1c.3 keeps moving tenant eligibility inside the
claim and publish transactions, and 1c.4 keeps the deletion-race work.

- **One client per request.** `sqlScope` is mounted on every route, so
  authentication and the handler share one lazy client, closed once the
  response is built. Queue batches, fan-outs and jobs use `sqlSessionFor`;
  `AttemptIo` carries the attempt's session as `controlPlane`. The Durable
  Object guards read limits and policy through `withControlPlane`, a
  short-lived client per lookup.
- **Lock, then act.** `ControlPlaneDb` gains `transaction`; given a
  transaction handle it joins in a savepoint. Every site that relied on D1's
  single writer to keep a read and its write together is one transaction that
  locks first:
  - magic-link and email-change issue take transaction-scoped advisory locks
    (`lockKey`) on the address, and email change on the user first, because a
    first issue has no row to lock. The partial unique index stays the last
    word and a violation retries;
  - redeem locks the challenge row `FOR UPDATE` for the whole claim and
    completion, so parallel redeems of one link run in turn;
  - session issue and token creation lock the `users` row, so the session cap
    and the 10-token cap hold under parallel requests;
  - founder bootstrap takes a fixed advisory lock, since a first bootstrap has
    nothing to lock;
  - teardown's final transaction locks `users` and `wipe_progress`, re-checks
    that the account is still `deleting` and the wipe still complete, then
    deletes, children first. D1 had no locks, so its batch carried both checks
    as an EXISTS guard on every statement.

  `test/integration/auth-concurrency.test.ts` runs these in parallel on real
  connections. Without the advisory locks its issue tests fail. The redeem tests
  still pass without the challenge lock, because the claim's compare-and-set,
  the user-row lock in session issue and the `(user_id, claim)` unique index
  already yield one session; the challenge lock keeps completion serial as D1
  did.
- **Insert order for challenges.** Rolling back a failed send restores the
  newest predecessor, which D1 read as `ORDER BY rowid`. PostgreSQL has no
  stable equivalent (`issued_at` ties within a millisecond; ids are random),
  so `db/migrations/0004_auth_challenge_issue_seq.sql` adds `issue_seq`, an
  identity column (see the mapping table).
- **The wipe.** Its phases are `rows`, `objects`, `done`: the tenant's reading
  rows, embeddings with them, in one statement, then the R2 prefix, then rows
  once more for a publisher that committed after the rows phase. A database
  error fails the delivery before any object goes. The vector-ledger seed,
  `deleteByIds` batches and namespace probes are gone. `vector-ledger.ts`
  stays only for the D1 operator commands that 1d ports or retires.
- **Test isolation.** Per-file databases keep files apart, but a file's tests
  share its database, where D1 gave each test its own. So
  `test/apply-control-plane.ts` truncates the control-plane tables and
  re-bootstraps the founder before each test. The usage guards run in the test
  file's isolate but build their `env` from the pool's binding, which names the
  base database (as `SELF` does), so the setup wraps their `fetch` and `alarm`
  to point `HYPERDRIVE` at the clone. In the Node pool, `useRolledBackSql`
  now queues operations on its one client, as a production session does, and
  salts advisory-lock keys per test: a transaction-scoped lock lives until the
  test's rollback, and tests that cannot see each other's rows must not block
  each other on one. Real concurrency is tested in the workers pool. Tests
  inject database faults at `pg.Client#query` (`test/helpers/sql-faults.ts`);
  Node-pool guard tests answer the guards' lookups in memory
  (`test/helpers/fake-control-plane.ts`).

#### Tenant eligibility inside the write transactions (slice 1c.3)

1c.2 put `users` in this database, so eligibility no longer has to be decided
outside the transaction that acts on it.

- **The tenant row is the lock.** `claimUrl`, `startAttempt` and `publish`
  read `SELECT status FROM users WHERE id = $1 FOR SHARE` as the first
  statement of their transaction, before any reading row is locked or written.
  FOR SHARE, not FOR UPDATE, so a tenant's readings still claim and publish in
  parallel while `DELETE /api/account`'s status UPDATE waits for all of them.
  The lock order is tenant row, then reading row, in every verb.
- **What each verb does with it.** A claim for an inactive tenant commits
  nothing — no reading, URL row, attempt or job — and reports
  `tenant_inactive`, which the router answers 403, the same body the
  authenticated seam gives. A publish for one still commits the reading, which
  the attempt paid for, but stores no embedding, so it is never searchable.
- **What that removes.** The consumer's before/after eligibility checks and
  the compensation between them are gone: there is no window. A `deleting`
  tenant's reading is left to the account wipe, whose second rows sweep exists
  for exactly this publisher; a `suspended` tenant keeps its reading, out of
  search, as before.
- **Only a confirmed row blocks.** The reading tables carry no foreign key to
  `users` on purpose, so a missing row is not read as ineligible; a torn-down
  tenant has no readings left to publish against anyway.
- **Purge.** `relationship_refresh_jobs` has no foreign key to hang off, so
  the purge transaction deletes the reading's refresh checkpoint itself,
  alongside the row.

Still on D1 in this candidate, for 1c.5 and 1d: the `CONTROL_PLANE` binding
itself, the D1 migrations in `npm run dev`, and the operator commands with their
own control-plane SQL (system policy and status, the account wipe CLI and
residue scan, the deploy wipe gate, staging token revocation, and the vector
ledger commands). `ops founder bootstrap`, `npm run dev` and `seed:local` use
PostgreSQL.

#### D1 to PostgreSQL column mapping (for the #348 importer)

Two conversions cover every changed column:

- **ms**: `to_timestamp(value / 1000.0)`, which keeps the millisecond; NULL
  stays NULL.
- **flag**: `value <> 0`.

Columns not listed import unchanged (`TEXT` to `text`, `INTEGER` to `integer`).

| D1 table | D1 column | PostgreSQL column | Conversion |
|---|---|---|---|
| `users` | `email_verified_at_ms`, `created_at_ms`, `updated_at_ms`, `suspended_at_ms`, `deleting_at_ms` | `email_verified_at`, `created_at`, `updated_at`, `suspended_at`, `deleting_at` | ms |
| `user_settings` | `notify_immediate` | `notify_immediate` | flag |
| `user_settings` | `created_at_ms`, `updated_at_ms` | `created_at`, `updated_at` | ms |
| `tenant_limits` | `daily_spend_microdollars` | `daily_spend_microdollars` | `integer` to `bigint`, value unchanged |
| `tenant_limits` | `created_at_ms`, `updated_at_ms` | `created_at`, `updated_at` | ms |
| `api_tokens` | `created_at_ms`, `expires_at_ms`, `revoked_at_ms`, `last_used_at_ms` | `created_at`, `expires_at`, `revoked_at`, `last_used_at` | ms |
| `api_token_scopes` | all | same | unchanged |
| `system_policy` | `paid_work_enabled` | `paid_work_enabled` | flag |
| `system_policy` | `daily_spend_microdollars` | `daily_spend_microdollars` | `integer` to `bigint`; NULL stays NULL (fail-closed) |
| `system_policy` | `updated_at_ms` | `updated_at` | ms |
| `sessions` | `created_at_ms`, `authenticated_at_ms`, `last_seen_at_ms`, `idle_expires_at_ms`, `absolute_expires_at_ms`, `revoked_at_ms` | `created_at`, `authenticated_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at` | ms |
| `auth_challenges` | `issued_at_ms`, `expires_at_ms`, `claimed_at_ms`, `consumed_at_ms`, `mail_sent_at_ms` | `issued_at`, `expires_at`, `claimed_at`, `consumed_at`, `mail_sent_at` | ms |
| `auth_challenges` | `rowid` | `issue_seq` | value unchanged; afterwards restart the identity above `max(issue_seq)` |
| `signup_invites` | `created_at_ms`, `expires_at_ms`, `consumed_at_ms` | `created_at`, `expires_at`, `consumed_at` | ms |
| `dev_mail_outbox` | `id` | `id` | value unchanged; afterwards restart the identity above `max(id)` |
| `dev_mail_outbox` | `sent_at_ms` | `sent_at` | ms |
| `digest_deliveries` | `created_at_ms`, `updated_at_ms` | `created_at`, `updated_at` | ms |
| `relationship_refresh_jobs` | `run_at` (ISO text) | `run_at` | `value::timestamptz` |
| `relationship_refresh_jobs` | `result_json` (JSON text) | `result_json` | `value::jsonb`; NULL stays NULL |
| `relationship_refresh_jobs` | `retry_at_ms` | `retry_at` | ms |
| `wipe_progress` | `phase` | `phase` | always `done`: only completed wipes import, because the deploy gate refuses unfinished ones |
| `wipe_progress` | `force`, `residue`, `first_residue` | same | flag |
| `wipe_progress` | `updated_at_ms`, `completed_at_ms`, `first_completed_at_ms` | `updated_at`, `completed_at`, `first_completed_at` | ms |
| `wipe_progress` | `vector_cursor`, `mutation_ids`, `index_count_sampled`, `index_count_start`, `probe_attempts`, `probe_saw_residue`, `seed_cursor`, `seed_completed_at_ms` | none | not imported |
| `account_deletions` | `residue`, `first_residue` | same | flag |
| `account_deletions` | `deleting_at_ms`, `completed_at_ms`, `first_completed_at_ms`, `torn_down_at_ms` | `deleting_at`, `completed_at`, `first_completed_at`, `torn_down_at` | ms |
| `vector_ledger` (D1 0012 rebuilt it from `vector_ledger_retained`) | all | none | not imported |

Import order follows the foreign keys: `users` first, then `api_tokens` before
`api_token_scopes`; the rest in any order.

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
tables. The run always forces the workers pool's Hyperdrive string to that
database. See [local Postgres](../operations.md#local-postgres).

#### Test isolation

D1 gave every workers-pool test rolled-back storage; PostgreSQL is outside the
pool's rollback. Tenant ids partition reading rows, but the control plane has
global state no tenant id can partition: the founder's email, the legacy
token's HMAC (a global unique index), and the `system_policy` singleton, which
several integration files mutate. Decision (1c.1, after a spike):

- **Workers pool: a database per test file.** globalSetup migrates a template,
  `<base>_tpl`, that nothing connects to (`CREATE DATABASE … TEMPLATE` refuses a
  source in use). Each file's setup (`test/apply-control-plane.ts`) clones it
  as `<base>_f_<random>` and replaces `env.HYPERDRIVE` with the clone's
  connection string. The spike found the two things this depends on: the
  binding on `cloudflare:test`'s `env` is writable, and the local Hyperdrive
  proxy connects to whichever database the client names. Tests pass `env` to
  `worker.fetch`, `worker.queue` and the stores, so the redirect reaches them;
  `SELF` uses the runtime's own bindings and still sees the base database, and
  only `operator-status.test.ts` uses it. globalSetup drops the clones when the
  run ends, and before the next one in case a run was killed.
- **Node pool: one database, one rolled-back transaction per test**
  (`test/helpers/pg-rollback.ts`). Code under test that opens a transaction
  gets a `SAVEPOINT`. Two tests inserting the same unique key do not fail; the
  second waits for the first to roll back.
- The schema-per-file fallback (`search_path`) was not needed.

Proof: `test/integration/postgres/file-database-{a,b}.test.ts` each commit
`system_policy` row 1. On a shared database the second insert fails on the
primary key however the files are scheduled, and with the redirect disabled
both files fail. Cost, measured locally on the workers project (single runs,
Apple silicon, Docker Postgres): 21.8 s before, 23.0 to 24.0 s after, with two
more test files; a clone takes about 30 ms. `STRATEGY = FILE_COPY` made no
measurable difference, so the default stays.

1b's per-file tenant ids (`test/helpers/file-tenants.ts`) are no longer needed
for isolation and can retire.

## Consequences

- Reads become keyed queries; the list-index CAS loop, by-url and by-id
  pointers, and Vectorize namespaces all retire at cutover.
- `preserve_ready_manifest` has no column: revisions replace it (see slice 1b
  above).
- Relationship rows are unique per source, kind and target. Today's schema
  does not promise that, so the mapper keeps the first occurrence and reports
  the rest; #348 checks the real corpus before relying on it.
- The project is on Neon's free plan with scale-to-zero, so the first query
  after idle pays a cold start. #349 measures it; #350 decides whether
  production needs a paid plan.
- The HTTP tests used one fixed founder id across parallel files against one
  shared database. 1b chose **per-file tenant ids**: `test/helpers/file-tenants.ts`
  derives the founder and second-tenant ids from the test file's path, and
  `test/apply-control-plane.ts` deletes those tenants' rows before each test,
  which matches the per-test rollback R2, D1 and Durable Objects already get.
  1b ruled out a database per file because the pool has one Hyperdrive string;
  1c.1 found the binding can be redirected per file (see test isolation above),
  which the control plane's global uniques require.
