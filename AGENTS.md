# AGENTS.md - reading-lite

Personal reading service on Cloudflare Workers plus a React SPA in `web/`.
Submitting a URL writes an eager by-url ownership claim, stores a pending
manifest in R2, and enqueues a `READING_JOBS` message; the consumer
(`processReading`) extracts, embeds with OpenAI, queries Vectorize for similar
readings, summarizes through the configured provider (OpenAI structured output
by default; Anthropic tool use when selected — provider selection never
falls back silently), and commits the terminal manifest plus `index/list.json`.

This file is the agent quick reference: module map, commands, conventions, and
gotchas. Elsewhere: `README.md` is the user-facing architecture and API guide,
`docs/operations.md` is the operator runbook (deploy, staging, bulk ingest,
corpus repair), and `CONTEXT.md` defines the domain language the code is named
after. Module design rationale lives in the header comments of the modules
themselves — read those before changing a module.

## Module Map

- `src/index.ts` — Worker fetch + queue handlers (main queue → `processReading`,
  DLQ → `markDeadLettered`).
- `src/router.ts` — HTTP API: auth, zod parsing, read paths, and the single
  `toHttp` mapping from `IntakeOutcome` onto statuses — a thin adapter over
  Reading intake.
- `src/intake/` — Reading intake, the write-side front door: `submit` /
  `importMarkdown` / `reprocess` own the claim → pending-manifest → activation
  ordering and return HTTP-free `IntakeOutcome`s. Reprocess prefers request
  Markdown over stored-Markdown synthesis; supplied Markdown bypasses
  `extracted.md`. `activation.ts` inside it is `activateAttempt`: the eager
  write-and-enqueue ordering plus the shared rollback-to-failed funnel.
- `src/process-reading.ts` — background pipeline, attempt logging, terminal
  manifest commits, failure handling.
- `src/reading-visibility.ts` — list-row + Vectorize-vector lockstep and the
  owner gate protecting it.
- `src/reading-purge.ts` — `DELETE /api/readings/:id`: visibility-first purge
  ordering (vector → owned by-url pointer → list row → objects → final sweep →
  by-id last) behind the `readings:delete` scope; inbound `connections` stay
  dangling. The consumer's purge guard (`missingManifestStillLive` in
  `process-reading.ts`) keeps stale queue messages from recreating purged
  state.
- `src/attempt-ownership.ts` — the shared ownership verdict + attempt args
  shapes (the low layer under `process-reading.ts` and `reading-visibility.ts`).
- `src/control-plane/` — D1 auth: branded IDs, HKDF/HMAC crypto,
  `AuthenticatedPrincipal`, founder bootstrap (`scripts/lib/founder-bootstrap.ts`),
  and bearer authentication via `requirePrincipal` in `src/middleware.ts`.
  Runtime auth does not fall back to `READER_API_TOKEN`; that secret is imported
  once as a legacy-format token.
- `src/modules/reading-claim.ts` — by-url ownership via
  `index/by-url/{sha256(url)}` pointers.
- `src/modules/staleness.ts` — the read-time stale-annotation rule.
- `src/modules/manifest-drafting.ts` — the pure constructors for every Manifest
  the system writes: pending drafts for the intake verbs, the queue-send
  rollback, and the terminal builders shared with the offline batch write phase
  (see CONTEXT.md "Manifest drafting").
- `src/modules/stores/` — `layout.ts` (the single-homed R2 key vocabulary:
  constants, `buildKeyPrefix`, and the tenant-rootable `r2KeyLayout` builders
  shared by the worker stores and the operator scripts), `reading-store.ts`
  (R2 codecs), `list-index.ts` (the `index/list.json` CAS subsystem),
  `similarity-store.ts` (Vectorize).
- `src/modules/{summarizer,openai-summarizer,anthropic,extractor,embeddings,email,http-retry}`
  — upstream-integration seams.
