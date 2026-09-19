# AGENTS.md - reading-lite

Personal reading service on Cloudflare Workers. The TanStack Start frontend in
`app/` serves the public hosts; the legacy React SPA in `web/` stays deployed to
Pages as the rollback target. Intake claims a URL, writes a pending R2
manifest, and enqueues `READING_JOBS`. The consumer extracts, embeds, finds
related readings, summarizes, and publishes the terminal manifest, list row,
and vector.

Read [CONTEXT.md](CONTEXT.md) for domain names and the relevant module's header
comments before changing it. [Architecture](docs/architecture.md) contains the
module map and write-order details; [operations](docs/operations.md) contains
deployment, deletion, and corpus procedures. Work is tracked in beads (see
[Work tracking](#work-tracking)). `CLAUDE.md` must remain a symlink to this file.

## Work tracking

Beads (`bd`) is the only tracker; do not open GitHub issues. Claude, Codex, and
Cursor hooks inject `bd prime` at session start and around compaction; run it
yourself when that context is missing. The [beads skill](.agents/skills/beads/SKILL.md)
covers the workflow.

```sh
bd ready                        # unblocked work
bd show <id>                    # details, parent, blockers, comments
bd update <id> --claim          # take it before starting
bd create "Title" --type task --priority 2 --parent <id>
bd dep add <id> --blocked-by <other>
bd close <id> --reason "..."
bd dolt push                    # publish to refs/dolt/data on origin
```

Beads imported from GitHub are `reading-lite-gh<N>` and link back to issue
`#<N>`; historical `#<N>` references in docs and commits mean that bead. Keep
durable notes in `bd remember` and search them with `bd memories`; Claude auto
memory is disabled for this repo. A fresh clone runs `bd bootstrap` to clone
the database, and `npm ci` points `core.hooksPath` at `.beads/hooks` when `bd`
is installed.

## Commands

```sh
npm ci
cp .dev.vars.example .dev.vars   # first setup only
docker compose up -d --wait postgres  # local/test Postgres :54329 (npm run dev starts it too)
npm run dev                     # local Postgres + D1 setup, founder bootstrap, Worker :8787
npm run seed:local              # seed the accepted-state fixture pack into local R2 and Postgres
npm run ops -- db migrate       # plan PostgreSQL migrations (db/migrations/); --execute applies
npm run fixtures:app            # regenerate app/'s browser-evidence fixture snapshot
npm run test:quiet              # preferred; same suite as npm test
npm run types:check             # verify checked-in Wrangler runtime types
npm run typecheck

cd web
npm ci
npm run dev                     # SPA :5173, in a separate terminal
npm test
npm run build                   # TypeScript check plus Vite build

cd app                          # new TanStack Start frontend (ADR 0003)
npm ci
npm run dev                     # :5174, proxies /api to :8787
npm run typecheck && npm test
npm run build && npm run test:smoke
npm run test:browser            # Playwright: themes, viewports, axe, keyboard
npm run test:browser:ci         # the essential subset CI runs
```

There is no lint script. Full Worker verification is `npm test`,
`npm run types:check`, and `npm run typecheck`; SPA verification is `npm test`
plus `npm run build` in `web/`; frontend verification is `typecheck`, `test`,
`build`, `test:smoke`, and `test:browser` in `app/`. CI runs Worker and Node
tests, SPA tests/build, the `app/` checks and its browser-evidence job, and
the Ops CLI job, all on Node 22. The browser-evidence job runs
`test:browser:ci`, the essential subset; run the full `test:browser` locally
before shipping a frontend change. On pull requests each job runs only
for the paths its suite reads, as mapped in `scripts/ci-lib/changed-jobs.ts`;
update that map when a suite starts reading a new path. Unmapped paths run
everything. Pushes to main run every job, and documentation-only pushes skip
CI and deployment.

Use [reading-lite-local](.agents/skills/reading-lite-local/SKILL.md) to run the
`app/` frontend and the backend together locally. [docs/docker-compose.md](docs/docker-compose.md)
runs the same two Workers in isolated containers instead, as an alternative.

Regenerate `worker-configuration.d.ts` with `npm run types:generate` after
changing Wrangler or runtime compatibility date/flags. Commit the generated
file. Generation excludes bindings; keep the application `Env` in `src/index.ts`.

| Path | Supported Node | How Wrangler is launched |
| --- | --- | --- |
| `npm run ops` | Node **22** | `scripts/lib/wrangler-cli.ts` → `wrangler-dist/cli.js` |
| `npm run dev` (and types:generate / types:check) | Node **22.12+** | npm bin wrapper `bin/wrangler.js` |
| CI | Worker, SPA, app, and ops: Node **22** | Worker tests stay on workerd |

`app/` also needs Node 22.12+. `engines.node` (`>=22.0.0`) is only the install
and ops floor. See [operator Node](docs/operations.md#operator-node).

Run the Worker suite on Node 22 (`mise.toml` pins it; `mise exec node@22 --`
works from a worktree that does not inherit it). Node 24 and 25 fail it in ways
that have nothing to do with the code under test: a pool worker aborts and the
run exits 1 with every test passing, or the run dies on an EPIPE. After
switching Node versions in a tree whose `node_modules` was installed under
another one, run `npm rebuild better-sqlite3` — otherwise the Node-pool suites
that open a SQLite fixture fail on the native module's ABI, not on their
assertions.

## Where to work

| Area | Entry points |
|---|---|
| HTTP and MCP | `src/router.ts`, `src/middleware.ts`, `src/mcp/` |
| Frontend server reads | `src/frontend-reads.ts` (`FrontendReads` entrypoint), `app/src/server/backend-reads.ts` |
| Intake and processing | `src/intake/`, `src/process-reading.ts`, `src/attempt-ownership.ts` |
| Publication and purge | `src/modules/stores/postgres/reading-writer.ts`, `src/attempt-io.ts`, `src/reading-purge.ts` |
| Tenant auth, quotas, leases, spend | `src/control-plane/`, `src/modules/paid-pricing/` |
| Account deletion | `src/account-wipe.ts`, control-plane `wipe-progress.ts`, `vector-ledger.ts`, `account-teardown.ts` |
| Digests | `src/digest-pipeline.ts`, control-plane digest ledger, `src/modules/digest-*` |
| Provider and extraction adapters | `src/modules/{extractor,embeddings,summarizer,openai-summarizer,anthropic,http-retry}/` |
| Reading storage ([ADR 0005](docs/decisions/0005-postgresql-storage.md)) | `src/modules/db/`, `src/modules/stores/postgres/`, `db/migrations/`, `scripts/pg-lib/` |
| R2 content and keys | `src/modules/stores/content-store.ts`, `layout.ts` |
| Operator commands | `scripts/ops.ts`, `scripts/ops-lib/registry.ts`, `scripts/ops-lib/commands/`, shared `scripts/*-lib/` |
| Contracts and SPA | `src/schemas/`, `web/src/types.ts`, `docs/openapi.yaml`, `web/` |
| New frontend Worker | `app/` ([README](app/README.md), [ADR 0003](docs/decisions/0003-frontend-worker-topology.md)) |

## Development constraints

- Use TDD by default for behavior changes. Test public behavior and inject
  `fetch`, `now`, and `newId` through `src/services.ts`.
- Validate at seams with zod. Always parse rows read from PostgreSQL into the
  manifest and list shapes. Keep manifest and API schemas, tests,
  `web/src/types.ts`, and `docs/openapi.yaml` synchronized.
- Reading state and embeddings live in PostgreSQL; captured content stays in
  R2. Add no dual-write or fallback to the R2 manifests, `index/list.json`,
  pointers, or Vectorize. Construct stores with `pgReadingStoreFor`,
  `pgReadingWriterFor`, `pgSimilarityStoreFor`, and `contentStoreFor` from a
  validated `TenantContext`; every query is scoped by `tenant_id`. Session state
  does not survive Hyperdrive, so use `SET LOCAL` inside `sql.transaction`.
  `reading_embeddings` deliberately has no HNSW index. Never edit an applied
  file in `db/migrations/`.
- The control plane (users, sessions, challenges, tokens, settings, limits,
  digests, refresh checkpoints, wipe progress) is PostgreSQL behind
  `ControlPlaneDb` (`fromSql`). Epoch milliseconds cross to `timestamptz` only
  in `src/control-plane/pg-time.ts`. Where D1's single writer used to serialize
  a read-then-write, lock then act in `db.transaction`: `SELECT … FOR UPDATE`,
  or `lockKey` when the row may not exist yet. The Durable Object guards read
  limits and policy through `withControlPlane`.
- Never hold a transaction across a provider call or an R2 write. Queue and
  scheduled work use one `sqlSessionFor` session, ended when the work
  finishes; it replaces a client left idle across a provider call. Never call
  a session from inside its own `transaction` callback (use `tx`). Write
  content to R2 first, then commit the row that points at it.
- Keep URL ownership eager and per tenant: one unique `reading_urls` row,
  committed with the reading, its attempt, and its job. Ready/pending owners
  return the existing reading; failed owners reprocess in place. `/lookup` must
  remain one side-effect-free read, with no claims or repairs.
- Every writer verb locks the reading row and decides ownership under the lock.
  Publication is one transaction in a fixed order (lock, attempt ownership, URL
  ownership, revision, reading, relationships, embedding, attempt). A failed
  publish rolls back and requeues (`PublishCommitError`); do not mark the
  reading failed. The missing row is the deletion fence: never recreate a row
  for a purged reading.
- Each attempt writes content under its own `revisions/{attemptId}/` prefix;
  keep stored `key_prefix` and content keys relative, spelled by `r2KeyLayout`.
  Delete an attempt's content only through `discardUnreferencedContent`, which
  refuses a prefix the reading still points at.
- Keep embedding vectors at 1536 dimensions unless deliberately re-embedding
  into a fresh index. Provider selection and model/effort validation fail closed;
  preserve Anthropic's cached system/tool prefix and its snapshot tests.
- Hosted provider fetches must retain lease checks and budget admission inside
  the HTTP retry loop. Operator batch/eval/comparison clients are outside that
  enforcement. See [paid spend](docs/paid-provider-spend.md).
- A successful Markdown reprocess changes `source_type`; a failed one retains
  it, and a published reading keeps its previous content, summary, and
  embedding together. Supplied Markdown takes priority over stored text. See
  [reprocessing](docs/architecture.md#reprocessing-and-recovery).
- Keep reading, digest, and wipe queues separate. Only the reading DLQ calls
  `markDeadLettered`, and only it marks a job `dead`; digest DLQ marks its
  ledger failed, wipe DLQ logs and acks.
- No tenant, including founders and staging fixtures, is exempt from deletion.
  Wipes delete the tenant's reading rows and embeddings before its R2 objects,
  sweep rows again after, and fail closed on a database error. Teardown
  requires current wipe completion and a confirmed-empty prefix immediately
  before its final transaction, which locks the `users` and `wipe_progress`
  rows and re-checks both before deleting. Read the
  [deletion rules](docs/operations.md#account-deletion) before touching this path.
- Do not remove `nodejs_compat`. Keep bearer material out of browser storage.
  Both frontends invalidate queries after writes but do not poll pending
  manifests.

## Tests and local limits

`vitest.workspace.ts` separates Workers and Node pools. Integration tests run
on workerd; unit tests run in the Node pool unless they need `cloudflare:test`,
`cloudflare:workers`, or workerd semantics, in which case list them in
`WORKERS_RUNTIME_UNIT_TESTS`. `test/env.d.ts` supplies required
`cloudflare:test` Env typing. `wrangler.test.toml` has no Queue/Vectorize;
integration tests inject `installQueueStub()` and `installVectorizeStub()`.
The suite needs [local Postgres](docs/operations.md#local-postgres): globalSetup
migrates a per-checkout `reading_lite_test_<hash>` database once per run and fails fast when it is
unreachable, and tests never connect to Neon. The pool does not roll PostgreSQL
back, so each workers-pool file gets its own database, cloned from a migrated
template with `env.HYPERDRIVE` pointed at the clone
(`test/helpers/file-database.ts`); pass `env` to the Worker rather than using
`SELF`, which still sees the base database. Before each test the control-plane
tables are truncated and the founder re-bootstrapped, and the fixed tenants'
readings are cleared; the usage guards are pointed at the clone too
(`test/apply-control-plane.ts`). Store tests mint a tenant per test
(`test/helpers/pg-fixtures.ts`). Workers-pool tests read and seed the control
plane through `testControlPlane(env)` and inject database faults with
`interceptSql` (`test/helpers/sql-faults.ts`). Node-pool tests share the base
database: wrap control-plane ones in `useControlPlane()` / `useRolledBackSql()`
(`test/helpers/control-plane-pg.ts`, `pg-rollback.ts`), which roll each test back
and turn nested transactions into savepoints; that shares one client, so real
concurrency belongs in a workers-pool test. Seed and inspect reading state
through `test/helpers/test-readings.ts` (workers) or `node-readings.ts` (Node
pool); migration-runner tests create scratch databases.
Do not drain a queue before asserting an active pending state.

Give each behavior one test owner; don't re-assert the same case at unit and
integration, at phase and orchestrator, or at parser and every caller. Prefer
`it.each` tables over near-identical copies. Exceptions worth keeping even
when they look redundant: every ordering pin this file names as a contract
(publication transaction order, rows before objects, spend RPC order,
sidecar before create), fail-closed `not.toHaveBeenCalled` guards, cached-prefix
snapshots, and SPA-mirror typed parses. Don't add a test that can't fail
(asserting a constant equals its own literal, grepping source or docs for a
string, or exercising a plan-mode path that swallows the assertion) or a
duplicate `--tenant`-style check per command when a registry-level loop
covers all of them plus a unit test of the shared guard.

Local `wrangler dev` has no Queue, so submit/import/reprocess return 503. List,
detail, content, lookup, `q` text search, and similarity work against local
Postgres with the [seeded fixture pack](docs/design/connected/fixture-pack.md)
(`npm run seed:local`).
The example provider keys are fake; integration tests cover the pipeline.
For local login, request a magic link and read `/api/dev/mailbox?email=…` on
loopback. Never enable `LOCAL_MAIL_SINK` in deployed environments.

## Operations constraints

All supported operator workflows use `npm run ops -- <group> <command>`.
Durable changes plan by default and require `--execute`. Every `corpus` command
requires `--tenant`; production uses `/api/whoami`'s `tenant_id`.
`--tenant global` addresses retained pre-tenant data, not the live corpus.

Production and staging pin `TENANT_DATA_PLANE=1`. Removing the pin after tenant
writes resume requires a freeze and reverse reconciliation, or explicit
acceptance of the hidden post-cutover data. Tenant wipes never touch global
objects or unnamespaced vectors. Legacy deletion requires separate sign-off.
The 2026-08-31 founder migration is complete and its command is retired; do not
rerun it for releases or drills. Preserve the [cutover evidence](docs/founder-cutover.md).

Offline batch ingest/recover require `--sole-writer`, asserting that realtime
writers are paused and drained. Preserve sidecars and their resume rules; never
recreate an ambiguous batch. Restore missing vectors with `corpus backfill-vectors`,
not a paid reprocess. See [batch operations](docs/operations.md#provider-batch-apis).

Use [compare-summary-effort](.agents/skills/compare-summary-effort/SKILL.md) for
local comparisons on existing production readings. Plan first; only `--execute`
calls providers. Production stays GET-only. `ops eval summarizer` uses fixtures.
Reddit and full YouTube recovery use local import skills; X threads older than
seven days fail the recent-search path. See [source recovery](docs/operations.md#sources-that-need-a-local-skill).

Code merges run CI, then deploy the same commit's Worker, SPA, and `app/` frontend
(`readinglite.ai`, `readinglite.app`, and `next.readinglite.ai`) under a shared
release lock with stale-commit checks. Worker deployment applies pending D1
migrations before upload. The workflow checks unfinished wipes and wipe queues;
a direct `ops deploy worker` invocation does not run that separate wipe check.
See [deploying](docs/operations.md#deploying) for secrets, guards, and exceptions.

`.cursor/environment.json` installs both npm projects and runs
`scripts/cloud-agent-install.ts`. Cursor environment secrets are
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTH_ROOT_SECRET`,
`READER_API_TOKEN`, and `FOUNDER_EMAIL`; the installer writes `.stg.vars`.
Staging founder state persists in PostgreSQL (the bootstrap needs `DATABASE_URL`,
a direct connection string). Bootstrap again after credential rotation,
or set `CLOUD_AGENT_FOUNDER_BOOTSTRAP=1` for idempotent bootstrap on each install.
