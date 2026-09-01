# Operating reading-lite

Deploying, ingesting in bulk, and repairing the corpus. `README.md` covers the
architecture and the HTTP API; this document is the operator runbook.

Operator workflows run through the unified plan-first CLI: `npm run ops --
<group> <command> [options]`. Every command with durable side effects prints a
plan by default and acts only with `--execute`.

Every `corpus` command additionally requires `--tenant <selector>` before it
plans anything: `global` addresses the pre-tenant layout production data lives
under today, and a `usr_…` tenant id addresses that tenant's `u/{tenantId}/`
key namespace plus its Vectorize namespace (the same roots the worker derives
from a validated `TenantContext`). There is no default — a missing or
malformed selector is a usage error (exit 2) before any R2 or Vectorize
traffic, so an operator can never act on the global corpus by omission.

One caveat: `corpus recover`'s realtime path writes through the Reading API,
where the acting tenant is the **bearer token's** principal, not `--tenant`.
Before submitting, a realtime `--execute` therefore asks the worker who the
token is (authenticated `GET /api/whoami`, which also reports whether the
tenant data-plane gate is on) and fails closed on any mismatch: a `usr_…`
selector requires the gate on and the token's tenant equal to the selector;
`global` requires the gate off (with it on, every API write lands in the
token's tenant namespace, never the global layout). The verified layout is
then pinned onto every write via the `x-expected-tenant` header, which the
worker checks atomically per request — so a gate flip or rolling deploy
mid-run rejects later writes (412) instead of silently re-routing them. (The
pin protects only once every serving worker version enforces it: never flip
`TENANT_DATA_PLANE` in the same deploy that ships the pin — automatic under
the s1k.6 sequencing, where the flip comes well after.)
`--batch` is scoped by `--tenant` end to end and needs no verification.
(reading-lite-1xk)

## Environments

| Environment | Worker | Bucket / Vectorize index | Notes |
|---|---|---|---|
| local | `reading-lite-dev` | Miniflare-emulated R2 only | no Queue, no Vectorize |
| staging | `reading-lite-staging` | `reading-lite-staging` | same-origin `reading-lite-staging.bbell.dev` (Pages + `/api/*` `/health` `/mcp*`) |
| production | `reading-lite` | `reading-lite` | routed at `reading-lite.bbell.dev/api/*` + `/health` + `/mcp*` |

Environments do **not** inherit top-level `[vars]` or bindings — `wrangler.toml`
repeats them per environment. The distinct dev Worker name guards against an
accidental bare `wrangler deploy` clobbering production.

`TENANT_DATA_PLANE=1` prefixes hosted R2 keys as `u/{tenantId}/…`. Production
pins it in `[env.production.vars]` since the founder cutover (2026-08-31,
`docs/founder-cutover.md`); local and staging stay unset. Workers-pool tests
turn it on so two tenants can share a URL without colliding. Operator corpus scripts address whichever root
their required `--tenant` selector names — `global` until the migration.

### Secrets

Runtime Worker secrets (`wrangler secret put --env staging|production`):

| Secret | When |
|---|---|
| `AUTH_ROOT_SECRET` | always — 256-bit hex HKDF root for credential HMACs |
| `AUTH_PREVIOUS_ROOT_SECRET` | optional — previous root during a bounded rotation window |
| `OPENAI_API_KEY` | always — embeddings, and the default OpenAI summarizer |
| `ANTHROPIC_API_KEY` | only when `SUMMARIZER_PROVIDER=anthropic` |
| `X_API_BEARER_TOKEN` | only for `x.com` / `twitter.com` status URL imports |
| `RESEND_API_KEY` | required on staging/production — magic-link auth mail (never `EMAIL_TO`) and per-reading notifications |

Checked-in summarizer effort vars in `wrangler.toml` (and the dotenv examples):
`OPENAI_SUMMARIZATION_REASONING_EFFORT` is `low` locally and `high` in
staging/production. `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` uses the same
defaults and is applied only when `SUMMARIZER_PROVIDER=anthropic`. Claude Sonnet
5 (`ANTHROPIC_MODEL=claude-sonnet-5`) accepts `low`, `medium`, `high`, `xhigh`,
or `max` on `output_config.effort`; invalid values, efforts the configured
model cannot take, and model/effort pairs that 400 with
`thinking: { type: "disabled" }` (Fable 5, Mythos 5, Mythos Preview; Opus 5 at
`xhigh` or `max`) fail closed before any source fetch or upstream spend.

Optional version vars (`AUTH_ROOT_KEY_VERSION`, `AUTH_PREVIOUS_ROOT_KEY_VERSION`)
default to `1`. HKDF includes the version, so a secret-only rotation must keep
the previous root on the same version the tokens were minted with (the default).
Bump both version vars explicitly when advancing the key generation.

`founder-bootstrap` cannot read Wrangler secrets. Put the **same**
`AUTH_ROOT_SECRET` plus `READER_API_TOKEN` (and `FOUNDER_EMAIL` unless you pass
`--email`) in `.stg.vars` / `.prd.vars` or the process environment. A local
root that differs from the Worker secret produces HMACs the Worker cannot
verify. After import, `READER_API_TOKEN` is not a runtime Worker fallback;
keep it in the dotenv for operator CLIs that still POST that bearer.

`POST /api/readings` requests notification by default (`email: true`). Without
`RESEND_API_KEY` and the `EMAIL_*` / `WEB_BASE_URL` vars, submissions still
reach `ready` but log a failed `send_email` event; the reading is unaffected.

The offline corpus tools authenticate directly against Cloudflare rather than
through the Worker, and read `CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`,
`CORPUS_R2_SECRET_KEY`, and `CORPUS_CF_API_TOKEN` from the environment or
`.corpus.vars`.

### Deploying

Bring the control plane up before deploying a Worker that authenticates
against D1. `ops deploy worker` does not create the database or import the
founder token. `--execute` applies pending remote D1 migrations, then
uploads, and refuses placeholder `CONTROL_PLANE` `database_id` values in
`wrangler.toml`.

Staging:

```sh
cp .stg.vars.example .stg.vars   # AUTH_ROOT_SECRET, READER_API_TOKEN, FOUNDER_EMAIL, …
wrangler d1 create reading-lite-control-staging
# replace [env.staging] CONTROL_PLANE database_id in wrangler.toml
wrangler secret put AUTH_ROOT_SECRET --env staging   # same hex as .stg.vars
wrangler d1 migrations apply reading-lite-control-staging --env staging --remote
npm run ops -- founder bootstrap --email founder@example.com --env staging --execute
npm run ops -- deploy worker --env staging --execute
npm run ops -- deploy web --branch staging --execute
```

Production is the same sequence with `reading-lite-control`, `--env production`,
`.prd.vars`, and:

```sh
npm run ops -- founder bootstrap --email founder@example.com --env production \
  --execute --confirm-production
npm run ops -- deploy worker --env production --execute
npm run ops -- deploy web --branch main --execute
```

Merges to `main` start one coordinated production chain. After `.github/workflows/ci.yml`
succeeds, `.github/workflows/deploy-worker.yml` checks out that exact CI commit
and runs `ops deploy worker --env production --execute` (pending remote D1
migrations, then upload). It does not pass `--var`. `TENANT_DATA_PLANE` is
pinned in `[env.production.vars]`, so this path keeps the gate on; only removing
the pin rolls it off (see `docs/founder-cutover.md`).

After the Worker release succeeds, it publishes the released commit SHA for
`.github/workflows/deploy-spa.yml`. The SPA workflow validates and checks out
that SHA, installs both lockfiles with `npm ci`, then runs
`ops deploy web --branch main --execute` to build `web/` and deploy `web/dist`
to the production Pages branch. Both release stages refuse to deploy if `main`
has advanced at the deployment boundary, and one shared non-cancelling lock
serializes Worker and SPA production commands. An older run therefore cannot
overwrite a newer production release. Neither release workflow has a manual
trigger that can bypass the chain.

GitHub repository secrets (or the `production` environment):

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Non-interactive Wrangler. Grant Pages Edit for the SPA workflow. The Worker workflow also needs Workers Scripts Edit, D1 Edit, and zone Workers Routes on `bbell.dev` so migrations apply and the `/mcp*` route update succeeds. Scope the token to this account and zone. |
| `CLOUDFLARE_ACCOUNT_ID` | Account Wrangler deploys into. |

The imported founder token expires after 90 days; re-running the same
bootstrap command refreshes `expires_at_ms` and clears a revoked row.

When a release adds an API scope (e.g. `readings:delete`, migration
`0002_readings_delete_scope.sql`), existing tokens do not pick it up on their
own: `ops deploy worker --execute` applies the migration, then re-run the
same founder bootstrap command — its scope grants are idempotent and top up
the existing token.

`ops deploy worker` targets only staging and production (`--env`), so a dev
Worker can never be uploaded by mistake. `ops deploy web --skip-build` reuses
an existing SPA build.

Local `npm run dev` runs `dev:setup` first (local D1 migrations + founder
bootstrap of `dev-local-token`).

The SPA is served from Cloudflare Pages on the same custom domain as the Worker;
Worker routes are scoped to `/api/*`, `/health`, and `/mcp*` so Pages handles every other
path. Pages uses `web/public/_redirects` (`/* /index.html 200`) so `/auth/verify`
does not 404. Staging uses `https://reading-lite-staging.bbell.dev` the same way
production uses `https://reading-lite.bbell.dev`. Magic-link mail is built from
`WEB_BASE_URL` (`https://reading-lite-staging.bbell.dev/` on staging).

### MCP connector

`POST /mcp` is a Streamable HTTP MCP endpoint on the Worker. Cursor and Grok Bot
add it as a remote connector with a static `Authorization: Bearer <token>`
header (the same token as `reading-lite.bearerToken` / founder bootstrap).
There is no OAuth. Tools call the existing `/api/readings*` routes internally;
the token is never echoed in tool results.

Production needs the dedicated `reading-lite.bbell.dev/mcp*` Worker route so
Pages does not serve SPA HTML at `/mcp`. Attaching that route requires zone
Workers Routes permission on the Cloudflare API token; if `ops deploy worker
--env production` uploads the script but fails with authentication error 10000
on `/zones/.../workers/routes`, add the route in the dashboard (Worker
`reading-lite`, pattern `reading-lite.bbell.dev/mcp*`) or use the `/api/mcp`
alias which is already covered by `/api/*`. Staging has the same trio of
Worker routes on `reading-lite-staging.bbell.dev` (`/api/*`, `/health`, `/mcp*`).

`MCP_ALLOWED_ORIGINS` (wrangler var, default `https://reading-lite.bbell.dev`)
is the Origin allowlist. Requests with no `Origin` pass (non-browser clients).
Unknown Origins are 403.

Smoke the handshake after a worker deploy:

```sh
TOKEN=$(grep ^READER_API_TOKEN= .stg.vars | cut -d= -f2-)
curl -sS https://reading-lite-staging.bellbm.workers.dev/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Staging lifecycle

Staging exists for real end-to-end smoke tests that need Queue, R2, and
Vectorize without mutating the production corpus. Both lifecycle scripts are
hard-coded to staging resource names, refuse production-looking names, and are
idempotent — "already exists" on setup and "already gone" on teardown are
treated as success, while unexpected Wrangler or R2 API failures stop the run.

```sh
npm run ops -- staging setup --execute
npm run ops -- staging teardown --execute
```

Teardown removes Queue consumers before deleting the Worker, then deletes the
Queue/DLQ and Vectorize index, empties the bucket via the S3-compatible R2 API,
and deletes the bucket. The bucket-empty step needs the `CORPUS_R2_*`
credentials above.

Smoke-test idempotent submits against staging:

```sh
VARS_FILE=.stg.vars BASE=https://reading-lite-staging.<workers-subdomain>.workers.dev \
  ./scripts/manual/idempotency-smoke.sh a "https://example.com/reading-lite-staging-$RANDOM"
```

Clean up the throwaways afterwards, including `ready` ones:

```sh
npm run ops -- corpus audit --tenant global --bucket reading-lite-staging --execute
npm run ops -- corpus drop --tenant global "https://example.com/reading-lite-staging-123" \
  --bucket reading-lite-staging --allow-ready \
  --vectorize reading-lite-staging --execute
```

## Diagnosing a single reading

`GET /api/readings/:id/diagnostics` shows whether the by-id and by-url pointers
line up, which R2 objects exist, the list-index row, and the recent attempt
records — including which stage failed (`fetch_source`, `embed_source`,
`summarize`, `upsert_vector`, `write_indexes`, …). Each background run stages an
attempt record under `readings/.../attempts/{attempt_id}.json` with the trigger,
stage, timings, and sanitized error details, so failures are inspectable without
`wrangler tail`.

`POST /api/readings/:id/reprocess` retries that exact id. A failed reading
becomes `pending` while the attempt runs. A ready reading keeps its current
manifest as the fallback: a successful attempt replaces the manifest and vector,
and a failed one preserves the ready manifest with
`last_attempt.status = "failed"`.

## Corpus tools

| Script | What it does |
|---|---|
| `npm run ops -- corpus audit` | inventory of every non-ready reading, classified by failure reason (plans by default; `--execute` writes `index.json` + `INDEX.md`) |
| `npm run ops -- corpus recover` | acts on an audit: reprocess or re-extract per a per-reason policy table (plans by default; `--execute` submits) |
| `npm run ops -- corpus drop` | remove readings by URL or id (`--allow-ready` also clears the vector) |
| `npm run ops -- corpus sweep` | reconcile duplicate copies of one resource across URL spellings (keeps the best, drops the rest with their vectors) |
| `npm run ops -- corpus backfill-similarity` | fill in `manifest.similarity` for readings written before the field existed (no embedding calls; writes only that field) |
| `npm run ops -- corpus refresh-neighbours` | re-measure every ready reading against Vectorize, print the staleness inventory, and write `refresh-report.json` (no LLM; `--execute` rewrites drifted snapshots and flushes `index/list.json`) |
| `npm run ops -- corpus refresh-connections` | consume `refresh-report.json`, plan relationship-only judgements with estimated cost, and selectively update connections, novelty, and the computation date |
| `npm run ops -- corpus refresh-tensions` | pair each flagged reading in `refresh-report.json` with its neighbours, pre-filter on overlap evidence, and judge directional tensions written to both manifests (`--pair a,b` hand-picks a pair) |
| `npm run ops -- corpus backfill-vectors` | restore missing Vectorize vectors by re-embedding stored TL;DRs (writes Vectorize only; R2 stays read-only) |
| `npm run ops -- corpus normalize-tags` | rewrite stored tags into canonical hyphenated form (writes only `manifest.tags`) |
| `npm run ops -- corpus purge-connections` | remove dangling inbound `connections[]` entries for one already-deleted reading id (full scan; plan-first; ETag CAS writes) |
| `npm run ops -- corpus rebuild-list` | rewrite `index/list.json` from live manifests (backfill list-row fields) |
| `npm run ops -- corpus delete-orphans` | remove orphan-duplicate pending readings consistently |
| `npm run ops -- corpus ingest` | bulk-ingest a fresh markdown directory through a provider Batch API |
| `npm run ops -- corpus migrate-founder` | copy the global layout into the founder tenant namespace and re-upsert vectors (plan doubles as the reconciliation check) |

`ops corpus refresh-neighbours` re-queries Vectorize by every ready reading's
stored vector id (no embedding calls, no LLM), prints the staleness inventory,
and always writes `refresh-report.json` — the input contract for later
judgement slices. The report compares stored connection IDs with the current
floored ready-neighbourhood. It distinguishes missing or non-ready citations
(`stale_connection`), still-ready citations that fell below the floor
(`connection_below_floor`), uncited neighbours created after the last judgement
(`new_neighbour`), and older uncited neighbours that now clear the floor
(`uncited_neighbour`). Realtime ingest and the offline batch write phase persist
the same candidate ID set on a ready manifest (`readyManifest`), including
candidates the summarizer did not cite, so the first neighbour refresh already
has a baseline. A later successful relationship-only judgement rewrites that
set. Later refreshes compare that stored set with the current floored
ready IDs in both directions, so a rejected candidate is not billed again while
the same candidate set remains. A newly present older candidate receives
`uncited_neighbour`; so does a previously considered uncited candidate that
later falls below the floor or becomes non-ready. This baseline tracks ID
membership; reprocessing the same candidate ID is not a membership change. The
producer preserves live ingestion's selection order: raw
Vectorize top five, similarity floor, then ready-ID intersection. It does not
fill vacated slots with lower-ranked ready readings. Plan mode does not mutate
R2. `--execute` rewrites only
drifted `manifest.similarity` snapshots (count change or `|Δmax|`/`|Δmean|`
≥ 0.02) and then does a wholesale plain put of `index/list.json` — not CAS,
the same class of write `rebuild-list` guards with `--sole-writer`. Do not
run `--execute` while submissions are in flight: a concurrent queue write
can be clobbered. Leaves status, vectors, title, tldr, tags, keywords,
entities, and `summary_markdown` untouched. A second immediate `--execute`
writes nothing.

```sh
npm run ops -- corpus refresh-neighbours --tenant global
npm run ops -- corpus refresh-neighbours --tenant global --execute
```

`ops corpus refresh-connections` consumes that report and rejudges only the
flagged readings. Plan mode validates the report tenant and every live target,
prints the provider/model/effort, each selected judgement, and estimated
synchronous cost, then exits without a provider call or storage write.

```sh
npm run ops -- corpus refresh-connections \
  --tenant global --report ./refresh-report.json

# Start with a controlled production write after pausing and draining every
# corpus writer for the selected tenant.
npm run ops -- corpus refresh-connections \
  --tenant global --report ./refresh-report.json \
  --execute --sole-writer --limit 1
```

Execute mode reads the target's stored summary and judges it only against live,
ready neighbours carried by the report. It drops provider ids outside that
set, preserves an existing connection object when the provider reaffirms its
id, and replaces only `connections`, `novelty_verdict`, and
`connections_computed_at`. Manifest writes use ETag CAS. The list index is
written after successful manifest updates so its verdict matches the manifest.

The manifest timestamp is the resume marker. If a manifest write succeeds but
the list write fails, rerun with the same report: the command heals the list row
without another paid judgement. `--limit` caps judgement and healing actions.
Provider errors and lost CAS races leave the reading ready and never blind-write
over newer state. The price estimate uses a four-UTF-8-bytes-per-token
approximation, a 256-output-token assumption, and the dated price table printed
by the command; it is a planning estimate, not a bill.

Run a fresh neighbour refresh immediately before this command. The report must
name the same `--tenant`; a mismatched selector is refused. The sole-writer
window must cover provider calls, manifest CAS writes, and the final wholesale
`index/list.json` put. The command also refuses the report if a target or
candidate neighbour was reprocessed after the report was generated.

`ops corpus refresh-tensions` is the pairwise sibling. It reads the same
report, pairs every flagged reading with each live ready neighbour, collapses
both directions onto one pair, and keeps only pairs whose stored manifests
share a named person or organization, at least a fifth of their keywords
(Jaccard ≥ `TENSION_KEYWORD_JACCARD_MIN` in
`scripts/corpus-lib/refresh-tensions.ts`), or an existing connection. Tags
and the similarity score alone never qualify. Pairs both sides already
remember judging (`tensions_judged`) since their last ingest write are skipped.
Plan mode prints each pair with its overlap evidence and estimated cost plus
every free repair, and writes nothing.

```sh
npm run ops -- corpus refresh-tensions --tenant global --report ./refresh-report.json

# Hand-pick a pair known to conflict. With --pair the report is read only
# when --report is passed explicitly.
npm run ops -- corpus refresh-tensions \
  --tenant global --pair rd_older,rd_retraction --execute --sole-writer
```

Execute mode makes one pairwise provider call per selected pair and writes
each side's directional entry — `contradicts` (symmetric), `supersedes` /
`superseded_by`, `qualifies` / `qualified_by`, always from that reading's point
of view with one shared reason — plus a `tensions_judged` record to BOTH
manifests with ETag CAS. A `none` verdict removes any prior entry for the pair
and is remembered so the pair is not re-judged nightly. Only `tensions` and
`tensions_judged` change; `updated_at`, connections, and every summary field
stay byte-identical, and `index/list.json` is never written. `--pair` bypasses
the overlap filter and the judged skip but both sides must still be live ready
manifests.

The two writes are not atomic. If the second CAS write loses, the command
reports the pair as one-sided; the next run mirrors the inverse entry to the
other side without a paid call as long as that side has not been reprocessed
since the judgement. A partner reprocessed since (its `updated_at` is newer
than the entry's `computed_at`) makes the stored judgement stale: the entry is
dropped, and the pair is re-judged when the report next pairs them. An entry
whose partner is gone from the list index (deleted, since a ready reading
never regresses to failed or pending) is purged from the holder together with
its judged record, so tier 1 stops flagging the holder. A successful reprocess rebuilds a manifest without its tensions on purpose; the
partner's side is repaired the same way. A failed reprocess keeps them but
still bumps `updated_at`, so that reading's pairs are re-judged once at the
usual cost. Repairs are found among the readings the report or `--pair`
names, not by a corpus-wide scan. A stale report (any reading it names was
rewritten after it was generated) is refused even when `--pair` names the
drifted reading; regenerate it or omit `--report`.

Deploy a Worker whose `ManifestSchema` knows `tensions` **before** the first
production `--execute`: the Worker parses every manifest it reads with
`.strip()`, so an older Worker rewriting a manifest (a reprocess or a
preserve-and-roll-forward) would silently drop the field.

`ops corpus rebuild-list` re-projects every indexed manifest through
`manifestToIndexItem` and writes `index/list.json`. Use it after deploying a
Worker that added list-row fields (keywords, for `q` search) so existing
readings become searchable without a paid reprocess. Dry-run by default;
`--execute` requires `--sole-writer` because the rewrite is a plain put.

```sh
npm run ops -- corpus rebuild-list --tenant global --bucket reading-lite
npm run ops -- corpus rebuild-list --tenant global --bucket reading-lite --execute --sole-writer
```

Deploy the new Worker **before** the production rewrite. An old Worker that
later commits a terminal manifest would strip the new fields off that row.

### Purging connections to a deleted reading

`ops corpus purge-connections` is the explicit offline cleanup for inbound
`connections[]` entries that still name one deleted reading. `DELETE
/api/readings/:id` deliberately does not scan the corpus, enqueue cleanup, or
write a tombstone, so a reading-detail link may return 404 until an operator
runs this sweep. Cleanup is not automatic.

```sh
# Exact plan; reads and validates the complete global manifest set, writes nothing.
npm run ops -- corpus purge-connections --tenant global --id rd_deleted

# Apply to one tenant namespace after establishing the sole-writer window.
npm run ops -- corpus purge-connections \
  --tenant usr_… --id rd_deleted --execute --sole-writer
```

The target id must be absent from the selected namespace before the scan and
again immediately before mutation. The command refuses a present target or any
malformed canonical manifest, with no preflight writes. Only exact
`readings/{year}/{month}/{timestamp}-{id}/manifest.json` objects enter the
scan; nested attempt or backup objects and other manifest-shaped JSON are
ignored. Each selected key must also round-trip from the parsed manifest's
`id` and `created_at`. The command compares the bare `id` inside each
connection even when R2 object keys are tenant-prefixed, removes every exact
match, preserves unrelated connection order and manifest fields, and is
idempotent when rerun.

`--execute` is accepted only with `--sole-writer`. For this command,
`--sole-writer` is the operator assertion that no ingestion, reprocessing,
deletion, or recreation can mutate the selected corpus for the command's full
duration. Each manifest update still uses its listed ETag as an `If-Match` CAS.
On conflict the command boundedly re-lists, validates, proves the target is
still absent, recomputes against the newest manifest, and retries; it never
blind-writes. Exhaustion or target recreation exits nonzero and reports whether
earlier manifests were already changed.

The single-line JSON audit reports `mode`, the explicit tenant/global selector
(and `tenant_audit_stamp.tenant_id` for tenant mode), `target_id`, manifests
scanned and matched, matching entries, manifests written or that would be
written, unchanged manifests, conflicts, retries, failures, and
`partial_execution`. Failures also include a bounded `failure_code` and
`failure_stage`; provider response bodies and credentials are never copied
into the audit or error stream. The command emits exactly one final audit even
when a later storage operation fails after earlier writes. R2 listing
pagination is completed by the shared client and canonical manifest keys are
processed in deterministic lexical order.

`ops corpus recover` has two execution paths: `--wave` paces realtime
submissions through `POST /api/readings/:id/reprocess`, and `--batch` routes the
same work through the offline provider Batch API path described below.

```sh
npm run ops -- corpus audit --tenant global --execute      # writes index.json + INDEX.md
npm run ops -- corpus recover --tenant global --index ./index.json --execute
```

### Founder corpus migration (s1k.6)

Production cutover (HITL gates, freeze, repair, copy, gate flip, verify,
rollback, observation) is [`docs/founder-cutover.md`](founder-cutover.md),
written from the 2026-08-27 staging rehearsal. This section is the command.

`ops corpus migrate-founder` moves the pre-tenant corpus into the founder's
tenant namespace as a **copy, never a move**: every global-layout object is
copied byte-identically to `u/{tenantId}/{same key}` (stored `key_prefix`
values are root-relative, so no object body changes), and every ready
reading's vector is re-read by id and re-upserted into the tenant namespace
as `{tenantId}:{readingId}` with `tenant_id` metadata (ADR 0002) — no paid
re-embedding. Legacy objects and vectors are always retained; the command
never deletes anything.

```sh
# Exact dry-run: every copy (size+etag), every vector upsert, every problem.
npm run ops -- corpus migrate-founder --tenant usr_… 

# Copy + migrate vectors, resumably (state file records per-object sha256):
npm run ops -- corpus migrate-founder --tenant usr_… --execute --sole-writer

# Reconcile: plan again — "fully migrated" means every source object exists
# at its tenant key with equal size/etag, every ready row has its namespaced
# vector carrying the legacy embedding and metadata, and every row agrees
# with the manifest and by-id pointer it names.
npm run ops -- corpus migrate-founder --tenant usr_…
```

Certification is a content check, not a presence check: the plan parses each
row's `manifest.json` and by-id pointer and blocks when they disagree with
the row (`row_manifest_mismatch`, `row_by_id_pointer_invalid`). A stale
`index/list.json` row is the case that matters — the vector plan follows the
row's `status`, so a row saying `failed` over a `ready` manifest would migrate
with no vector planned. Repair those with `corpus rebuild-list --tenant
global`, then re-plan.

That costs two reads per row the first time. After that the state file caches
each parse against the object's etag, so passes over an unmoved corpus read
nothing — every pass prints `Verified N row(s) … (R object reads, C served
from the state file's etag cache)`, and a high `R` on a corpus you have not
touched means the cache is not being reused (no state file yet, or a
different `--state` path). Pass the same `--state` to plan and execute to
keep it warm. Plan mode reads that file and never writes it. The cache holds
what the objects *said*, never whether they passed: the row comparison always
re-runs against the live `index/list.json`, so a row that goes stale while
its manifest sits untouched is still caught.

Both modes need an account id plus either S3 `CORPUS_R2_*` keys or
`CLOUDFLARE_API_TOKEN` / `CORPUS_CF_API_TOKEN` (R2 REST). Plan reads live
listings, per-row manifest/pointer content, and vector state.
`--limit` caps work per pass for interrupted-run rehearsal; the
tenant-stamped state file refuses resumes under a different tenant, bucket,
or index.

Cutover ordering, gate-flip commands, and the staging-rehearsal pitfalls
(stale `index/list.json`, missing vectors, Vectorize `get_by_ids` cap of 20,
`--var` vs `ops deploy worker`) are in
[`docs/founder-cutover.md`](founder-cutover.md). Rollback before the flip is
"don't flip"; after, unset the gate and redeploy — legacy state survives
until post-observation sign-off (ADR 0001).

### The extract-agent

Some sites hard-block Cloudflare datacenter egress, so the Worker's
`fetch_source` fails where a residential IP succeeds. `ops extract agent`
polls the reading API for `fetch_source`-failed readings and re-extracts them
locally: an SSRF-guarded static tier with browser headers, falling back to a
headless Playwright render when the static tier is challenged or finds no real
article, plus an anonymous Reddit thread-JSON path. Successful markdown re-enters
through `POST /api/readings/import-markdown`.

```sh
npm run ops -- extract agent [--execute] [--limit N] [--only <id|url>] [--verbose]
```

Every submit is a paid action, so runs plan by default and are capped per
run. Plan mode persists nothing; on `--execute` a lockfile prevents two
overlapping runs from double-submitting, the run appends a JSON line to the
run log, and a completed run pings a dead-man healthcheck. Configuration lives in `.extract-agent.vars` (gitignored)
or the environment; the knobs are documented in
`scripts/extract-agent-lib/config.ts`. Reddit threads that answer with a
challenge are recorded as durable `manual` outcomes and left for the
`reddit-import` skill.

## Bulk ingest

### Chrome bookmarks

Ingests URLs from a Chrome bookmark export, asking `Y/n/q` before each URL
(Enter or `y` submits, `n` skips, `q` aborts).

```sh
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute --quick
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute \
  --folder "Computing/AI/MCP" --url https://reading-lite.bbell.dev/api/readings
```

The default folder is `Computing` (top-level, i.e. under "Other Bookmarks").
`--url` is the **full** readings endpoint (default `http://127.0.0.1:8787/api/readings`,
or `READER_URL`). Omitting `--execute` prints the would-submit list without prompting or
POSTing. `--quick` skips the per-URL prompt; submission is always serial so the
local index can't race itself. Token resolution mirrors `ops reading submit`:
`--token` > `READER_API_TOKEN` env > `.dev.vars`.

Transport-level fetch failures retry twice (250 ms / 500 ms); errors surface
their underlying cause. `new`/`existing` responses are recorded in
`.import-bookmarks-index.json` (scoped per destination URL) immediately, so an
interrupted run resumes; errors are *not* recorded, so the next run retries
them. The Worker also dedupes via the by-url pointer, so deleting the local
index is safe — it just re-POSTs every URL once to rebuild it.

### Local markdown

Imports `.md` files without re-fetching their source URLs. Each file must carry
a source line:

```md
**Source:** https://example.com/article
```

That URL becomes the canonical reading URL and the body is sent to
`POST /api/readings/import-markdown`. Duplicate files sharing a source URL are
collapsed before submit — the largest file wins. Imported readings store the
markdown as both raw content and `extracted.md`, then reuse the normal
embedding, similarity, summary, Vectorize, manifest, and list-index pipeline.

```sh
npm run ops -- import markdown --dir ~/Documents/articles           # plan, no token needed
npm run ops -- import markdown --dir ~/Documents/articles --execute  # local dev
npm run ops -- import markdown --dir ~/Documents/articles --execute \
  --url https://reading-lite.bbell.dev/api/readings/import-markdown
```

`--url` is the full import endpoint; token resolution matches the other scripts.
Files above the Cloudflare Queues 128 KB message limit are blocked before any
POST. Successful new/existing responses are recorded in
`.import-markdown-index.json` (scoped by destination URL) and move every file
for that source URL into a `processed/` subdirectory. Email is off by default;
pass `--email` to request notifications.

### Provider Batch APIs

`import-markdown` summarizes every file **realtime** through the Worker queue.
For large backfills, `ops corpus ingest` runs the same directory through the
configured provider's **Batch API**, and `ops corpus recover --tenant global --batch` does the same
for readings already in the corpus. Both talk to R2 and Vectorize directly with
`CORPUS_R2_*` credentials rather than through the HTTP API, and both need
`CORPUS_CF_API_TOKEN` plus `OPENAI_API_KEY` (embeddings); `ANTHROPIC_API_KEY` is
needed only to start or resume an Anthropic batch. `--execute` requires the
applicable credentials; a dry run degrades to the local plan without them. There
is no cross-provider fallback.

```sh
# dry run (default): print the plan; with creds it also shows ownership skips
npm run ops -- corpus ingest --tenant global --dir ~/Documents/articles

# for real — confirm the realtime writer is paused/drained first
npm run ops -- corpus ingest --tenant global --dir ~/Documents/articles \
  --execute --sole-writer --bucket reading-lite
```

The resulting `ready` manifests are contract-compatible with the realtime import
path (`source_type: "markdown"`, captured content, correct
`content_bytes`/`content_sha256`, `usage.openai_embedding_tokens`, by-url and
by-id pointers, a Vectorize vector, and an `index/list.json` row). Both batch
paths stamp a terminal `last_attempt` summary in the manifest, but they do not
write the realtime per-attempt objects under the key prefix. A resumed
pre-upgrade sidecar without attempt identity retains the legacy omission of
`last_attempt`.

**`--sole-writer` is enforced, not assumed.** `ops corpus ingest --tenant global --execute` and
`ops corpus recover --tenant global --batch --execute` refuse to submit without it. Both batch paths
eagerly claim by-url slots (recover via a failed→pending flip that keeps its
claim on failure, so the URL stays re-submittable), but that claim is
defense-in-depth rather than a replacement for pausing the realtime writer. An
acknowledged run prints a loud banner before any submit; dry runs submit nothing
and never require the flag. The enforcement lives in
`scripts/corpus-lib/sole-writer.ts`.

**Idempotency** is resolved client-side from `index/by-url/{sha256(url)}` by the
same rules as the Worker's `ReadingClaim`: a pointer counts as owner only when
its manifest actually matches (id + url + url_hash), so ready and pending owners
are skipped while failed owners re-ingest in place; a fresh pointer whose
manifest hasn't landed yet is treated as still-initializing and skipped (a
realtime submit may be in flight); unclaimed URLs mint a new reading; and
damaged or mismatched pointers are skipped for operator repair rather than
claimed over. With no by-url pointer at all, the tools first run the Worker's
cold-legacy lookup (`findManifestByUrl` over `index/list.json`), so a prior
legacy failed ingest with a by-id pointer and list row but no by-url pointer is
re-ingested in place instead of duplicated. Pending owners are skipped even past
`PENDING_TTL_SECONDS`: this offline path cannot safely supersede a queue worker
that may still be running, so a stranded pending is left to heal via the
realtime API or `ops corpus recover`.

**Sizing.** Before any fresh eager activation write, the batch path preflights
the provider payload, resolves similar-reading context, then validates the final
request payload. OpenAI JSONL is measured as exact UTF-8 bytes and capped at
50,000 requests and 190 MB; Anthropic payloads use a 200 MB safety cap. If a run
is too large, rerun with `--limit` to split it without leaving pending owners
behind.

**Resume.** The in-flight batch is recorded in a versioned sidecar
(`./corpus-ingest.batch.json` by default); re-running resumes that batch instead
of creating a second, double-billed one. The sidecar pins provider, model,
OpenAI reasoning effort, and a stable run id, so an environment change cannot
switch a resume to another provider. New Anthropic batches send
`output_config.effort` from `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` on the
same request body as realtime (`low`, `medium`, `high`, `xhigh`, or `max` on
Claude Sonnet 5; invalid values fail closed before submit). OpenAI's pre-submit upload/create phases are
persisted — a companion `<sidecar>.input.jsonl` holds the exact JSONL bytes,
written before the `uploading` checkpoint. On resume the reconciler adopts what
already exists: remote files by filename (`reading-lite-${runId}.jsonl`), remote
batches by `metadata.run_id`. A sidecar-scoped file lock serializes the initial
upload/create transition against any later resume.

The expensive `create` step is deliberately **fail-closed**: a list-then-create
cannot distinguish a successful-but-lost-response prior create from a failed one
(the OpenAI Batch API has no idempotency key, and listing can lag), so an
ambiguous match or no visible remote batch at the create step aborts and asks
for a manual reconcile. Anthropic pre-submit and OpenAI `activating` sidecars
also require manual reconcile. If a batch fails, the write phase releases the
eager by-url claim only when the pointer still exactly matches the failed target.

Claim, release, and crash-resume semantics are specified in
`scripts/corpus-lib/batch/activation-phase.ts`, `write-phase.ts`,
`prepare-fresh-markdown.ts`, and `openai-reconcile.ts`; `run.ts`'s header
documents the shared phase ordering.

## X threads

Submitting an `x.com/<user>/status/<id>` or `twitter.com/<user>/status/<id>`
URL retrieves the linked author's same-author self-reply component through the
X API. Sharing a middle post includes its author-written ancestors and
descendants; audience replies and author side conversations reached through an
audience reply are excluded. Quoted posts are rendered as context but their
threads are not traversed. The raw artifact is the bounded aggregate API JSON,
and the reconstructed Markdown is used as the reading body.

This path requires `X_API_BEARER_TOKEN`. It uses only
`/2/tweets/search/recent`, consumes every pagination token, and never falls back
to full-archive search or X's JavaScript page shell. If the conversation root is
outside the seven-day recent-search window, the reading lands `failed` with:

> This X thread is older than the 7-day recent-search window and cannot be imported.

This personal tool does not implement X deletion/edit compliance
synchronization.

## Comparing summarizers on production readings

To compare OpenAI (including `max`) and Anthropic Sonnet on one or more
**existing production readings**, use the compare-summary-effort skill — not
`ops eval summarizer` (that is the fixture-based quality matrix).

```sh
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
  --target rd_EXAMPLE \
  --target 'https://example.com/article' \
  --model gpt-5.6-luna \
  --effort max
```

Plans by default (prints the readings × candidates matrix and a conservative
cost ceiling). `--execute` is the only paid path. Production is GET-only: no
`/reprocess`, no manifest/vector/list writes, no wrangler or production config
change. Anthropic effort is optional; omit `--anthropic-effort` to run Sonnet
once with no effort field. See `.agents/skills/compare-summary-effort/SKILL.md`.

## Sources that need a local skill

### Reddit

Reddit serves a bot challenge to datacenter egress, so the Worker cannot fetch
thread JSON — `POST /api/readings` with a `reddit.com` / `redd.it` URL
deliberately lands `failed`. Use the **`reddit-import`** skill instead: it drives
a logged-in Chrome session to fetch the public `<thread>.json`, renders the post
plus top comments to markdown with the same parser the Worker uses, and imports
it via `POST /api/readings/import-markdown`. No Reddit app or OAuth credentials
are needed. The skill wraps `ops import reddit <redditUrl> --json <saved.json>`,
which plans by default (omit `--execute`) to preview the markdown.

### YouTube

YouTube watch pages have no server-rendered article body, so the extractor
handles them in-worker rather than through Readability. Submitting a
`youtube.com/watch`, `youtu.be`, `shorts`, `live`, or `embed` URL builds markdown
from the public oEmbed metadata (title + author — the reliable floor), plus a
best-effort description (from the page's `ytInitialPlayerResponse`) and
transcript (the first caption track) when YouTube serves them. Unlike Reddit the
URL summarizes to `ready` directly, but in practice the Worker is usually blocked
from the watch page and lands the floor only.

For a full extraction — description plus transcript — run the
**`youtube-import`** skill locally, which fetches the watch page from your
residential IP and uses `yt-dlp` for the transcript, then imports the rich
markdown through the same parsers the Worker uses. Requires `yt-dlp` on PATH.

```sh
npm run ops -- import youtube "<youtubeUrl>" --execute   # omit --execute to preview
```

## Seeding local R2

To exercise the read path or the SPA against real data locally, seed the local
bucket and then restart `wrangler dev` — the running dev server caches R2
in-process. Seed via **Miniflare** (persist path `.wrangler/state/v3/r2`, bucket
`reading-lite`), *not* `wrangler r2 object put --local`, which writes to a
different local store the dev server never reads.

A minimal `ready` reading needs:

- `readings/<key_prefix>/manifest.json` — a valid `ManifestSchema` with
  `content_status: "captured"`
- `index/by-id/<id>`
- `index/by-url/<url_hash>` — matching the manifest's `url_hash`
- a row in `index/list.json`
- `readings/<key_prefix>/extracted.md` — for `/content`
- `readings/<key_prefix>/raw.{ext}` matching the manifest's `content_type` — for
  `/content/raw`

`/lookup` requires the by-url pointer and does not discover pointerless readings.