- `src/schemas/` — zod API + manifest contracts; `web/src/types.ts`
  hand-mirrors them.
- `scripts/ops.ts` + `scripts/ops-lib/` — the unified plan-first operator CLI:
  typed registry, dispatcher with shared exit semantics (0 ok / 2 usage / 1
  operational), native `run(argv, deps)` command modules under
  `ops-lib/commands/`, and `ops-lib/policy-contract.ts` (the tested extension
  contract for the future system-policy command, reading-lite-s1k.9.4).
  `test/unit/scripts/ops-registry-coverage.test.ts` fails when a supported
  workflow lacks a native command, safety classification, or help path.
- `scripts/*-lib/` — shared logic behind the CLI commands.
  `scripts/corpus-lib/batch/` is the offline provider Batch API pipeline:
  `run.ts`'s header documents the shared phase ordering; the recover front-end
  is `prepare.ts`/`extract-phase.ts`/`activation-phase.ts`, the fresh-markdown
  front-end is `prepare-fresh-markdown.ts`/`run-fresh-markdown.ts`.
- `web/` — React/Vite SPA (bearer token in localStorage, list/search, submit,
  detail/diagnostics, reprocess).

## Commands

```sh
npm install && cp .dev.vars.example .dev.vars
npm run dev
npm run test:quiet        # preferred over npm test — strips Workers-pool noise
npm run typecheck

cd web && npm install     # then: npm run dev, npm test, npm run build
```

Operator workflows live behind the unified plan-first CLI: `npm run ops --
<group> <command> [options]`. Every command with durable side effects plans by
default and acts only with `--execute`, e.g. `npm run ops -- deploy worker
--env staging --execute`, `npm run ops -- founder bootstrap --email
founder@example.com --execute`, `npm run ops -- corpus recover --tenant global --index
./index.json --execute`. See `docs/operations.md` or `--help` for the full
matrix.

## Environments

- Local `wrangler dev` (`reading-lite-dev`) intentionally has no Queue or
  Vectorize binding: submit/reprocess return 503 and similarity search returns
  nothing.
- Staging (`[env.staging]`, `reading-lite-staging`) and production
  (`[env.production]`, `reading-lite`, routed at `reading-lite.bbell.dev/api/*`)
  are fully isolated; `ops staging setup`/`ops staging teardown` are idempotent and
  hard-coded to staging names.
- Secrets via `wrangler secret put --env …`: `AUTH_ROOT_SECRET` and
  `OPENAI_API_KEY` always; `ANTHROPIC_API_KEY` only when
  `SUMMARIZER_PROVIDER=anthropic`; `RESEND_API_KEY` optional.
  `founder-bootstrap` reads `AUTH_ROOT_SECRET` and `READER_API_TOKEN` from
  `.dev.vars` / `.stg.vars` / `.prd.vars` (same `AUTH_ROOT_SECRET` as the
  Worker secret). `READER_API_TOKEN` is not a runtime auth fallback.
  Checked-in defaults: OpenAI `gpt-5.6-terra`; staging and production use
  `medium` effort, local uses `low`. Staging teardown's R2 emptying needs
  `CORPUS_R2_*` creds in env or `.corpus.vars`.

## Conventions

- Use TDD by default; test public behavior, not implementation shape.
- Inject `fetch`, `now`, and `newId`; the router takes `Services` from
  `src/services.ts` so tests can stub behavior.
- Validate only at seams: zod parses request bodies, R2 reads, and upstream
  responses. Manifest reads from R2 are always parsed (stored-schema drift).
- Keep by-url ownership eager: submit/import claim the URL slot before queueing.
  Ready/pending owners return the existing manifest; failed owners reprocess in
  place. Ownership is per tenant — hosted code constructs `ReadingStore` via
  `readingStoreFor` from a validated `TenantContext`.
