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

## Where to work

| Area | Entry points |
|---|---|
| HTTP and MCP | `src/router.ts`, `src/middleware.ts`, `src/mcp/` |
| Frontend server reads | `src/frontend-reads.ts` (`FrontendReads` entrypoint), `app/src/server/backend-reads.ts` |
| Intake and processing | `src/intake/`, `src/process-reading.ts`, `src/attempt-ownership.ts` |
| Publication and purge | `src/reading-visibility.ts`, `src/reading-purge.ts` |
| Tenant auth, quotas, leases, spend | `src/control-plane/`, `src/modules/paid-pricing/` |
| Account deletion | `src/account-wipe.ts`, control-plane `wipe-progress.ts`, `vector-ledger.ts`, `account-teardown.ts` |
| Digests | `src/digest-pipeline.ts`, control-plane digest ledger, `src/modules/digest-*` |
| Provider and extraction adapters | `src/modules/{extractor,embeddings,summarizer,openai-summarizer,anthropic,http-retry}/` |
| R2 and Vectorize | `src/modules/stores/`, especially `layout.ts` for keys |
| PostgreSQL (candidate branch, [ADR 0005](docs/decisions/0005-postgresql-storage.md)) | `src/modules/db/sql.ts`, `src/modules/stores/postgres/`, `db/migrations/`, `scripts/pg-lib/` |
| Operator commands | `scripts/ops.ts`, `scripts/ops-lib/registry.ts`, `scripts/ops-lib/commands/`, shared `scripts/*-lib/` |
| Contracts and SPA | `src/schemas/`, `web/src/types.ts`, `docs/openapi.yaml`, `web/` |
| New frontend Worker | `app/` ([README](app/README.md), [ADR 0003](docs/decisions/0003-frontend-worker-topology.md)) |

## Development constraints

- Use TDD by default for behavior changes. Test public behavior and inject
  `fetch`, `now`, and `newId` through `src/services.ts`.
- Validate at seams with zod. Always parse manifests read from R2. Keep manifest
  and API schemas, tests, `web/src/types.ts`, and `docs/openapi.yaml` synchronized.
- Keep by-url ownership eager and per tenant. Ready/pending owners return the
  existing reading; failed owners reprocess in place. `/lookup` must remain
  side-effect-free, with no claims, repairs, or deep scans.
- Construct hosted stores with `readingStoreFor` and `similarityStoreFor` from
  a validated `TenantContext`. Keep stored `key_prefix` relative. Use
  `r2KeyLayout` for object keys and composed tenant vector IDs for writes.
- Maintain `index/list.json` through the existing CAS helpers on terminal
  writes. Keep ownership checks around publication and removal.
- Record vector IDs in D1 before every upsert. In `commitTerminalManifest`,
  this must precede the terminal manifest too: clearing `active_attempt` first
  makes a ledger failure impossible to recover by ordinary queue retry. D1
  failure blocks publication and purge; do not swallow it as bookkeeping.
- The runtime is never split between stores. The PostgreSQL read stores are
  built and tested but unwired; reads and writes switch together in slice 1b.
  Add no dual-write or fallback code. Construct them with `pgReadingStoreFor`
  and `pgSimilarityStoreFor` from a validated `TenantContext`; every query is
  scoped by `tenant_id`. Session state does not survive Hyperdrive, so use
  `SET LOCAL` inside `sql.transaction`. `reading_embeddings` deliberately has
  no HNSW index. Never edit an applied file in `db/migrations/`.
- Keep embedding vectors at 1536 dimensions unless deliberately re-embedding
  into a fresh index. Provider selection and model/effort validation fail closed;
  preserve Anthropic's cached system/tool prefix and its snapshot tests.
- Hosted provider fetches must retain lease checks and budget admission inside
  the HTTP retry loop. Operator batch/eval/comparison clients are outside that
  enforcement. See [paid spend](docs/paid-provider-spend.md).
- A successful Markdown reprocess changes `source_type`; a failed one retains
  it and restores a previously ready manifest. Supplied Markdown takes priority
  over stored text. Restoring the manifest does not restore overwritten content
  artifacts; see [reprocessing](docs/architecture.md#reprocessing-and-recovery).
- Keep reading, digest, and wipe queues separate. Only the reading DLQ calls
  `markDeadLettered`; digest DLQ marks its ledger failed, wipe DLQ logs and acks.
- No tenant, including founders and staging fixtures, is exempt from deletion.
  Wipes seed their own ledger, submit vector deletes before object deletes, and
  retain unconfirmed ledger rows. Teardown requires current wipe completion and
  a confirmed-empty prefix immediately before its D1 batch. Read the
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
unreachable, and tests never connect to Neon. PostgreSQL store tests mint a
tenant id per test (`test/helpers/pg-fixtures.ts`) because every file shares
that database; migration-runner tests create scratch databases.
Do not drain a queue before asserting an active pending state.

Give each behavior one test owner; don't re-assert the same case at unit and
integration, at phase and orchestrator, or at parser and every caller. Prefer
`it.each` tables over near-identical copies. Exceptions worth keeping even
when they look redundant: every ordering pin this file names as a contract
(ledger before manifest, vectors before objects, spend RPC order, sidecar
before create), fail-closed `not.toHaveBeenCalled` guards, cached-prefix
snapshots, and SPA-mirror typed parses. Don't add a test that can't fail
(asserting a constant equals its own literal, grepping source or docs for a
string, or exercising a plan-mode path that swallows the assertion) or a
duplicate `--tenant`-style check per command when a registry-level loop
covers all of them plus a unit test of the shared guard.

Local `wrangler dev` has neither Queue nor Vectorize. Submit/import/reprocess
return 503; vector similarity is empty. List, detail, content, lookup, and `q`
text search work with the [seeded local R2 fixture
pack](docs/design/connected/fixture-pack.md) (`npm run seed:local`).
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
Staging founder state persists in D1. Bootstrap again after credential rotation,
or set `CLOUD_AGENT_FOUNDER_BOOTSTRAP=1` for idempotent bootstrap on each install.