- Keep `index/list.json` in sync on every terminal write, via existing
  `ReadingStore` helpers. When `TENANT_DATA_PLANE=1` those objects live under
  `u/{tenantId}/`; stored `key_prefix` stays relative. Do not turn the gate on
  in staging/production before the founder corpus copy (s1k.6).
- Keep Vectorize scoped the same way: hosted code builds the store via
  `similarityStoreFor`, which maps the tenant onto a Vectorize **namespace**
  (its own segmentation primitive — a namespaced query cannot match another
  namespace's vector, and unlike a metadata `filter` it needs no metadata
  index). While the gate is off the namespace is unset, which is what keeps the
  pre-tenant corpus visible. Flipping the gate therefore also requires
  re-upserting existing vectors into the founder namespace — a namespaced query
  will not see un-namespaced vectors, so a corpus migrated in R2 but not in
  Vectorize would silently return zero neighbours.
- Keep manifest contracts synchronized: `src/schemas/manifest.ts`,
  `src/schemas/api.ts`, tests, and `web/src/types.ts` change together.
- Keep summarizer config fail-closed: require the selected provider's
  credential, reject invalid provider/effort values, no implicit fallback.
- Preserve the Anthropic prompt-cache prefix (`buildSummarizeRequestBody` in
  `src/modules/anthropic`; snapshot tests guard it).
- Keep embedding vectors at 1536 dimensions unless deliberately re-embedding
  into a fresh Vectorize index.

## Testing Notes

- `vitest.workspace.ts` splits Workers-pool from Node-pool tests; anything
  importing Node built-ins belongs under the Node globs.
- `wrangler.test.toml` omits Queue/Vectorize; integration tests inject
  `installQueueStub()` / `installVectorizeStub()` fakes.
- Tests observing an active pending state must not drain the queue before the
  assertion.
- `test/env.d.ts` is load-bearing (`cloudflare:test` `Env` typing).
- Full verification: `npm test` + `npm run typecheck`; SPA: `cd web && npm test
  && npm run build`. CI runs the canonical `npm test`.

## Operational Gotchas

Pointers only — the details live in the named files' comments.

- `processReading` runs in the queue consumer. `RateLimitedError` → retry with
  delay, manifest stays pending; other errors → failed manifest + ack.
  Exhausted retries hit the DLQ, where `markDeadLettered` writes a retryable
  `failed`.
- Reprocess with a Markdown source flips `source_type` only after success;
  failures retain the prior source type, and ready readings also restore their
  preserved manifest. After a successful flip, later source-less reprocesses
  reuse stored Markdown.
- `GET /api/readings/lookup` must stay side-effect-free: no pointer claims,
  repairs, deep scans, or writes.
- Reddit can't be fetched from the worker (bot challenge) — the reading lands
  `failed` with guidance. The extract-agent makes one anonymous
  `<thread>.json?raw_json=1&limit=20&sort=top` attempt per manifest version and
  records challenges as durable `manual` outcomes; recover those with the
  **`reddit-import`** skill.
- YouTube extracts a metadata floor in-worker
  (`src/modules/extractor/youtube.ts`); for description + transcript use the
  **`youtube-import`** skill.
- Turndown/linkedom quirks and the raw-DOM salvage path are documented in
  `src/modules/extractor/index.ts`.
- Do not remove `nodejs_compat`; Worker dependencies and scripts rely on it.
- Offline batch tools (`ops corpus ingest --tenant global --execute`, `ops corpus recover --tenant global --batch
  --execute`) refuse to submit without `--sole-writer` — pause/drain the
  realtime writer first (`scripts/corpus-lib/sole-writer.ts`). Both resume from
  sidecars and never recreate a batch; claim/release/crash-resume semantics are
  documented in `activation-phase.ts`, `write-phase.ts`,
  `prepare-fresh-markdown.ts`, and `openai-reconcile.ts`.
- The SPA invalidates queries after submit/reprocess but does not poll pending
  manifests.

## Cloud Agents

`.cursor/environment.json` runs `npm ci`, `cd web && npm ci`, then
`scripts/cloud-agent-install.ts` on boot. Add these **environment secrets** in
the Cursor dashboard (not in git):

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — non-interactive wrangler
- `AUTH_ROOT_SECRET`, `READER_API_TOKEN`, `FOUNDER_EMAIL` — writes `.stg.vars`

Staging founder state already lives in D1 after the first bootstrap; re-run is
only needed after credential rotation. Set `CLOUD_AGENT_FOUNDER_BOOTSTRAP=1` to
run the staging founder bootstrap (`ops founder bootstrap --env staging
--execute` equivalent) on every install (idempotent).

## Working Locally

- There is no lint script. `npm run typecheck` (`tsc --noEmit`) is the static
  gate for the Worker; the SPA type-checks via `cd web && npm run build`
  (`tsc -b && vite build`).
- `.dev.vars` holds placeholders: `READER_API_TOKEN=dev-local-token` makes local
  auth work, but the provider keys are fake. Real summarization needs real keys
  plus Queue + Vectorize, which exist only in staging/production — you cannot run
  the full submit→summarize pipeline against local `wrangler dev`. It is covered
  end-to-end by the integration tests instead.
- Worker on `http://127.0.0.1:8787` (`npm run dev` runs `dev:setup` first to
  apply local D1 migrations and import `dev-local-token` as the founder legacy
  bearer), SPA on `http://127.0.0.1:5173` (`cd web && npm run dev`) proxying
  `/api` + `/health`. Paste the bearer token into the SPA's top-right field and
  Save.
- Read-path routes (list, detail, `/content`, `/lookup`) and `q` search on
  `GET /api/readings` work against the local R2 bucket without Vectorize. To try
  them against real data, see "Seeding local R2" in `docs/operations.md`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
<!-- Hand-merged union of the `bd setup claude` and `bd setup codex` blocks.
     CLAUDE.md symlinks to this file, so both recipes write here and each
     produced its own near-identical section. The `hash:` above is pinned to the
     template this merge came from, so `bd setup claude --check` reports it
     current and leaves the merge alone; re-pin it if you adopt a new template.
     A stub at the end of the file holds the codex recipe's markers so its
     re-runs replace that stub in place instead of appending a duplicate. -->
## Beads Issue Tracker

This project tracks issues with **bd (beads)**. Run `bd prime` for live session
context and the full command reference; `.agents/skills/beads/SKILL.md` (project)
or `~/.agents/skills/beads/SKILL.md` (global) holds the workflow guidance.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown
  TODO lists.
- Run `bd prime` when Beads context is missing or stale (after compaction, clear,
  or a new session). Codex 0.129.0+ can load it automatically through native
  hooks; use `/hooks` to inspect or toggle them.
- Use `bd remember` for persistent knowledge — do NOT create MEMORY.md or other
  ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses
`refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export.
See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for
details and anti-patterns.

### Agent Context Profiles

This block is task-tracking guidance, not permission to override repository,
user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits,
  git pushes, or Dolt remote sync unless explicitly asked. At handoff, report
  changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the
  same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may
  close beads, run quality gates, commit, and push as part of session close. A
  current "do not commit" or "do not push" instruction still wins.

### Session Completion

Subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** — create beads for anything needing follow-up.
2. **Run quality gates** (if code changed) — tests, linters, builds.
3. **Update issue status** — close finished work, update in-progress items.
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** — summarize changes, validation, issue status, and any blocked
   sync/commit/push step.

**Critical rules:**
- Explicit user or orchestrator instructions override this block.
- Do not commit or push without clear authority from the active profile or the
  current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
<!-- Intentionally empty. The codex recipe's content is merged into the unified
     Beads block above; these markers stay so `bd setup codex` replaces this
     stub in place rather than appending a second Beads section. -->
<!-- END BEADS CODEX SETUP -->
