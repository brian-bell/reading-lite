# Operating reading-lite

Deploying, ingesting in bulk, and repairing the corpus. `README.md` covers
first use; [architecture](architecture.md) and [API](api.md) hold the technical
references. This document is the operator runbook.

Operator workflows run through the unified plan-first CLI: `npm run ops --
<group> <command> [options]`. Every command with durable side effects prints a
plan by default and acts only with `--execute`.

### Operator Node

| Path | Supported Node | How Wrangler is launched |
| --- | --- | --- |
| `npm run ops` | Node **22** | `scripts/lib/wrangler-cli.ts` → `wrangler-dist/cli.js` |
| `npm run dev` (and types:generate / types:check) | Node **22.12+** | npm bin wrapper `bin/wrangler.js` |
| CI | Worker, app, and ops: Node **22** | Worker tests stay on workerd |

`npm run ops` runs on **Node 22**, the same floor as the rest of the repo.
Install with `npm ci`. Wrangler child processes go through
`scripts/lib/wrangler-cli.ts`, which execs
`node_modules/wrangler/wrangler-dist/cli.js` with the current Node.
`npm run dev` and `types:generate` use the npm bin wrapper (`bin/wrangler.js`)
and require Node 22.12+. The production Worker stays on workerd.

Root `package.json` `engines.node` (`>=22.0.0`) is the install and ops floor,
not a `npm run dev` guarantee. Local `npm run dev` is gated to Node 22.12+
via `predev`.

Every `corpus` command additionally requires `--tenant <selector>` before it
plans anything. There is no default. A missing or malformed selector is a
usage error (exit 2) before any database or R2 traffic, so an operator can
never act on the wrong corpus by omission.

A `usr_…` tenant id addresses that tenant's rows in PostgreSQL plus its
`u/{tenantId}/` R2 content root (the same scope the worker derives from a
validated `TenantContext`). Locally, `--local` keeps the same `usr_…` selector
for the rows but drops the `u/{tenantId}/` root on the bucket side, because
local dev leaves `TENANT_DATA_PLANE` unset and stores content at unprefixed
keys. `global` is the pre-tenant R2 layout selector: the leftover global
objects both deployed environments retain, production's pending signed-off
deletion, staging's kept by its own copy-only migration. It names no rows, so
every command that reads or writes PostgreSQL refuses it, and on a gate-on
environment realtime write paths reject it too (`verifyRealtimeTenant`,
`scripts/corpus-lib/realtime-tenant.ts`).

Production has been cut over (`TENANT_DATA_PLANE=1` pinned 2026-08-31). Live
production corpus commands use the founder tenant from a production bearer,
not `global`:

```sh
# Resolve $TENANT once. Copy this into production corpus commands; do not
# copy --tenant global onto the live founder corpus.
TOKEN=$(grep ^READER_API_TOKEN= .prd.vars | cut -d= -f2-)
curl -sS -A curl/8 -H "Authorization: Bearer $TOKEN" \
  https://readinglite.ai/api/whoami
# Record tenant_id as TENANT (usr_…). Expect tenant_data_plane true.
```

Then `--tenant "$TENANT"`.

## Account deletion

`DELETE /api/account` marks the account deleting and revokes its credentials.
The founder and staging fixtures follow the same path as every other tenant.
The request does not enqueue a wipe. Every 15 minutes, cron starts eligible
`ACCOUNT_WIPE_JOBS` work after the seven-day `deleting_at` grace period.
`{ force: true }` skips grace for a new wipe. Cron resumes unfinished or reopened
wipes during grace and preserves the record's force flag.

The wipe refuses an unset tenant gate or empty key root with `no_tenant_prefix`.
It never falls back to global R2 keys. A deleting user with no deletion timestamp logs
`account_wipe_missing_deleting_at`; investigate before repairing the timestamp
or forcing the wipe.

### Progress and phases

`wipe_progress` (PostgreSQL, [ADR 0005](decisions/0005-postgresql-storage.md))
holds the phase, the R2 object cursor, lease sequence, heartbeat, continuation
count, force flag, and completion. Writes compare and advance `lease_seq`; a
delivery that loses ownership reports `lease_held` and acks. The queue consumer
runs at concurrency 1. `updated_at` is advisory for cron, not proof that a job
has ended, even after a long delayed retry.

The phases run in order:

1. `rows` deletes every reading row the tenant owns. Revisions, URLs,
   relationships, attempts and embeddings go with them by cascade, so a reading
   leaves search as it leaves the list. It also deletes the tenant's
   `relationship_refresh_jobs` and `tension_refresh_jobs` checkpoints, which
   name readings but hold no foreign key to one and so cascade from nothing. A leftover checkpoint cannot
   spend — the refresh writes require an `active` users row — but removing the
   account's data is the wipe's job rather than teardown's. It deletes the
   tenant's `inbox_items` for the same reason: they name no reading, and
   teardown refuses while any remain. The deletes and the advance to `objects` are one
   transaction, with the lease compare-and-set last, so no tenant is recorded
   past `rows` while its rows stand and a lost lease rolls the deletes back. A
   database error fails the delivery before any object is deleted, and the
   queue retries it.
2. `objects` pages the tenant's R2 root, 1000 keys at a time, and ends by
   sweeping rows once more, for a publisher that passed its tenant check before
   the account was fenced and committed after the rows phase.
3. `done` writes the completion record — but only after counting the tenant's
   remaining `readings` and `inbox_items` and finding none. A non-zero count throws
   `AccountWipeRowsRemainingError` and the delivery retries: a completion is
   what teardown hard-deletes the account on, so it has to mean the rows are
   gone rather than that a DELETE reported a count.

Heartbeats are throttled to one minute. Cursor, phase, lease, continuation, and
completion updates persist whenever a later delivery needs them.
`ACCOUNT_WIPE_MAX_CONTINUATIONS` bounds self-sent continuation messages so a
stalled wipe cannot reset its retry budget forever. Exceeding that bound throws
and eventually reaches the wipe DLQ, which logs and acks without touching the
tenant. A finished wipe whose prefix gains objects again, or whose tenant has
reading rows or inbox items again, is reopened from `rows` with a fresh
continuation count.

Embeddings are rows, so there is no vector ledger, ledger seed, `deleteByIds`,
namespace probe or unbound-index gate on this path, and no operator command
keeps one: the ledger and the commands that maintained it were retired in
reading-lite-gh347.4.6 ([inventory](operator-tooling.md)). A PostgreSQL wipe
always completes with `residue=false`; the column keeps the history imported
from D1.

`completed_at` and `residue` describe current completion and clear on reopen.
`first_completed_at` and `first_residue` are written once and pinned in SQL.
Teardown gates on current completion; reports preserve first-completion history.
Completion clears the cursor and keeps the progress row until teardown.

### Control-plane teardown and email reuse

Cron runs `src/control-plane/account-teardown.ts` after wipe completion and an
empty-prefix check. A failure retries on the next tick. It copies the wipe's
residue flags to the audit record.

1. Write `account_deletions` first. It retains tenant ID, deletion/completion/
   teardown timestamps, and current/first residue flags. It has no foreign key,
   email, display name, or reading IDs. Its presence proves an attempt, not
   successful teardown.
2. Purge the tenant's TenantUsageGuard storage/alarm and its GlobalUsageGuard
   leases and spend records. Guard errors stop teardown before any row deletion.
   Incurred charges remain in the global daily aggregate. AuthRateGuard retains
   hashed TTL-windowed email/IP counters because it has no tenant key.
3. Resolve owned address history, then recheck the R2 prefix immediately before
   the final transaction. Only confirmed-empty permits it. Leftover objects
   reopen the wipe on a later tick; unknown/error observations leave teardown
   for retry.
4. In one transaction, lock this account's `auth_challenges` rows, then the
   `users` and `wipe_progress` rows, re-check that the account is still
   `deleting` and the wipe still complete, and count the tenant's `readings`
   and `inbox_items`. Any remaining row answers `rows_remain` and deletes
   nothing: neither table names a `users` row, so PostgreSQL would not refuse
   the delete, and once
   the users row is gone cron stops enumerating the tenant and those rows can
   never be found again. Only then delete child rows before parents: token
   scopes/tokens, sessions, challenges, digest deliveries, relationship refresh
   checkpoints, settings, limits, the `corpus_refresh_state` marker, eligible
   invites, wipe progress, then users.
   PostgreSQL enforces the foreign keys; none cascade.

An object arriving between the final prefix verdict and the commit can still be
orphaned after cron loses the users row it enumerates. The recheck narrows this
race; it does not close it. Keep that #261 limit in deletion reports. Reading
rows and inbox items are not exposed to it: the count in step 4 is taken after
the `users` lock, and the only paths that insert them (claim and inbox stage)
take the same row FOR SHARE alongside the insert, so each either commits before
the count or finds no active account.

The operator's `corpus_refresh_state` marker follows the same rule: its upsert
holds an active user's row `FOR SHARE` until commit. Teardown removes the
marker under its user-row lock, so a late refresh cannot recreate reading IDs
for an account that has been deleted.

The current address remains unavailable until the users row is gone. Under
`invite_only`, returning users need a fresh invite after teardown. Check directly:

```sql
SELECT 1 FROM users WHERE id = '<tenant>';   -- must return no row
```

Do not rely on the earlier audit row or a non-durable completion log. An invite
created for the current address while the account is still deleting will be
removed by teardown, even if unconsumed. After confirming absence, a new invite
uses the existing schema:

```sql
INSERT INTO signup_invites (email_canonical, email_display, created_at)
VALUES ('<canonical address>', '<display address>', now());
```

Teardown also frees proven prior addresses from redeemed or login challenges.
An unredeemed email-change request does not prove address ownership. It removes
consumed invites for proven addresses and any invite on the current address;
unconsumed invites on previously released addresses survive because they may
belong to a new recipient. A consumed marker on a released address can belong
to a later registrant, but removing that spent marker does not affect their
existing users row. Making attribution exact needs invite ownership in the schema.

Some signup-era, superseded challenges have no owner and cannot be attributed
after an address change. Sweeping them by a released address could remove
another person's challenge. Preserve this known retention limit in reports.
The [email-reuse drill](evidence/286-staging-email-reuse-2026-09-05.md) and
[second run](evidence/286-staging-email-reuse-followup-2026-09-05.md) record the
verified behavior; they did not exercise an invite inserted during deletion.

### Legacy data and bare vectors

The live corpus has no vector to orphan: an embedding is a `reading_embeddings`
row with a foreign key to `readings`, so the wipe's row deletes take it too.
The pre-cutover Vectorize indexes, with their bare-id vectors, were deleted on
2026-09-26 (reading-lite-gh351.6). Deleting the retained pre-tenant global R2
objects still needs separate sign-off under #285.

`account audit-bare-vectors` and its repair were retired in
reading-lite-gh347.4.6: a bare vector cannot exist in the PostgreSQL corpus,
and the D1 ledger it consulted is a table the PostgreSQL schema never creates
([inventory](operator-tooling.md#account)).

The [2026-09-05 production audit](evidence/195-production-audit-2026-09-05.md)
found no tenant bare-vector repair candidates and all 557 then-ready readings
had composed vectors. That is dated evidence about the since-deleted index. Accepted [staging evidence and limits](staging-evidence-contract.md)
do not require a new deletion drill for an unrelated release.

### Account residue scan (S5)

This command implements the local operator surface for [#195](https://github.com/brian-bell/reading-lite/issues/195)
and design [#263](https://github.com/brian-bell/reading-lite/issues/263).
The dated staging and production evidence linked below records the approved
operator work and its accepted limits.

```sh
npm run ops -- account residue-scan --tenant "$TENANT" --bucket reading-lite-staging
npm run ops -- account residue-scan --all-deleted --bucket reading-lite-staging
```

The scan prints JSON findings separately for tenant R2 and PostgreSQL rows.
The `pg.*` sources cover readings, embeddings, inbox items, corpus refresh state, relationship
refresh jobs, users, sessions, tokens/scopes, settings, limits, digests, wipe
progress, archive exports, challenges and attributable invites. Reading children cascade from
`readings`; embeddings also have their own observation. A failed source stays
`unknown` without hiding residue found by any other source.

`account_deletions` is expected retained audit evidence. Its `first_completed_at`
and `first_residue` describe history; a true historical residue flag is not a
measurement of today's storage. An audit row is written before teardown and
does not prove completion. Remaining corpus/control-plane rows report residue,
including during the normal interval before cron. Live tenant data naturally
reports as present. The scan is observation, not the runtime teardown gate.

Exit status is **1 for residue or incomplete visibility**, 2 for invalid usage,
and 0 only when all scanned sources are clear or expected. The residue-scan command
does not independently inspect TenantUsageGuard storage/alarms or GlobalUsageGuard
leases. The separate private `system status --details` command inspects quotas
and leases, but is not integrated into this scanner and does not certify alarm
absence. The scanner leaves those sources unknown, so it can report zero
observed data and still exit 1. Teardown's fail-closed DO purge is useful evidence, not a direct inspection.
AuthRateGuard's hashed windows are not attributable to one tenant. After address
history/token ownership is erased, released-address invites, NULL-owner
challenges and orphan token scopes cannot be fully attributed; S4's documented
spent-invite residual may be inert. Queues and concurrent work are not inspected.
These limitations must accompany any closeout report; do not relabel exit 1 as
an unconditional clean certification.

`ready_reading_embeddings` lists ready readings without embedding rows. This
is an `unknown` diagnostic, not deletion residue: inactive tenants or readings
that do not own their URL may deliberately have no embedding. `pg.readings`
and `pg.reading_embeddings` independently report actual row presence. The scan
neither infers damage nor repairs a reading. No frozen R2 list or manifest is
read.

An empty observable corpus can therefore report `residue:false` and still
report `incomplete:true` with exit 1. The storage port preserves that established
visibility contract; it does not manufacture a clean certification from missing
DO/address-history observations.

The forced wipe command queues the existing consumer, preserving its S1 fence
and S2 completion record:

```sh
npm run ops -- account wipe --tenant "$TENANT" --bucket reading-lite-staging --force
npm run ops -- account wipe --tenant "$TENANT" --bucket reading-lite-staging --force --execute --confirm "$TENANT" --queue-id "$WIPE_QUEUE_ID"
```

It accepts only a tenant already `deleting`. `--force` skips the seven-day start
grace only. The queue ID is checked against `reading-lite-staging-wipe` (or
`reading-lite-wipe` for production) before enqueue. It never marks an active
user deleting and never changes a progress row. Enqueue success is not wipe
completion; cron runs teardown after the consumer completes.

After deletion: scan once after the data-plane completion, then scan again after
cron teardown. Confirm that users/child/progress rows disappeared and that the
first-completion pair survived in `account_deletions`. Record DO/visibility
limitations separately. For production
preparation, use the same commands with `--bucket reading-lite`:

```sh
npm run ops -- account residue-scan --tenant "$TENANT" --bucket reading-lite
npm run ops -- account residue-scan --all-deleted --bucket reading-lite
```

The bucket selects the database through the operator pairing
(`PRODUCTION_DATABASE_URL` or `NEON_MAIN_DATABASE_URL` for `reading-lite`,
`STAGING_DATABASE_URL` or `NEON_REHEARSAL_DATABASE_URL` for staging; see
[step 0](#step-0-the-connection-strings)). R2 uses the existing
corpus credential resolver; queue REST uses `CORPUS_R2_ACCOUNT_ID`, then
`CLOUDFLARE_ACCOUNT_ID`, and `CORPUS_CF_API_TOKEN` or `CLOUDFLARE_API_TOKEN`.
Use production-scoped Cloudflare credentials supplied by the operator; the
checkout's `.corpus.vars` may be staging-scoped. The bucket fixes the queue
name; no override is accepted. Ensure all credentials
identify the same account/environment.

The separately executed
[2026-09-05 production read-only audit](evidence/195-production-audit-2026-09-05.md)
found no tenant bare-vector repair candidates and all 557 ready readings had
composed vectors. It records protected legacy pairs, the empty all-deleted
selection, the then-live ledger follow-up, and the scanner's certification limits.

## Environments

| Environment | Worker | Bucket / database | Notes |
|---|---|---|---|
| local | `reading-lite-dev` | Miniflare-emulated R2; local PostgreSQL through Hyperdrive's `localConnectionString` | no Queue |
| staging | `reading-lite-staging` | `reading-lite-staging`; Neon `rehearsal` branch through Hyperdrive | canonical `staging.readinglite.ai` (frontend `/*` under `/api/*` `/health` `/mcp*`); also `staging.readinglite.app`; `next-staging.readinglite.ai` and `reading-lite-staging.bbell.dev` retired |
| production | `reading-lite` | `reading-lite`; Neon `main` branch through Hyperdrive | canonical `readinglite.ai` (frontend `/*` under `/api/*` `/health` `/mcp*`); also `readinglite.app`; `next.readinglite.ai` and `reading-lite.bbell.dev` retired |

Environments do **not** inherit top-level `[vars]` or bindings, `wrangler.toml`
repeats them per environment. The distinct dev Worker name guards against an
accidental bare `wrangler deploy` clobbering production.

`TENANT_DATA_PLANE=1` prefixes hosted R2 keys as `u/{tenantId}/…`. Production
pins it in `[env.production.vars]` since the founder cutover (2026-08-31,
`docs/founder-cutover.md`); staging pins it too, so the destructive
account-wipe path can be rehearsed there ("Rehearsing account deletion on
staging"). Only local stays unset. Rows are tenant-scoped whatever the gate
says; the gate decides only the R2 content root and arms the account wipe
(off, the wipe refuses with `no_tenant_prefix`). Rolling it back after
tenant-rooted content has been written leaves those readings' rows pointing at
keys the Worker no longer resolves, so it needs a freeze and reverse
reconciliation of the content objects, or explicit acceptance of the loss. Workers-pool tests
turn it on so two tenants can share a URL without colliding. Operator corpus
scripts address whichever tenant their required `--tenant` selector names: the
tenant id from whoami for production and staging (gate on), the local
founder's id with `--local` (unprefixed keys, since local leaves the gate
unset). `global` names the retained pre-tenant R2 layout both deployed
environments still carry; every command that reads rows refuses it.

One caveat: `corpus recover`'s realtime path writes through the Reading API,
where the acting tenant is the **bearer token's** principal, not `--tenant`.
Before submitting, a realtime `--execute` therefore asks the worker who the
token is (authenticated `GET /api/whoami`, which also reports whether the
tenant data-plane gate is on) and fails closed on any mismatch: a `usr_…`
selector requires the gate on and the token's tenant equal to the selector;
`global` requires the gate off (with it on, every API write lands in the
token's tenant namespace, never the global layout). The verified layout is
then pinned onto every write via the `x-expected-tenant` header, which the
worker checks atomically per request, so a gate flip or rolling deploy
mid-run rejects later writes (412) instead of silently re-routing them. (The
pin protects only once every serving worker version enforces it: never flip
`TENANT_DATA_PLANE` in the same deploy that ships the pin, automatic under
the s1k.6 sequencing, where the flip comes well after.)
`--batch` is scoped by `--tenant` end to end and needs no verification.
(reading-lite-1xk)

### Storage resources

The final inventory after the storage migration (ADR 0005, closed by
reading-lite-gh351 on 2026-09-26). Reading state, embeddings and the control
plane are PostgreSQL; captured content is R2; nothing else stores data.

| Resource | Production | Staging | Notes |
|---|---|---|---|
| Neon project `reading-lite` (`little-cake-62522212`, aws-us-east-1) | branch `main` | branch `rehearsal` | Branch `dev` is kept for `ops db migrate` trials and is never a deploy target. Temporary branches (the 2026-09-24 `reconcile` import) are deleted once their check is recorded. Neon's free plan keeps 6 hours of history, so restores rely on `pg_dump` archives you take. |
| Hyperdrive, caching disabled | `reading-lite-production` (`4aebdf88…`) → `main` | `reading-lite-staging` (`42417083…`) → `rehearsal` | The ids are in `wrangler.toml`; `ops deploy worker` refuses a placeholder id. Migrations never go through Hyperdrive: they use the DIRECT strings in [step 0](#step-0-the-connection-strings). |
| R2 bucket | `reading-lite` | `reading-lite-staging` | Tenant content under `u/{tenantId}/`, plus `index/refresh-cursor.json`. The pre-tenant global `readings/` and `index/` objects are retained until a separate signed-off deletion (#285). |
| Queues | `reading-lite`, `-digest`, `-refresh`, `-export`, `-wipe`, each with a `-dlq` | the same names under `reading-lite-staging` | See `wrangler.toml`. |
| GitHub Actions | secret `PRODUCTION_DATABASE_URL` (DIRECT `main` string: deploy-time migrations and the wipe check), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | none | Staging deploys run by hand with `NEON_REHEARSAL_DATABASE_URL`. The repository variable `DISABLE_PR_CI` switches pull-request CI off; `gh workflow run ci.yml --ref <branch>` runs it by hand. |
| Operator credentials | `~/.config/reading-lite/neon.env` (mode `600`): `NEON_MAIN_DATABASE_URL`, `NEON_REHEARSAL_DATABASE_URL`, `NEON_DEV_DATABASE_URL` | same file | R2 credentials live in the gitignored `.corpus.vars`. |

Deleted on 2026-09-26 (reading-lite-gh351.6): the D1 databases
`reading-lite-control` and `reading-lite-control-staging`, the Vectorize
indexes `reading-lite` and `reading-lite-staging`, and the manifest-era R2
objects under every tenant root. The operator keeps these archives outside the
repository, in `~/rl-snapshots/`: the final D1 exports
(`d1-reading-lite-control{,-staging}-2026-09-26-final.sql`, checked against the
live row counts before deletion), the 2026-09-24 cutover export with its
post-import and pre-reopen `pg_dump`s, and a post-cutover `pg_dump` of `main`
(`production-2026-09-25-gh351.dump`), all verified restorable
(reading-lite-gh351.1).

### Secrets

Runtime Worker secrets (`wrangler secret put --env staging|production`):

| Secret | When |
|---|---|
| `AUTH_ROOT_SECRET` | always, 256-bit hex HKDF root for credential HMACs |
| `AUTH_PREVIOUS_ROOT_SECRET` | optional, previous root during a bounded rotation window |
| `PROVIDER_KEY_SECRET` | 256-bit hex HKDF root for tenant provider keys (AES-256-GCM). Unset until a tenant key is stored. Separate from `AUTH_ROOT_SECRET` |
| `PROVIDER_KEY_PREVIOUS_SECRET` | optional, previous provider-key root during a bounded rotation window |
| `OPENAI_API_KEY` | always, embeddings, and the default OpenAI summarizer |
| `ANTHROPIC_API_KEY` | only when `SUMMARIZER_PROVIDER=anthropic` |
| `X_API_BEARER_TOKEN` | only for `x.com` / `twitter.com` status URL imports |
| `RESEND_API_KEY` | required on staging/production, magic-link auth mail and per-reading notifications (recipient is `users.email_display`, never `EMAIL_TO`) |
| `TURNSTILE_SECRET_KEY` | required to send open-mode magic-link mail on staging/production. Cloudflare siteverify secret (**never** in `[vars]`). Local skip/fail-open when unset; staging/production fail-closed (missing secret, siteverify errors, or `success ≠ true` → no-send `{ok:true}`) |

Public widget key `TURNSTILE_SITE_KEY` is a `[vars]` value, not a secret.
`GET /api/auth/login-options` returns `{ turnstile_site_key }` only when
`signup_mode` is `open` and the key is configured; otherwise the field is
`null`. It never reports whether an email exists. Staging bootstrap stays
`invite_only` (`signupModeForEnv`); do not flip staging to open by default.

Checked-in summarizer effort vars in `wrangler.toml` (and the dotenv examples):
`OPENAI_SUMMARIZATION_REASONING_EFFORT` is `low` locally, `high` in staging
and `medium` in production. `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` is `low` locally
and `medium` in staging/production, and is applied only when
`SUMMARIZER_PROVIDER=anthropic`. Staging and production summarize, and run
weekly relationship-refresh judgements, with Anthropic; local uses OpenAI. Claude Sonnet
5.5 (`ANTHROPIC_MODEL=claude-sonnet-5-5`) accepts `low`, `medium`, or `high` on
`output_config.effort` with `thinking: { type: "between_tools" }`. `xhigh` and
`max` 400 with that setting. Invalid values, efforts the configured model
cannot take, and model/effort pairs that 400 with the thinking setting the
request sends (Fable 5, Mythos 5, and Mythos Preview with thinking disabled;
Opus 5 at `xhigh` or `max`; Sonnet 5.5 at `xhigh` or `max`) fail closed before
any source fetch or upstream spend.

Optional version vars (`AUTH_ROOT_KEY_VERSION`, `AUTH_PREVIOUS_ROOT_KEY_VERSION`)
default to `1`. HKDF includes the version, so a secret-only rotation must keep
the previous root on the same version the tokens were minted with (the default).
Bump both version vars explicitly when advancing the key generation.
`PROVIDER_KEY_VERSION` and `PROVIDER_KEY_PREVIOUS_VERSION` default to `1`.
HKDF info for tenant provider keys includes that version, and each stored key
records the version that sealed it. Rotate them as
[provider key rotation](#provider-key-rotation) describes.

#### Provider key rotation

Tenant provider keys are sealed under `PROVIDER_KEY_SECRET` (ADR 0004). A
rotation moves every stored key onto a new secret without readers noticing:

1. Generate the new secret (`openssl rand -hex 32`) and keep the old one and
   its version (default `1`).
2. On the Worker, with `wrangler secret put … --env <env>`: set
   `PROVIDER_KEY_PREVIOUS_SECRET` and `PROVIDER_KEY_PREVIOUS_VERSION` to the old
   pair, and `PROVIDER_KEY_SECRET` and `PROVIDER_KEY_VERSION` to the new secret
   and the old version plus one. The Worker now seals new connects under the new
   version and still opens rows sealed under the old one.
3. Replace your own key in settings (the same key is fine). The Worker seals it
   under the new version, and that row is the command's proof that your local
   secret matches the Worker's.
4. Put the same four values in `.stg.vars` / `.prd.vars` (or the environment)
   and reseal the stored rows:

   ```sh
   npm run ops -- provider-keys reencrypt --env production                    # plan: counts per key_version
   npm run ops -- provider-keys reencrypt --env production --execute --confirm-production
   ```

   Plan mode trial-decrypts every row and changes nothing. `--execute` refuses
   to write unless a row is already on the new version and every such row opens
   under the supplied `PROVIDER_KEY_SECRET`. Without that proof, a mistyped
   local secret would reseal every key under a secret the Worker lacks. It then
   reseals one row per transaction under its row lock and exits 0 only when
   every row is on the new version. Credential versions, status, and
   `updated_at` do not change. Rerunning is safe.
5. Once it exits 0, delete `PROVIDER_KEY_PREVIOUS_SECRET` and
   `PROVIDER_KEY_PREVIOUS_VERSION` from the Worker and the local vars file.

The versions must differ: a row records only its version, so equal versions
give the command nothing to tell rows apart by, and it refuses them.

**Recovery.** A row neither secret opens is listed by tenant and left in place;
`--execute` then exits 1. Losing the secret that sealed a row makes that key
unrecoverable. Dispatch fails the reader's attempts with
`provider_key_undecryptable` until they connect their key again in settings,
which replaces the row under the current secret. Readings, content, and
embeddings are unaffected. If the previous secret was removed from the Worker
too early, restore it with its version and rerun step 4.

`founder-bootstrap` cannot read Wrangler secrets. Put the **same**
`AUTH_ROOT_SECRET` plus `READER_API_TOKEN` (and `FOUNDER_EMAIL` unless you pass
`--email`) in `.stg.vars` / `.prd.vars` or the process environment. A local
root that differs from the Worker secret produces HMACs the Worker cannot
verify. After import, `READER_API_TOKEN` is not a runtime Worker fallback;
keep it in the dotenv for operator CLIs that still POST that bearer.

`POST /api/readings` requests notification by default (`email: true`). Send-time
`to` is the current verified `users.email_display`, `EMAIL_TO` is never a
fallback. Import is always silent even if the body or `--email` is true.
`notify_immediate=0`, `email: false`, a missing settings row, an inactive or
unverified user, an empty `EMAIL_FROM`, or a staging `AUTH_MAIL_ALLOWLIST` miss
all skip send (no `send_email` event). Resend failures still log a failed
`send_email` event with recipients redacted; the reading stays `ready` and the
job is not requeued.

Scheduled digests also go through Resend to the current verified
`email_display`, never `EMAIL_TO`, independent of `notify_immediate`, and
never `LOCAL_MAIL_SINK`. An empty window skips without mail and closes the
period in `digest_deliveries`. Resend 429 retries the digest job and leaves
the ledger `pending`. Fan-out re-enqueues leftover pending only after 15
minutes (`DIGEST_PENDING_STALE_MS`, one cron interval). Digest Resend POSTs
set `Idempotency-Key` to `userId:cadence:period_key`.

The offline corpus tools bypass the Worker. For R2 they authenticate directly
against Cloudflare, reading `CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`,
`CORPUS_R2_SECRET_KEY`, and `CORPUS_CF_API_TOKEN` from the environment or
`.corpus.vars`; for reading state they open a direct PostgreSQL connection
chosen by the bucket's [operator pairing](#step-0-the-connection-strings).

### Deploying

Bring the control plane up before deploying a Worker that authenticates
against it. `ops deploy worker` does not create the database or import the
founder token, but it does deploy schema: `--execute` applies the pending
PostgreSQL migrations in `db/migrations/` and then uploads.

Migrations are the last gate before the upload, after the Hyperdrive binding check and
the tenant-activation preflight, and they are fail-closed. Drift or a failing
file exits 1 with nothing uploaded, so a release whose code expects a new
column cannot reach a database that lacks it.

A plan lists the pending files and applies none. It still exits 1 on drift,
after running the build dry-run: the history was read and is not something to
act on, and the dry-run passing does not make the deploy safe. The one
tolerated failure is an unreachable database — the history simply went unread,
which is a gap in the plan rather than evidence against it, so the plan warns,
dry-runs and exits 0.

#### Step 0: the connection strings

`--database-url-env` is **required**. It names the environment variable holding
the target database's DIRECT connection string — never a Hyperdrive string,
because the migration runner's advisory lock is session state. The name is
checked against `--env` before anything remote happens, so a production deploy
cannot migrate staging:

| `--env` | Accepted `--database-url-env` |
|---|---|
| `production` | `PRODUCTION_DATABASE_URL`, `NEON_MAIN_DATABASE_URL` |
| `staging` | `STAGING_DATABASE_URL`, `NEON_REHEARSAL_DATABASE_URL` |

Anything else is refused, including bare `DATABASE_URL` and
`NEON_DEV_DATABASE_URL`: neither names a deploy target.

Operators keep the Neon strings in `~/.config/reading-lite/neon.env`, mode
`600`, outside the repository and never committed. It holds exactly three
variables:

| Variable | Neon branch |
|---|---|
| `NEON_MAIN_DATABASE_URL` | `main` — production. |
| `NEON_REHEARSAL_DATABASE_URL` | `rehearsal` — staging's database, first migrated for the #349 cutover rehearsal. |
| `NEON_DEV_DATABASE_URL` | `dev` — never a deploy target; `ops db migrate` takes it. |

Source it per command rather than exporting it from a shell profile, so the
string is never in ordinary shell history or the process list:

```sh
set -a; . ~/.config/reading-lite/neon.env; set +a
npm run ops -- deploy worker --env production --execute \
  --database-url-env NEON_MAIN_DATABASE_URL
```

`PRODUCTION_DATABASE_URL` and `STAGING_DATABASE_URL` are the **Actions** names:
the deploy workflow supplies the first from a repository secret. Nothing sets
them on a laptop, so the examples below that use them are the CI spelling. When
running the same commands by hand, pass the `NEON_*` name for that environment
instead — except `ops deploy release`, which hardcodes
`PRODUCTION_DATABASE_URL` for both its wipe check and its deploy, so an
operator running it exports that one:

```sh
set -a; . ~/.config/reading-lite/neon.env; set +a
export PRODUCTION_DATABASE_URL="$NEON_MAIN_DATABASE_URL"
```

Migrations commit before the upload, and `db/migrations/` is forward-only with
no down migration. A failure *after* the migrations — most realistically the
route-publish failure documented under "Captain-only DNS / Pages / token" —
therefore leaves the new schema live under the old Worker. Keep each migration
compatible with the release it replaces (add columns and tables; do not drop,
rename or tighten one the previous Worker still reads) so that window is safe.

#### Tenant-mode activation guard

Before the upload, `ops deploy worker --execute` inspects the target
environment's tenant-mode activation state. A single active version serving
100% of traffic with `TENANT_DATA_PLANE=1` and a matching `READINGS_BUCKET`
binding establishes the baseline for an ordinary redeployment. The R2 bucket
must also have a creation timestamp no later than that version, so recreating
it under its old name requires fresh verification. No other binding is
compared. Existing production and staging cutovers use this baseline; no new
migration or certification record is needed.

Off→on activation, changed resources, split deployments, missing deployment
state, and failed/incomplete API reads refuse execution with exit 2. When
activation is unverified, the preflight says so and sends you to the target
PostgreSQL control plane for deletion eligibility: it holds only Cloudflare API
credentials, so it does not read tenant rows itself. This is an activation
warning; ongoing active-wipe deployment policy belongs to #269.

To proceed after a refusal, verify the intended corpus in the target
PostgreSQL database and tenant R2 content root, and review deletion eligibility in the target
PostgreSQL control plane (tenants in `status='deleting'` whose `deleting_at` is
at or past the seven-day grace window). For a rebuilt environment, verify its restored tenant corpus before
activation. The completed founder cutover is historical evidence, not a step to
repeat: its one-time migration command is retired. Any future conversion from a
legacy layout requires a separately scoped migration and rehearsal.
An intentionally empty new environment needs verification that no corpus is
expected. Record the evidence with the operational work, then explicitly use:

```sh
npm run ops -- deploy worker --env staging --execute \
  --database-url-env NEON_REHEARSAL_DATABASE_URL --acknowledge-tenant-migration
```

Use `--env production` for a reviewed production activation. The acknowledgement
applies to this invocation only and is logged; it also acknowledges any deletion
eligibility that had to be checked manually. Do not add it to routine CI commands.
After successful activation the active version becomes the redeployment baseline.

The preflight uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI, or
Wrangler's current authentication locally. If account selection is ambiguous,
set `CLOUDFLARE_ACCOUNT_ID`. Credentials need Workers deployment/version read
access and R2 bucket metadata read access. A permission failure requires correcting access
or manually verifying readiness before using the explicit acknowledgement.
Plan mode prints the check it would perform and runs the existing build dry-run;
it does not inspect remote readiness or require these read permissions.

This guard does not scan or certify corpus contents. Retained global R2 objects
are allowed, and ordinary tenant writes/deletions need
not match the historical global snapshot. Direct Wrangler/API deployments can
bypass the guard; resource or data changes outside the deployment path are not
audited. Creation timestamps detect recreation since the active version, not
in-place data loss or a rebuild already followed by an out-of-band deployment.
The check is not a lock against concurrent administrative changes. Follow the
cutover runbook for those operations; never treat this preflight as a corpus
integrity audit or authorization to remove legacy data.

Staging:

```sh
cp .stg.vars.example .stg.vars   # AUTH_ROOT_SECRET, READER_API_TOKEN, FOUNDER_EMAIL, …
wrangler secret put AUTH_ROOT_SECRET --env staging   # same hex as .stg.vars
# After `set -a; . ~/.config/reading-lite/neon.env; set +a` (step 0).
npm run ops -- db migrate --database-url-env NEON_REHEARSAL_DATABASE_URL --execute
npm run ops -- founder bootstrap --email founder@example.com --env staging --execute
npm run ops -- deploy worker --env staging --execute \
  --database-url-env NEON_REHEARSAL_DATABASE_URL
```

Then run the **Deploy staging frontend** workflow by manual dispatch from the
same ref (see [New-frontend hosts](#new-frontend-hosts)).

Production is the same sequence with `NEON_MAIN_DATABASE_URL`, `--env production`,
`.prd.vars`, and:

```sh
npm run ops -- founder bootstrap --email founder@example.com --env production \
  --execute --confirm-production
npm run ops -- deploy worker --env production --execute \
  --database-url-env NEON_MAIN_DATABASE_URL
```

Pull request CI can be switched off with the `DISABLE_PR_CI` repository
variable (`true` skips every PR job; `main` always runs). While it is off, run
the full suite for a branch by hand with `gh workflow run ci.yml --ref <branch>`:
the check runs land on the branch head and show on its PR, and a dispatched run
never deploys, because `deploy-worker.yml` releases only a successful `push`
run on `main`.

Code merges to `main` start one coordinated production chain. Root Markdown,
`docs/`, and the other non-code paths listed in CI skip runtime checks and
production deployment; documentation-only PRs still run path classification. After `.github/workflows/ci.yml`
succeeds, `.github/workflows/deploy-worker.yml` checks out that exact CI commit
and runs `ops deploy worker --env production --execute --database-url-env
PRODUCTION_DATABASE_URL`, which applies the pending PostgreSQL migrations and
then uploads. It does not pass `--var`. `TENANT_DATA_PLANE` is
pinned in `[env.production.vars]`, so this path keeps the gate on; only removing
the pin rolls it off (see `docs/founder-cutover.md`).

After the Worker release succeeds, it publishes the released commit SHA for
`.github/workflows/deploy-app.yml`. The frontend workflow validates and checks
out that SHA, then builds and deploys `app/` (see
[New-frontend hosts](#new-frontend-hosts)). Both release stages refuse to deploy
if `main` has advanced at the deployment boundary, and one shared
non-cancelling lock serializes Worker and frontend production commands. An older run therefore cannot
overwrite a newer production release. Neither release workflow has a manual
trigger that can bypass the chain.

Before the upload, the Worker workflow runs `ops deploy wipe-check` after its
stale-release check, while holding the production release lock. It requires
zero unfinished records in the PostgreSQL control plane
(`wipe_progress.completed_at IS NULL`) and zero backlog in both
`reading-lite-wipe` and `reading-lite-wipe-dlq`. The record count is read over
a direct connection string — the workflow passes
`--database-url-env PRODUCTION_DATABASE_URL` — inside a read-only transaction;
the backlogs still come from the Cloudflare API. Stale unfinished records also
block: cron can resume them. Completed records and `users.status = 'deleting'`
alone do not block. A missing connection string, failed API calls, missing
queues, missing schema, or invalid responses fail closed and prevent the Worker
release artifact from being published, so the frontend cannot follow that release.
The command can also be run locally with the two Cloudflare environment
variables below plus `DATABASE_URL` (or `--database-url-env`); direct
`ops deploy worker` invocations do not automatically run this workflow gate.

For an explicitly selected token-revocation release check, use `ops staging
token-revocation` and `ops deploy release`; see the [operator evidence
workflow](staging-evidence-contract.md#explicit-token-revocation-gate). The wrapper
validates the retained drill before invoking the production wipe check and
existing Worker deploy. It does not change the automatic CI/frontend chain or gate
ordinary `deploy worker` calls.

The queue check uses the [Queues REST metrics endpoint](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/)
(`backlog_count`, unacknowledged messages), not aggregated analytics. Cloudflare
calls these metrics best-effort. The check is a snapshot: the release lock
serializes deploys but does not stop cron, new wipes, or teardown. A wipe can
start after the check. This is a rollout speed
bump, not an atomic drain/maintenance lock.

If blocked, let the wipe and queues drain, then rerun the failed Worker workflow.
For a reviewed exception, set the GitHub **repository Actions variable**
`DEPLOY_WIPE_OVERRIDE_SHA` to the exact 40-character lowercase commit SHA from
the blocked release, then rerun that workflow. Record the reason in the incident
or issue before overriding. The override skips the wipe reads, including read
failures, and emits a visible warning in the Actions log. It does not bypass CI,
the stale-main check, or the shared release lock. Remove the variable after the
release; even if left set, it cannot bypass the gate for a different commit.
Do not use a generic `true` value. No manual workflow trigger is needed, so the
successful Worker rerun still triggers the existing frontend release chain.

The gate requires Queues Read/Write or Workers Scripts Read/Write on the
production account, plus a PostgreSQL role that can read `wipe_progress`. The
documented deploy token's Workers Scripts Edit should cover the queue APIs, but
its actual scopes must be verified by a successful check; HTTP 401/403 is a
blocked release, never an empty-state result. See
[queue permissions](https://developers.cloudflare.com/api/resources/queues/methods/list/).

GitHub repository secrets (or the `production` environment):

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Non-interactive Wrangler. The Worker workflow needs Workers Scripts Edit and zone Workers Routes on **bbell.dev**, **readinglite.ai**, and **readinglite.app** so the route updates succeed (see "readinglite.ai / readinglite.app dual-serve" below). Scope the token to this account and those zones. |
| `CLOUDFLARE_ACCOUNT_ID` | Account Wrangler deploys into. |
| `PRODUCTION_DATABASE_URL` | Direct PostgreSQL connection string for the production database. The wipe gate reads `wipe_progress` through it and `ops deploy worker` applies the pending migrations through it, so the role behind it needs DDL as well as that read. The workflow fails fast with a named error when it is missing. |

The imported founder token expires after 90 days; re-running the same
bootstrap command refreshes `expires_at` and clears a revoked row.

When a release adds an API scope, a `db/migrations/` file widens the
`api_token_scopes` check, and existing tokens do not pick the scope up on their
own: apply the migration (`ops db migrate --execute`, or the Worker deploy's
own migration step), then re-run the same founder bootstrap command — its
scope grants are idempotent and top up the existing token.

`ops deploy worker` targets only staging and production (`--env`), so a dev
Worker can never be uploaded by mistake.

Local `npm run dev` runs `dev:setup` first: it starts the compose Postgres
service, applies the migrations, then bootstraps the founder's
`dev-local-token` into it, since the control plane is PostgreSQL (ADR 0005).
See [local Postgres](#local-postgres).

Backend Worker routes are scoped to `/api/*`, `/health`, and `/mcp*`; the
`app/` frontend Worker's `host/*` route handles every other path on the
staging and production hosts (see [New-frontend hosts](#new-frontend-hosts)).
Staging canonical host is `https://staging.readinglite.ai`;
`https://staging.readinglite.app` also serves. Production canonical host
is `https://readinglite.ai`; `https://readinglite.app` also serves the
application (see "readinglite.ai / readinglite.app dual-serve" below). Both
`bbell.dev` hosts are retired (S9). Magic-link mail prefers the recognized
public host the sign-in request arrived on, and falls back to `WEB_BASE_URL`
(`https://staging.readinglite.ai/` on staging, `https://readinglite.ai/` on
production). Digest mail, reading-notification mail, and MCP `public_url`
follow `WEB_BASE_URL`. Browser sessions are host-scoped (`__Host-` cookie);
bearer tokens are host-independent.

### readinglite.ai / readinglite.app dual-serve

Canonical production host is `https://readinglite.ai`. `https://readinglite.app`
is an additional public host. Staging is the same shape on
`https://staging.readinglite.ai` and `https://staging.readinglite.app`. Both
`bbell.dev` hosts are retired (S9 on
[#265](https://github.com/brian-bell/reading-lite/issues/265)).

`[env.production.routes]` in `wrangler.toml` carries the same `/api/*`,
`/health`, `/mcp*` trio on both public hostnames (`zone_name` is
`readinglite.ai` and `readinglite.app`). Both hit the same Worker
script, R2 bucket and PostgreSQL database (through Hyperdrive). Staging's six routes
do the same on `staging.readinglite.ai` and `staging.readinglite.app`.
Nothing in the data plane depends on the hostname, so the `/api/*` read and
write paths and `/health` are interchangeable between the hosts in one
environment. `/mcp*` is too, `mcpOriginGuard` 403s any `Origin` outside
`MCP_ALLOWED_ORIGINS`. The **code default** (`DEFAULT_MCP_ALLOWED_ORIGINS` in
`src/mcp/origin.ts`, used when the var is empty) is the two production public
origins. Production `[env.production.vars] MCP_ALLOWED_ORIGINS` is the same
two; staging sets its two public origins (and the `/api/mcp` alias sits
behind the same guard). Non-browser clients send no `Origin` and work on any
of them regardless.

Emitted links are the one place a host is *chosen* rather than observed.
`WEB_BASE_URL` is `https://readinglite.ai/` in production and
`https://staging.readinglite.ai/` in staging, so every queue-side link, digest
mail, reading notification mail, MCP `public_url`, points at the canonical
host. Magic-link mail is the exception: `publicWebBase` prefers the origin the
sign-in request actually arrived on when that origin is a known public host, so
a login started on `readinglite.ai` or `readinglite.app` (or the matching
staging pair) is still mailed back to that host, and only an unrecognised
or spoofed `Host` — including a retired `bbell.dev` name — falls through to
`WEB_BASE_URL`. `EMAIL_FROM` is
`Reading Lite <noreply@readinglite.app>` in production and
`RL Staging <noreply@staging.readinglite.app>` in staging (S8). Display name
lives in the same var. The sending domain is `.app`; emitted links stay on
`.ai`. Rollback for the sender is reverting `EMAIL_FROM` to
`reading-lite@bbell.dev` and deploying.

Browser sessions are host-scoped, the session cookie is `__Host-`-prefixed and
so carries no `Domain` attribute, so signing in on one host does not sign you
in on another. A one-time re-login on a public host is expected and intended,
not a bug. Bearer tokens are host-independent. Reverting `WEB_BASE_URL` does
not restore a retired `bbell.dev` host; that needs the Worker routes, Pages
custom domain, and DNS put back, then a Worker deploy.

`www.readinglite.ai` and `www.readinglite.app` are **not** Worker routes, and
must not become one. `www` → apex belongs to a Cloudflare Redirect Rule (301),
which fires before a request ever reaches the Worker. Nothing in this repo
configures the `www` records or redirect rules.

Staging follows the same dual-serve shape on its own pair:
`staging.readinglite.ai` (canonical `WEB_BASE_URL`) and
`staging.readinglite.app`. Bind those two hostnames as Pages custom domains on
project `reading-lite` to the **`staging` preview branch**, not `main`, then
deploy the Worker so the routes attach. Sessions stay host-scoped; `EMAIL_FROM`
is `RL Staging <noreply@staging.readinglite.app>` (S8).

#### Verified deployment state vs configuration intent

Repo configuration (S1–S4 in `wrangler.toml` and code) is not the same as live
DNS, Pages custom-domain binds, token scope, edge redirects, or MCP client
registrations. Verify those settings against the recorded deployment evidence before
changing domains or credentials.

Recorded on [#265](https://github.com/brian-bell/reading-lite/issues/265) after
S4 ([#276](https://github.com/brian-bell/reading-lite/pull/276), squash-merged
as `3633e5b8` on 2026-09-05): production CI plus Deploy production worker and
Deploy production SPA succeeded on that commit; unauth dual-serve smoke
confirmed `/health` → `ok` and MCP Origin allowlist behavior on all three
hosts; Pages SPA shells on `readinglite.ai` and `readinglite.app` matched
`reading-lite.bbell.dev`. That is the evidence this runbook cites. It is not
evidence this docs sweep re-ran those checks.

Still **not** claimed here:

- Optional `www` → apex DNS and Redirect Rules (not in this repo).
- Authenticated `/api/whoami` parity and emitted digest/notification URL
  checks.
- **S9** captain deletion of the live old-host Worker routes, Pages custom
  domains, and DNS after the Worker deploys that publish this config. C4
  (SPA redirect / noindex) was cancelled; this is a clean break.

#### Captain-only DNS / Pages / token (re-verify if zones or tokens change)

This repo publishes Worker routes and origin allowlists. It does **not** flip
live DNS, bind Pages custom domains, or re-scope the Cloudflare API token.
Those steps stay captain-only. Live serving after #276 implies they were
satisfied for the 2026-09-05 cutover; re-check them only if tokens or zones
change. The failure modes below still apply to a future deploy that adds or
removes routes.

1. **Zones on this account.** Confirm the `readinglite.ai` and
   `readinglite.app` zones exist under the same Cloudflare account as
   `CLOUDFLARE_ACCOUNT_ID`. A zone registered under a different account fails
   the same way as a missing zone grant.
2. **Token scope.** `CLOUDFLARE_API_TOKEN` (GitHub secret and any local ops
   token) must include zone Workers Routes on **both** `readinglite.ai` and
   `readinglite.app`, keeping `bbell.dev`. **Until it does, `ops deploy worker
   --env production` applies the pending PostgreSQL migrations, uploads the script, and
   then fails on the route publish**, the same route-publication failure described under "MCP
   connector" below, now on two additional zones. It surfaces two ways
   depending on what the token holds: with Zone Read but no Workers Routes
   edit, authentication error 10000 on `/zones/.../workers/routes`; with no
   grant on the zone at all (the likely state for a newly added zone) the zone
   lookup returns nothing and wrangler fails with `Could not find zone for
   readinglite.ai` (or `readinglite.app`). That lookup is filtered by
   `CLOUDFLARE_ACCOUNT_ID`, so a zone registered under a *different* Cloudflare
   account fails with the same message even on a correctly scoped token, check
   the account before chasing scopes. A third variant has nothing to do with
   the token: if one of these patterns is already bound to a different Worker
   in that zone, the publish fails with `Can't deploy routes that are assigned
   to another worker`. Mind what any of them leaves behind: the migrations and
   the new Worker script **have** landed and are live on the existing
   public-host routes; only the route addition fails. And because
   `deploy-worker.yml` then exits non-zero, `deploy-app.yml`, which runs only
   on a successful Worker run, never deploys, so production Worker code sits
   ahead of the production frontend until someone notices. Recovering by re-running
   the failed workflow works only while `main` is still at that commit: both
   deploy workflows re-check `origin/main` against the run's `head_sha` and
   refuse a stale release, so once another merge lands, let the newer commit's
   chain deploy instead. Note the same token scoping bites at retirement, in
   the other direction: on a zone-scoped token wrangler uses the per-zone route
   API, which only adds routes and never deletes stale ones, so **removing the
   `bbell.dev` routes from this file will not remove them from Cloudflare**.
   Delete them in the dashboard as part of S9 (see below).
3. **Pages custom domains.** Bind `readinglite.ai` and `readinglite.app` as
   Pages custom domains on project `reading-lite`, to the `main` branch, with
   Active certificates. Bind `staging.readinglite.ai` and
   `staging.readinglite.app` to the **`staging` preview branch** of the same
   project. This is an ordering prerequisite, not a cosmetic one:
   a Worker route only receives traffic for a hostname that has a proxied DNS
   record in the zone, and the Pages custom-domain binding is what creates that
   record at the apex. Without a proxied record the routes are simply inert
   and the new host serves neither SPA nor API. Note the flip side: if an apex
   is ever proxied to something else first (a parked page, another site or
   Worker), these routes take `/api/*`, `/health` and `/mcp*` on that hostname
   from the next production deploy, before any deliberate cutover. Check each
   apex before deploying if that may have changed.
4. **`www` → apex (optional).** `www.readinglite.ai` and `www.readinglite.app`
   each need a proxied record plus a `www` → apex Redirect Rule if `www` is to
   resolve at all. Nothing in this repo configures either, and no Worker route
   should: the 301 is meant to happen ahead of the Worker.

#### Migration status

Issue [#265](https://github.com/brian-bell/reading-lite/issues/265) tracks the
move.

In the repo (code, `wrangler.toml`, and current-facing docs):

- **S1**, production Worker routes for `readinglite.ai` and `readinglite.app`
  (`[env.production.routes]`).
- **S2**, `MCP_ALLOWED_ORIGINS` and `PUBLIC_WEB_ORIGINS` accept those two
  hosts. The code default when the var is empty is the same two.
- **S3**, magic-link mail prefers the request's own public host.
- **S4**, cutover: `WEB_BASE_URL` is `https://readinglite.ai/`.
- **S5**, operator script and skill defaults use `https://readinglite.ai`
  (`DEFAULT_API_BASE`; #300 / [#311](https://github.com/brian-bell/reading-lite/pull/311)).
- **S6**, current-facing docs and OpenAPI present `readinglite.ai` as
  canonical (#301).
- **S7**, staging Worker routes and origins for `staging.readinglite.ai` and
  `staging.readinglite.app`.
- **S8**, transactional sender: production
  `Reading Lite <noreply@readinglite.app>`, staging
  `RL Staging <noreply@staging.readinglite.app>`.
- **S9**, repo config retires both `bbell.dev` hosts. Live route, Pages, and
  DNS deletion is captain-only after the Worker deploys (see below).

Recorded live on #265 (2026-09-05), not re-verified by this docs sweep: C0
zone confirmation, C1 token scope, C2 Pages/DNS, S1 routes, S2 MCP origins,
S4 canonical `WEB_BASE_URL`. C3, C4 (cancelled), S3, S5–S8 are recorded on
the issue.

Host-behavior checks (code-level):

1. `GET /api/whoami` returns the same `tenant_id` on the hosts that actually
   serve, the data plane does not branch on hostname and must not start to.
2. A sign-in request resolves its base to the host it arrived on: from
   `readinglite.ai` the mailed link is `https://readinglite.ai/auth/verify#…`,
   from `readinglite.app` it is that host's own `/auth/verify`
   (`publicWebBase`, `src/control-plane/magic-link-mail.ts`). A retired
   `bbell.dev` Host falls through to `WEB_BASE_URL`.

#### S9 clean-break retirement (captain)

Do not add a Redirect Rule or `noindex` header. The old hosts should stop
resolving, not bounce to the public hosts. Land the repo change and deploy
**both** Workers first. Deleting live routes while `wrangler.toml` still
lists them means the next deploy republishes them.

1. Inventory live Worker routes on `bbell.dev` and any leftover
   `bbookmarks.com` routes.
2. Delete the three `reading-lite.bbell.dev` Worker routes and the three
   `reading-lite-staging.bbell.dev` Worker routes (`/api/*`, `/health`,
   `/mcp*` each).
3. Unbind Pages custom domains on project `reading-lite`:
   `reading-lite.bbell.dev` from `main`, and `reading-lite-staging.bbell.dev`
   from the `staging` preview.
4. Delete leftover `reading-lite` and `reading-lite-staging` DNS records on
   `bbell.dev` if Pages left them.
5. Delete leftover `bbookmarks.com` Worker routes if any remain.
6. Smoke: both old hosts return NXDOMAIN or Cloudflare's default error — not
   SPA HTML, not `/health` → `ok`. `readinglite.ai`, `readinglite.app`,
   `staging.readinglite.ai`, and `staging.readinglite.app` still serve SPA,
   `/health` → `ok`, `/api/whoami` → 401, and MCP Origin allowlist (foreign
   Origin 403).

Rollback for a retired host is restore routes + Pages domain + DNS, then
redeploy that Worker. Reverting `WEB_BASE_URL` is not enough.

#### Intentional old-host references

A search of the repo after this sweep found **no** remaining `bbookmarks.com`
references (that abandoned target was replaced in #276). Remaining
`reading-lite.bbell.dev` and `reading-lite-staging.bbell.dev` mentions are
intentional:

- Historical evidence: `docs/founder-cutover.md` (2026-08-31 tenant cutover
  when production served only this host).
- Original ADR wording in `docs/decisions/0001-tenant-control-plane.md`
  (annotated, not rewritten).
- Local/dev `wrangler.toml` `[vars] MCP_ALLOWED_ORIGINS`, fixtures, and tests
  that use a retired hostname as an example URL rather than a live host.
- This dual-serve runbook's S9 captain checklist.

### New-frontend hosts

The TanStack Start frontend in `app/` ([ADR 0003](decisions/0003-frontend-worker-topology.md))
owns `host/*` on these hosts. The
backend of the same environment keeps the more specific `/api/*`, `/health`,
and (on the public hosts) `/mcp*` routes from `wrangler.toml`, and the frontend
answers backend paths with 404 instead of proxying them.

| Worker | Hosts |
| --- | --- |
| `reading-lite-app` (production) | `readinglite.ai`, `readinglite.app` (apex cutover, reading-lite-gh340.4, 2026-09-19) |
| `reading-lite-app-staging` | `staging.readinglite.ai`, `staging.readinglite.app` (staging switch, #339, 2026-09-16) |

A Worker route only receives traffic for a hostname with a proxied DNS record.
On these four hosts that record is a proxied `AAAA 100::` placeholder, which
replaced the CNAME the legacy Pages custom domain had created (see
[Retiring the Pages SPA](#retiring-the-pages-spa)). Deleting it takes the host
off the frontend and the backend alike.

On any new host, the backend routes and `PUBLIC_WEB_ORIGINS` entry must be
live before the frontend route, or `/api/*` there reaches the frontend and
returns 404.

**Retired preview hosts.** `next.readinglite.ai` (production) and
`next-staging.readinglite.ai` (staging) served the frontend from Phase 3 until
the apex cutover. reading-lite-gh335.2 removed their routes, allowlist entries,
and smoke checks from the repository. Any magic link requested on either name
now points at `WEB_BASE_URL`. That is harmless for a login, but an email change
started there cannot be confirmed, because the preview host's session cookie
does not reach the base host; start it again on the base host. The deploy token
is zone-scoped, so Wrangler uses the per-zone route API, which never deletes
routes. Finish the retirement in the dashboard, after the production release of
that commit and a staging backend deploy plus **Deploy staging frontend**
dispatch from it. If a deploy did remove a route, because the token gained
account-level route permission, skip that deletion:

1. Delete the `next.readinglite.ai/*` route from `reading-lite-app` and the
   `next-staging.readinglite.ai/*` route from `reading-lite-app-staging`.
2. Delete the `/api/*` and `/health` routes for `next.readinglite.ai` from
   `reading-lite` and for `next-staging.readinglite.ai` from
   `reading-lite-staging`.
3. Delete the proxied `next` and `next-staging` DNS records (`AAAA 100::`) on
   the `readinglite.ai` zone.
4. Smoke: both preview hosts stop resolving, and `app/scripts/smoke-host.sh`
   still passes on `readinglite.ai`, `readinglite.app`,
   `staging.readinglite.ai`, and `staging.readinglite.app`.

Deleting a route while its config still lists it only lasts until the next
deploy, so do not start before both releases have gone out.

Deploying the frontend:

- **Production.** The **Deploy production frontend** workflow
  (`.github/workflows/deploy-app.yml`) builds `app/` with
  `CLOUDFLARE_ENV=production` on Node 22 and runs `wrangler deploy` for
  `reading-lite-app` from the released SHA, with the stale-`main` refusal. A
  failure leaves the previous frontend version serving. Rerun it to redeploy.
- **Staging.** Deploy the staging backend first
  (`npm run ops -- deploy worker --env staging --execute --database-url-env
  NEON_REHEARSAL_DATABASE_URL`), then run the
  **Deploy staging frontend** workflow by manual dispatch from the same ref.
- **Build check.** Both workflows run `app/scripts/check-build.ts` between
  build and deploy. It refuses a build whose environment, name, routes, or
  `BACKEND` binding differ from that environment of `app/wrangler.jsonc`, or
  that binds another environment's backend.
- **Smoke check.** Both workflows run `app/scripts/smoke-host.sh <https://host>`
  on every host of their environment; it also runs by hand from any machine.
  It passes only when `/health` is `ok` and a signed-out `/api/whoami` is a
  JSON 401 from the backend, and `/` comes from the frontend
  (`Cache-Control: private, no-store`, which a static host would not send).

The deploy token's zone Workers Routes permission on `readinglite.ai` and
`readinglite.app` (the backend already routes both) covers the frontend routes.

#### Frontend rollback

Roll a bad frontend back to its previous version with Wrangler, from `app/`:

```sh
npx wrangler deployments list --name reading-lite-app
npx wrangler rollback --name reading-lite-app -m "<reason>"
```

Pass a version id to `rollback` to pick an older version than the previous
one; use `reading-lite-app-staging` for staging. This does not touch the
backend. The next deploy (every merge to `main`, or a staging dispatch) replaces
the rolled-back version, so land the fix or a revert before it. There is no
second frontend to fall back to: the legacy `web/` SPA on Cloudflare Pages was
retired in reading-lite-gh335.3, and deleting a host's frontend route now
leaves `/` with no page to serve.

#### Retiring the Pages SPA

reading-lite-gh335.3 removed the SPA, its Pages deploy job, and `ops deploy
web` from the repository. The Pages project `reading-lite` and its custom
domains were dashboard state, removed by hand as below. **Done 2026-09-24:**
steps 1–4 on all four hosts, then, after the production release of that commit,
the Pages project itself. The smoke check passes on every host, and
`reading-lite.pages.dev` no longer resolves. The steps stay here as the record
and for any host that is ever moved off Pages the same way.

The Pages custom domain is what created each host's proxied DNS record, and a
Worker route only receives traffic for a proxied hostname (see
[Captain-only DNS / Pages / token](#captain-only-dns--pages--token-re-verify-if-zones-or-tokens-change)).
Cloudflare's order for detaching a Pages domain is to delete its CNAME first,
then remove the domain from the project. Deleting the CNAME without a
replacement takes the frontend **and** the backend's `/api/*`, `/health`, and
`/mcp*` off that host. For each host in turn — `staging.readinglite.ai`,
`staging.readinglite.app`, then `readinglite.ai`, `readinglite.app`:

1. In the zone's DNS records, delete the Pages CNAME for the host (target
   `reading-lite.pages.dev`, or its `staging.` preview alias) and immediately
   add a proxied `AAAA` record with content `cn` at the same name. The host
   does not resolve between the two steps, so do them back to back.
2. Run `app/scripts/smoke-host.sh https://<host>`; it must pass before going on.
   For a minute or so after the swap some edges still send the host to Pages,
   and the check fails with Pages HTML (`200 text/html`,
   `Cache-Control: public, max-age=0, must-revalidate`) on `/health` and
   `/api/whoami`. Wait and rerun before treating that as a failure; on
   2026-09-24 `readinglite.app` took about a minute longer than the others.
3. In **Workers & Pages → reading-lite → Custom domains**, remove the host.
4. Run the smoke check again.

After all four hosts pass, delete the Pages project `reading-lite` (this also
removes its `staging` preview) and drop Pages Edit from `CLOUDFLARE_API_TOKEN`
if it was granted. The dashboard cannot delete a project with more than about
100 deployments ([Cloudflare known issue](https://developers.cloudflare.com/pages/platform/known-issues/#delete-a-project-with-a-high-number-of-deployments)).
Delete the deployments first with `npx wrangler pages deployment delete <id>
--project-name reading-lite --force`, re-listing each environment with `npx
wrangler pages deployment list --project-name reading-lite --environment
production|preview --json` (one page at a time) until only the active
production deployment remains, then `npx wrangler pages project delete
reading-lite`. On 2026-09-24 that took 157 deletions. If a smoke check fails at step 2, re-point the record at
the Pages CNAME to restore the host while you investigate.

### MCP connector

`POST /mcp` is a Streamable HTTP MCP endpoint on the Worker. Cursor and Grok Bot
add it as a remote connector with a static `Authorization: Bearer <token>`
header (the same token as `reading-lite.bearerToken` / founder bootstrap).
There is no OAuth. Tools call the existing `/api/readings*` routes internally;
the token is never echoed in tool results. Canonical production URL is
`https://readinglite.ai/mcp`. C3 on #265 migrated connectors off the retired
host.

Production dual-serves dedicated `mcp*` Worker routes on `readinglite.ai` and
`readinglite.app` so the frontend's `host/*` route does not answer `/mcp`. Attaching those
routes requires zone Workers Routes permission on the Cloudflare API token;
if `ops deploy worker --env production` uploads the script but fails with
authentication error 10000 on `/zones/.../workers/routes`, add the missing
route in the dashboard (Worker `reading-lite`, matching `hostname/mcp*`
pattern) or use the `/api/mcp` alias which is already covered by `/api/*`.
Staging has the same trio of Worker routes on `staging.readinglite.ai` and
`staging.readinglite.app` (`/api/*`, `/health`, `/mcp*`).

`MCP_ALLOWED_ORIGINS` is the Origin allowlist. The code default
(`DEFAULT_MCP_ALLOWED_ORIGINS` in `src/mcp/origin.ts`, used when the var is
empty) is `https://readinglite.ai` and `https://readinglite.app`. Production
`[env.production.vars]` is configured to those two. Local `wrangler.toml`
`[vars]` currently sets only `https://reading-lite.bbell.dev`; staging sets
`https://staging.readinglite.ai` and `https://staging.readinglite.app`.
Requests with no `Origin` pass (non-browser clients). Unknown Origins are 403.

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

Staging exists for real end-to-end smoke tests that need Queue, R2, and a
deployed PostgreSQL database without mutating the production corpus. Both lifecycle scripts are
hard-coded to staging resource names, refuse production-looking names, and are
idempotent, "already exists" on setup and "already gone" on teardown are
treated as success, while unexpected Wrangler or R2 API failures stop the run.

```sh
# STAGING_DATABASE_URL, or on a laptop NEON_REHEARSAL_DATABASE_URL from
# `set -a; . ~/.config/reading-lite/neon.env; set +a`.
npm run ops -- staging setup --execute
npm run ops -- staging teardown --execute
```

Staging's database is the Neon rehearsal branch, reached through the
[operator database pairing](#step-0-the-connection-strings) for `reading-lite-staging`.
Setup resolves it before any Cloudflare change and migrates it with the same
run as `ops db migrate`; an unset, mis-paired, unreachable, or failing database
stops setup with nothing created. Its plan connects read-only to list pending
migrations; with no staging variable set, or the database unreachable, the plan
notes that and still prints the Cloudflare plan, while migration drift fails
it. The role needs DDL, including `CREATE EXTENSION vector`. Setup never
creates the database and teardown never drops it.

Teardown removes Queue consumers before deleting the Worker, then deletes the
reading, digest, wipe, export, and refresh Queue/DLQ pairs, empties the bucket via the
S3-compatible R2 API, and deletes the bucket: exactly the Cloudflare resources
setup creates. The bucket-empty step needs the `CORPUS_R2_*` credentials
above. It retains the staging PostgreSQL database.

Cursor cloud agents: `.cursor/environment.json` installs the root npm project
and runs `scripts/cloud-agent-install.ts`. The Cursor environment secrets are
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTH_ROOT_SECRET`,
`READER_API_TOKEN`, `FOUNDER_EMAIL`, and `STAGING_DATABASE_URL`. The installer
writes only `AUTH_ROOT_SECRET`, `FOUNDER_EMAIL`, and `READER_API_TOKEN` to
`.stg.vars`; the Cloudflare credentials and `STAGING_DATABASE_URL` stay process
environment variables. Staging founder state persists in PostgreSQL: bootstrap
again after credential rotation, or set `CLOUD_AGENT_FOUNDER_BOOTSTRAP=1` for an
idempotent bootstrap on each install.

`STAGING_DATABASE_URL` is a direct connection string to the Neon rehearsal
branch. `ops founder bootstrap`
resolves staging's and production's databases through the same pairing as the
other operator commands, so `--database-url-env` naming another environment's
database (or a bare `DATABASE_URL`) is refused.

Smoke-test idempotent submits against staging:

```sh
VARS_FILE=.stg.vars BASE=https://reading-lite-staging.<workers-subdomain>.workers.dev \
  ./scripts/manual/idempotency-smoke.sh a "https://example.com/reading-lite-staging-$RANDOM"
```

Clean up the throwaways afterwards, including `ready` ones. Staging pins
`TENANT_DATA_PLANE = "1"` (see the next section), so the live layout is the
staging founder tenant, not `global`. Resolve `$STG_TENANT` from staging's
`GET /api/whoami` the same way production's `$TENANT` is resolved:

```sh
npm run ops -- corpus audit --tenant "$STG_TENANT" --bucket reading-lite-staging --execute
npm run ops -- corpus drop --tenant "$STG_TENANT" "https://example.com/reading-lite-staging-123" \
  --bucket reading-lite-staging --allow-ready --execute
```

The embedding is a row that cascades with the reading (ADR 0005), so a ready
drop needs no separate vector step.

`--tenant global` still addresses staging's retained pre-tenant R2 copy, which
the gate makes invisible to the Worker. It is **R2-only**: the commands that
read or write rows (`corpus audit`, `drop`, `sweep`, `purge-connections`, the
three `refresh-*` passes, `ingest`, `recover --batch` and `--monitor`,
`reading-list check`) refuse it, because no `readings` row can carry the
pre-tenant empty key root and a resolvable `global` would report an empty
corpus rather than a wrong question.

### Rehearsing account deletion on staging

S5 proof step (run only in the separately approved live drill): capture
`ops account residue-scan --tenant "$DRILL" --bucket reading-lite-staging`
after wipe completion and again after cron teardown. Check per-source JSON,
first-completion history, and the explicit unknown section; exit 1 is expected
while DO/address-history visibility remains incomplete. The separately executed
[2026-09-05 staging drill](evidence/195-staging-drill-2026-09-05.md) records
the live repair, deletion, and automatic teardown evidence, including the
final `residue:false, incomplete:true` scan and remaining acceptance limits.
Signup-shaped email reuse after teardown is recorded in the
[2026-09-05 staging email-reuse drill](evidence/286-staging-email-reuse-2026-09-05.md)
and its [second-run supplement](evidence/286-staging-email-reuse-followup-2026-09-05.md).
The accepted #286 evidence retains `incomplete:true`; broader deletion coverage
and the named limits were subsequently accepted under #288/#195. #285 legacy
cleanup remains explicitly deferred; this runbook does not require another
acceptance drill merely because a routine release occurs.


`src/account-wipe.ts` skips with `no_tenant_prefix` whenever `TENANT_DATA_PLANE`
is off, so an environment with the gate unset cannot exercise the destructive
path at all. Staging therefore pins the gate in `[env.staging.vars]`, and its
pre-tenant corpus was migrated under `u/{founderTenantId}/` by
the now-retired founder migration command. It copied rather than moved, so
the legacy `readings/` and `index/` objects remain in the bucket.
Removing the pin is a **complete rollback only before post-pin writes resume**.
After the pin, every new staging reading's content is written only under its
tenant R2 root. Rolling the gate back leaves the rows in place but resolves
their content at the global root, where post-pin bytes do not exist. After
writes have landed, rollback requires a freeze plus reverse reconciliation
(copy tenant-rooted content back to the global layout) or an explicit
captain-accepted loss of the post-pin content.

One consequence of that to keep in view if the drill is ever pointed at the
staging *founder* rather than a throwaway tenant: the wipe never touches the
pre-tenant `readings/` / `index/` objects, so a full
duplicate of the staging corpus survives outside every tenant root. "Nothing
left under `u/{tenantId}/`" would then not mean the data is gone from staging.
It is the same hole production carries until the legacy objects are deleted
under sign-off.

**Where the SQL below runs.** Staging's control plane is the PostgreSQL database
paired with `reading-lite-staging`: `STAGING_DATABASE_URL`, or on a laptop
`NEON_REHEARSAL_DATABASE_URL` from [step 0](#step-0-the-connection-strings):

```sh
# Cloud agents and CI already have STAGING_DATABASE_URL; a laptop sources the alias.
[ -n "${STAGING_DATABASE_URL:-}" ] || { set -a; . ~/.config/reading-lite/neon.env; set +a; }
STAGING_DB="${STAGING_DATABASE_URL:-${NEON_REHEARSAL_DATABASE_URL:-}}"
: "${STAGING_DB:?set STAGING_DATABASE_URL or NEON_REHEARSAL_DATABASE_URL}"
```

The last line stops the drill when neither variable is set. Without it, every
`psql "$STAGING_DB"` below would get an empty string and connect to whatever
libpq's defaults name instead.

Staging's Worker has run on this database since
the #349 rehearsal deploy (2026-09-24); a drill from before then exercised the
D1-era Worker and proves nothing about the PostgreSQL one.

**Preflight, before any deploy that could start wipes.** Any account left in
`status='deleting'` by earlier testing becomes a real wipe on the next `*/15`
tick once its 7-day grace has elapsed. Look first:

```sh
psql "$STAGING_DB" -c "SELECT u.id, u.email_canonical, u.status, u.deleting_at FROM users u
  LEFT JOIN wipe_progress w ON w.tenant_id = u.id
  WHERE u.status <> 'active' AND w.completed_at IS NULL"
```

The join is what makes this list *actionable* rather than just true. A tenant
whose `wipe_progress` row carries a `completed_at` has already been wiped, and
**the next tick will hard-delete the account** (S4), with no exemption. The
`IS NULL` still covers a *reopened* wipe (a reopen clears `completed_at`),
which is still live and does belong in the list. Completed tenants are a
separate question:

```sh
psql "$STAGING_DB" -c "SELECT u.id, u.email_canonical, w.completed_at, w.force
  FROM users u JOIN wipe_progress w ON w.tenant_id = u.id
  WHERE u.status = 'deleting' AND w.completed_at IS NOT NULL"
```

Completed fixtures follow the same teardown path; do not assume an old
fixture still exists. The dated evidence below records the original S6 fixture.

Any account in either preflight result that is not meant to be destroyed, the
staging founder above all, needs an operator recovery decision first. The reset
below is only for a deletion that has not destroyed data. Restoring
`status='active'` alone is not enough: leave `deleting_at` set and a later
`DELETE /api/account` reuses it through `COALESCE` in `beginAccountDeletion`,
so the next cron can wipe immediately and skip the 7-day grace. An unfinished
or reopened `wipe_progress` row (`completed_at` NULL) is worse: fan-out treats
it as a **resume**, and resume ignores grace.

A delivery that already passed the status check can continue deleting after
reactivation. **The heartbeat is advisory**: a recent `updated_at` is a reason
to stop, but an old value or waiting 15 minutes does not prove that no job is
active. Delayed retries can outlive that window.

Before any reset:

1. Pause cron fan-out and teardown, new wipe submissions, and queue delivery
   for staging. Confirm previously started wipe/teardown invocations have
   ended. Turning the tenant gate off does not cancel an invocation that
   already passed it.
2. Account for queued messages, delayed retries, and DLQ redrives for this
   tenant. They must not survive the reset and a later deletion request: an old
   `force: true` envelope would bypass the new grace period. Do not drain them
   by running the destructive consumer against an account being rescued.
3. Inspect and save the progress record, audit record, `readings` count and
   remaining R2 state. The `rows` phase runs first and deletes every reading
   row in one transaction, so a progress row past `rows` means the corpus is
   already gone. If deletion has begun, the account was previously wiped,
   teardown was attempted, or any of those facts cannot be established, stop
   this reset and prepare a data-recovery plan. This SQL cannot restore
   deleted data.

There is no atomic cancel-and-rescue command. If the pause and pending-message
conditions cannot be verified, do not run the writes below. With them verified,
a never-completed, unintended deletion can be reset as follows. A completed or
reopened wipe's first-completion history must remain intact; the guards refuse
that case rather than erasing it.

```sh
psql "$STAGING_DB" -c "SELECT * FROM wipe_progress WHERE tenant_id='<tenant>'"
psql "$STAGING_DB" -c "SELECT * FROM account_deletions WHERE tenant_id='<tenant>'"
# Only after the pause, pending-message, and data checks above:
psql "$STAGING_DB" -c "UPDATE users SET status='active', deleting_at=NULL, updated_at=now()
  WHERE id='<tenant>' AND status='deleting'
  AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE tenant_id='<tenant>')
  AND NOT EXISTS (SELECT 1 FROM wipe_progress WHERE tenant_id='<tenant>'
    AND (completed_at IS NOT NULL OR first_completed_at IS NOT NULL))"
# Stop unless psql reports UPDATE 1. Then remove the stale resume state:
psql "$STAGING_DB" -c "DELETE FROM wipe_progress WHERE tenant_id='<tenant>'
  AND completed_at IS NULL AND first_completed_at IS NULL
  AND EXISTS (SELECT 1 FROM users WHERE id='<tenant>'
    AND status='active' AND deleting_at IS NULL)"
```

Re-read the user and progress rows before resuming: the user must be active,
`deleting_at` NULL, and the unfinished progress row absent.

That still is **not** a full rescue: `beginAccountDeletion` stamped
`revoked_at` on every session and API token and nothing reverses that, so the
account is `active` but cannot authenticate. Re-run
`ops founder bootstrap --env staging --execute` for the founder, or issue a
fresh magic link, before assuming staging works again.

Staging already has tenant mode enabled and its founder cutover is complete.
Do not rerun that migration to rehearse deletion. For a rebuilt environment,
verify restored tenant data (or that the environment is intentionally empty)
and follow the [tenant-mode activation guard](#tenant-mode-activation-guard).
The historical migration procedure and evidence remain in
[the completed cutover record](founder-cutover.md).

The drill itself. Create a throwaway tenant, give it readings, fence it, let
cron wipe it, then prove the residue is gone.

- **`$DRILL` is a fresh `usr_<uuid4>`, and it must be lowercase.**
  `parseTenantId` canonicalizes to lowercase (`src/control-plane/ids.ts`), but
  macOS `uuidgen` emits uppercase. An uppercase id still fans out, and then the
  wipe addresses `u/{lowercased}/` and writes `wipe_progress.tenant_id`
  lowercase, so every `WHERE tenant_id='$DRILL'` query below quietly misses.
- **Seed through the API, not by hand.** A reading is a `readings` row with its
  URL, revision, embedding and attempt rows, plus immutable content objects
  under `u/$DRILL/` in R2. Sign up for real, create an API token, and import a
  few small Markdown files with `ops import markdown`: that writes both halves
  the way production does, for a few cents of summarization. Hand-inserted rows
  without their R2 objects, or objects without rows, test a shape the Worker
  never produces.
- **One wipe pass is normal.** There is no vector ledger and no confirmation
  wait: `rows` deletes the corpus in one transaction, `objects` empties the
  prefix, and `done` completes once no rows remain, one delivery per 20,000
  objects (see [progress and phases](#progress-and-phases)).

```sh
# 1. Create the account. Prefer a real staging signup (the seeding above needs
#    a token). Inserting the row directly only suits a drill of an empty
#    tenant. Either way the wipe is driven off this row: without it the UPDATE
#    below matches nothing, listDeletingUsers never returns the tenant, and the
#    drill silently exercises nothing while every residue check passes. Use a
#    per-run address: users.email_canonical is NOT NULL UNIQUE.
psql "$STAGING_DB" -c "INSERT INTO users (id, email_canonical, email_display, status,
  email_verified_at, created_at, updated_at)
  VALUES ('$DRILL','s6-drill-$DRILL@test.example','s6-drill-$DRILL@test.example',
  'active',now(),now(),now())"

# 2. Confirm the seeded readings:
psql "$STAGING_DB" -c "SELECT count(*) FROM readings WHERE tenant_id='$DRILL'"

# 3. Fence the account so the ordinary */15 cron starts the wipe.
#    Direct-insert path only: that tenant has no sessions or tokens, so the
#    users-row UPDATE is the whole fence.
psql "$STAGING_DB" -c "UPDATE users SET status='deleting',
  deleting_at=now() - interval '8 days', updated_at=now()
  WHERE id='$DRILL' AND status='active'"
```

**Do not use that users-only UPDATE for a tenant that signed up for real.** It
is not `beginAccountDeletion`: `src/control-plane/account-delete.ts` also
revokes every session and API token. Skip the revoke and the later
`live_sessions = 0` / `live_tokens = 0` check fails, and the drill never
exercises the credential fence.

Use the real API instead (session cookie, `X-CSRF-Token`, recent-auth window;
the Security page is the same path), then backdate grace so cron, not a
hand-injected queue message, starts the wipe:

```sh
# After DELETE /api/account with body { "confirm": "delete" }:
psql "$STAGING_DB" -c "UPDATE users SET deleting_at=now() - interval '8 days', updated_at=now()
  WHERE id='$DRILL' AND status='deleting'"
```

**Check that the users-row fence UPDATE reported `UPDATE 1`.** Zero means the
row is missing or not in the expected status, and everything downstream will
look like a clean, successful wipe of nothing.

Backdating `deleting_at` past the 7-day grace is what lets the ordinary `*/15`
cron fan-out start the wipe, so the drill exercises the real entry point
instead of a hand-injected queue message. Then watch it finish:

```sh
psql "$STAGING_DB" -c "SELECT * FROM wipe_progress WHERE tenant_id='$DRILL'"
```

A PostgreSQL wipe always completes with `residue=false`: completion is written
only after the tenant's `readings` count is zero.

Residue checks afterwards.

**1. The residue scan.** `ops account residue-scan --tenant "$DRILL"
--bucket reading-lite-staging` observes rows and the tenant R2 root
independently (see [the scan](#account-residue-scan-s5)). Expect
every `pg.*` corpus source and the R2 root clear; exit 1 remains expected for
the DO/address-history visibility limits. Do **not** use `corpus audit` for R2:
it inventories `readings` rows, so after a successful wipe it reports an empty
corpus and says nothing about objects left in the bucket.

**2. The control plane after the wipe, before teardown.** The wipe removes the
**data plane only**. Until control-plane teardown runs, the `users` row, the
`wipe_progress` completion record, and the tenant's `sessions`, `api_tokens`,
`user_settings` and `digest_deliveries` rows all survive:
`beginAccountDeletion` *revokes* sessions and tokens by stamping `revoked_at`
in place rather than deleting them. Check that credentials are **revoked**,
not that rows are absent:

```sh
psql "$STAGING_DB" -c "SELECT
  (SELECT count(*) FROM sessions WHERE user_id='$DRILL' AND revoked_at IS NULL) live_sessions,
  (SELECT count(*) FROM api_tokens WHERE user_id='$DRILL' AND revoked_at IS NULL) live_tokens,
  (SELECT count(*) FROM readings WHERE tenant_id='$DRILL') readings,
  (SELECT completed_at FROM wipe_progress WHERE tenant_id='$DRILL') completed_at"
```

Expect `live_sessions = 0`, `live_tokens = 0`, `readings = 0` and a non-NULL
`completed_at`. A tenant inserted directly has no credential rows at all, which
is not evidence either way.

**Control-plane teardown is automatic (S4).** Once the wipe has completed and
the prefix is empty, the next `*/15` cron tick runs
`src/control-plane/account-teardown.ts`: audit row first, Durable Object guards
fail-closed, address-history lookup, R2 prefix recheck immediately before the
transaction, then one ordered delete ending at `users` (see
[teardown](#control-plane-teardown-and-email-reuse)). Do **not** manually
`DELETE FROM wipe_progress` / `DELETE FROM users`: that bypasses the audit row,
the guard purge, and the prefix recheck. After teardown the same queries should
show the `users` and `wipe_progress` rows gone and a single `account_deletions`
row for the tenant. The address is then free; under `invite_only` it still
needs a fresh invite. PostgreSQL always enforces the foreign keys and none of
them cascades, so child-before-parent ordering matters; do not restore manual
SQL that assumes otherwise.

A new throwaway drill tenant is torn down on the tick after its wipe
completes. Watch `account_teardown_complete` for it, then confirm the audit
row and the absent `users` row rather than deleting them by hand.

The historical S6 fixture, `usr_5e6d0000-0000-4000-8000-000000000006`,
also followed automatic teardown. The [staging evidence](evidence/195-staging-drill-2026-09-05.md)
records its removal and preserved first-completion history. Do not reuse it as
an assumed live fixture; create a fresh throwaway tenant for a new drill.

Do not restore the former source-level exemption for that ID. It had no
environment gate, so it also exempted the ID in production, and its release
condition reused `wipe_progress.force`. An unrelated redrive could therefore
release the supposed hold. Protect test data through operator coordination,
never a tenant-ID exception in the deletion code.

## Diagnosing a single reading

`GET /api/readings/:id/diagnostics` reads the reading's row and shows whether
its URL's owner row is this reading, which R2 content objects exist under its
key prefix, its list projection, and the 20 most recent `reading_attempts` rows,
including which stage failed (`fetch_source`, `embed_source`, `summarize`,
`upsert_vector`, `write_indexes`, …). The response keeps the old `pointers` /
`index_item` vocabulary its consumers parse; the by-id "pointer" is the row
itself. Each background run records its trigger, stage events, timings and
sanitized error details on its attempt row, so failures are inspectable without
`wrangler tail`.

`POST /api/readings/:id/reprocess` retries that exact id. A failed reading
becomes `pending` while the attempt runs. A ready reading keeps its published
revision as the fallback: a successful attempt publishes a new revision,
summary and embedding in one transaction, and a failed one preserves the ready
revision with `last_attempt.status = "failed"`.

## Corpus tools

For a complete production refresh window, use the
[full-run procedure](corpus-refresh/runbook.md). The
[September 4, 2026 report](corpus-refresh/2026-09-04-results.md) records the
first complete calibration run, its costs, and the retained thresholds.

| Script | What it does |
|---|---|
| `npm run ops -- corpus audit` | inventory of every non-ready reading from the tenant's rows, classified by failure reason (plans by default; `--execute` writes `index.json` + `INDEX.md`) |
| `npm run ops -- corpus recover` | acts on an audit: reprocess or re-extract per a per-reason policy table (plans by default; `--execute` submits) |
| `npm run ops -- corpus drop` | remove readings by URL or id: deletes the row (the URL claim, revisions, attempts, its own outbound relationships and the embedding cascade) plus the reading's captured R2 content; inbound citations do **not** cascade — follow with `corpus purge-connections`; `--allow-ready` permits a ready one, off production |
| `npm run ops -- corpus sweep` | reconcile duplicate copies of one resource across URL spellings (keeps the best, drops the rest, embeddings included; inbound citations do **not** cascade — follow with `corpus purge-connections` per dropped id) |
| `npm run ops -- corpus refresh-neighbours` | re-measure readings against the tenant's stored vectors, print the staleness inventory, and write `refresh-report.json` (no LLM; measures only what changed since the run marker by default, `--full` sweeps every ready reading; `--execute --sole-writer` rewrites drifted `similarity` snapshots) |
| `npm run ops -- corpus refresh-connections` | consume `refresh-report.json`, plan relationship-only judgements with estimated cost, and selectively update connections, novelty, and the computation date |
| `npm run ops -- corpus refresh-tensions` | pair each flagged reading in `refresh-report.json` with its neighbours, pre-filter on overlap evidence, and judge directional tensions written to both readings in one transaction (`--pair a,b` hand-picks a pair) |
| `npm run ops -- corpus refresh-status` | read-only status of the hosted weekly refresh for one tenant: cursor phase and counts, checkpoint rows, uncertain dispatches, tension verdicts, and corpus tension health. `--json` prints one document. Rejects `--tenant global` |
| `npm run ops -- corpus purge-connections` | delete every `reading_relationships` row naming one already-deleted reading as its target (plan-first; one statement; `--execute` requires `--sole-writer`) |
| `npm run ops -- corpus redact-key-echoes` | find stored reading and attempt errors that still carry a provider key fragment and redact them in place (plan-first; no provider call; `--execute` re-scans and exits 1 on leftovers) |
| `npm run ops -- corpus ingest` | bulk-ingest a fresh markdown directory through a provider Batch API |

The `refresh-neighbours`, `refresh-connections`, and `refresh-tensions`
examples below all select the founder tenant. Since the production cutover, new
readings are written under the founder's `usr_…` namespace, so export it once
and reuse it:

```sh
# Fill in, then paste.
export TENANT=usr_…   # production whoami.tenant_id
```

Take that id from an authenticated `GET /api/whoami` against production. The
production founder id is also recorded in the cutover log in
`docs/founder-cutover.md`, but that file lists a **staging** founder id as
well, do not copy the wrong one.

`--tenant global` is refused outright by all three passes. It names the
pre-tenant R2 layout, which has no rows, and a refusal is the honest answer:
resolving it would report an empty corpus rather than a wrong question. The
refusal comes before the spend session opens, so no paid session is admitted
for work that cannot happen.

The connection string does not live in the repo. Each pass resolves its
database from `--bucket` through `scripts/pg-lib/operator-db.ts` — an allowlist
of variable names per environment, not a pattern — so `reading-lite` means
`PRODUCTION_DATABASE_URL` or `NEON_MAIN_DATABASE_URL` and nothing else, and an
unrecognised bucket gets no database rather than a production-shaped guess.
`--database-url-env` names a different accepted variable; `--local` uses this
checkout's own PostgreSQL and refuses to accept a deployed variable at all.
Operators source the Neon strings from `~/.config/reading-lite/neon.env`, so no
connection string enters the repository or the process list. The provider
credentials the two paid passes need are still read from `.corpus.vars` and the
environment.

Each pass opens one direct PostgreSQL session for its whole run and closes it
on every exit path, success and failure alike.

All three refresh commands end every pass, plan or execute, with a `Timing:`
block: one row per phase the pass used (`list read`, `planning reads`, the
readings read while planning, `reading read` for reads outside a planning pass,
`similarity query`, `reverse query`, the scoping queries an incremental tier-1
pass makes, kept apart from the measurement ones because the scope trades one
for the other, `run marker`, `provider`, `reading write`), each with its call
count and total wall time, then the run total. The block is printed even when
the pass ends in an error, and failed calls are counted, since a stalled read
is exactly the wall time worth seeing. Execute mode also prints `ms=` per
judgement beside its token usage. One thing the counts do not say: a time
includes any retry and its backoff, so one unusually slow call may be a call
that quietly retried. A judged pair is one `reading write`, not two, because
tier 3 writes both sides in one transaction. Record the block: it is the
baseline a later run or a performance change is compared against, and it is
what tells a slow pass apart from a hung one.

The provider calls keep their own robustness policy. `refresh-connections` and
`refresh-tensions` retry 5xx, and a 429 surfaces as a `RateLimitedError` naming
the retry-after the provider asked for; that one is what the execute pass's
global backoff reacts to (below). The judgement calls carry no deadline of
their own, so a stall there still looks like a silent pass, and the `Timing:`
block is what makes it visible.

`ops corpus refresh-neighbours` measures each ready reading in scope against
the tenant's stored vectors — the exact pgvector cosine scan the Worker serves
`/api/readings/similar` from, so an operator pass and the product cannot
disagree about a neighbourhood — by default the readings that moved since the
run marker, and under `--full` every one of them, per **Scope** below, with no
embedding calls and no LLM. It prints the staleness inventory,
and always writes its report (`--out`, default `./refresh-report.json`; give
each writer its own path, see below), the input contract for later
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
producer preserves live ingestion's selection order: the raw
top five, similarity floor, then ready-ID intersection. It does not
fill vacated slots with lower-ranked ready readings. Plan mode writes nothing.
`--execute` rewrites only drifted `similarity` snapshots (count change or
`|Δmax|`/`|Δmean|` ≥ 0.02), one column of one row — the list row IS the reading
row, so there is no second document to keep in lockstep and no closing flush.
It touches nothing else, `updated_at` included: bumping it would misreport the
reading as freshly written and put it back in the next incremental scope every
night. `--execute` is still refused without `--sole-writer`, because a pass
that measures the corpus while other writers change it reports a corpus that
never existed. Leaves status, vectors, title, tldr, tags, keywords, entities,
and `summary_markdown` untouched. A second immediate `--execute` writes
nothing.

```sh
# The corpus-wide staleness inventory this section describes needs --full: a
# bare invocation is scoped to what moved since the run marker (see Scope), so
# on a quiet night it measures nothing and exits 0.
#
# --out keeps an ad-hoc sweep off BOTH schedules' report paths — the nightly's
# and the weekly's. See "different --out paths" below for why no two writers
# may share one.
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" --full \
  --out ./refresh-report-adhoc.json
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --full --execute --sole-writer --out ./refresh-report-adhoc.json
```

**Scope.** By default the pass measures only what moved (`--since-last-run`,
the default, accepted as a way of saying so out loud).
`--full` is the explicit sweep: every ready reading, O(N) whatever changed, the immediate rerun in run A measured 553 readings in 16 minutes and wrote none
of them. (That figure is from the R2-and-Vectorize era; it is the shape of the
argument that matters, not the number.) The default measures only the
readings whose neighbourhood could have moved since the run marker, a
`corpus_refresh_state` row per tenant (db/migrations/0006): those created or
reprocessed since it, and the reverse neighbourhood of each changed vector (one
topK-100 query per changed reading, keeping matches
at or above the similarity floor less 0.1, so a reading that far away cannot
gain or lose a floored neighbour because that one vector changed). The reverse
query is the only source of strangers: a list row carries no
citations, so a reading that cites a changed one is found because it still
scores above the bound, which holds for every change except a vector that
moves. The scope and its reason are printed
(`Scope: incremental (12 reading(s)) — …`) and recorded in the report header.

It escalates to a full sweep whenever that reasoning runs out: no marker (the
first run, a deleted one, or one in an older format, the marker is version 3
and an older one is rejected with a message that says so, which is also how the
R2-era version-2 markers retire), a marker carrying an invalidation, a reading
the marker recorded that has since left the corpus (a purge names nothing a
timestamp can find), a failed reverse query, a changed *ready*
reading with no vector to scope from, or a reverse neighbourhood that came back
full at topK with no match below the bound, meaning the query was truncated and
the real set is unknown, never a narrower pass. A short result is a complete
one, so an isolated reading, whose only match is itself, does not escalate. An
escalation reports how many of the changed readings caused it and names the
first, because a corpus that saturates most nights is buying nothing from the
narrowed scope, that rate is the number to watch, and a corpus that escalates
every night should be run as `--full` outright rather than paying the reverse
queries first.

It also sweeps once narrowing stops paying. Every reverse query and every
measurement is one similarity query, and a sweep is one per ready reading. Before
each reverse query, the first included, the pass compares the reverse queries
it has still to make plus the ready readings already known to be in scope
(changed, carried forward, or brought in by a reverse answer, each counted
once) with the ready corpus, and sweeps as soon as the first is larger. Queries
already made are spent either way and do not count. A tie stays incremental,
which keeps a quiet night whose only scope is the carried unmeasurable readings
out of the zero-measured-sweep check below. A bulk ingest or mass reprocess
that already outweighs the corpus therefore sweeps without any reverse query,
and the reason names both costs (`Scope: full — incremental scope would cost
at least 812 similarity queries (412 reverse still to run, 400 reading(s) to
measure) against 553 for a full sweep — after 0 of 412 changed reading(s)`).
Reading reads are not counted, which tips close calls toward the sweep.
`--limit` takes no part in the comparison and caps whichever plan results.

An incremental report is a statement about its scope, not about the corpus: a
persistent flag on a reading nobody touched, the backfill's 394
`connection_below_floor` rows, say, stays invisible until that reading enters
scope. **The weekly `--full` sweep is what makes the default safe, and it is
scheduled by the operator, outside this repository**, nothing in git schedules
a corpus refresh pass (the `crons` triggers in `wrangler.toml` drive the
Worker's own scheduled handler, not these commands), so see "Refresh exit codes"
for the wrapper an operator's cron wants. If
nothing sweeps, those persistent flags never resurface and the served
`similarity` numbers drift indefinitely.

A reading the scope does bring in is measured like any other target, so its
`similarity` snapshot is brought current in the same pass, nothing about being
in scope defers a measurement to the sweep.

**What an incremental pass keeps exact, and what it only keeps approximate.**
Flags are exact: the bound is derived so that a reading further away than it
cannot gain or lose a *floored* neighbour because one vector changed. The
stored `similarity` snapshot is not, and this is broader than the moved-vector
case above. That snapshot, which the API and the frontend serve straight off the
reading's row, summarises the **raw** topK, sub-floor scores included, so a vector
merely *added* anywhere enters some stranger's topK and moves its `max`/`mean`
at any score, far below the bound. Between sweeps those numbers are therefore
approximate on every reading the scope left out. The drift is deterministic and
the next `--full` clears it.

The moved-vector case remains the one thing that defers a *re-judgement* rather
than a number: a reprocess that moves a vector far enough to leave a stranger's
floored neighbourhood is invisible to the reverse query, which runs against the
vector's new position.

A purge and an embedding-only write are not on that list. The marker records the reading ids it saw, not a row count, so a day that purges
two readings and ingests three still escalates and names the first missing id.
(Every id, not just the ready ones: a non-ready row can still own a stored
vector, so its removal moves neighbourhoods too.) The marker also carries
`invalidated_by`, stamped by a writer that moves embeddings without touching
the readings rows, so the next pass sweeps on its own. A refresh pass that
finds a stamp it did not start with leaves the marker alone rather than
clearing a sweep it did not perform: a pass that swept while vectors were still
arriving must not report the corpus as covered. Nothing stamps it today —
`corpus backfill-vectors`, which did, was retired in reading-lite-gh347.4.6
because an embedding now commits and cascades inside its reading's own
transaction — and the field stays because a marker written before that must
keep being read.

**Staging proof, 2026-09-02**, the measurement the default flip rests on
(`reading-lite-staging`, 39→47 readings, over the R2 and Vectorize storage of
the time, `--tenant global`; eight `--execute --sole-writer` passes, all exit
0). The wall-clock figures belong to that storage and are kept as the record of
why the narrowed scope is the default; the *shape* of the result — what the
scope covers and what it defers — is a property of the rules, not of the
store. Passes 1–5 are the
protocol proper, full → incremental (quiet) → ingest 8 URLs → incremental →
full → full; 6–8 were added to price a second quiet night and to exercise the
escalation path deliberately. All eight, in order:

| # | invocation | scope taken | measured | wall | flagged |
|---|---|---|---|---|---|
| 1 | `--full` | full | 29 | 10.75 s | 0 |
| 2 | `--since-last-run` | incremental (0) | 0 | 1.00 s | 0 |
|, | *ingest leg, 8 URLs → 4 ready + 4 failed* |, |, | 118 s |, |
| 3 | `--since-last-run` | incremental (8) | 4 | 6.72 s | 2 |
| 4 | `--full` | full | 33 | 14.09 s | 2 |
| 5 | `--full` (immediate rerun) | full | 33 | 11.80 s | 2 |
| 6 | `--since-last-run` | incremental (0) | 0 | **0.98 s** | 0 |
| 7 | `--since-last-run` | **escalated**, 1 reading purged | 33 | 12.75 s | 2 |
| 8 | `--since-last-run` | **escalated**, 3 readings purged | 33 | 13.54 s | 2 |

Five of the eight were `--since-last-run` (2, 3, 6, 7, 8), which is the
denominator for the escalation rate below.

- **Flags were byte-identical** between the incremental pass and the sweep
  taken 19 seconds later: same two ids, same `connections`,
  `current_neighbours`, `novelty_verdict`, `reasons`, `judged_at`. The narrowed
  scope missed no flag.
- **Snapshot drift elsewhere was not zero, by design.** The sweep after the
  incremental rewrote two snapshots the incremental never measured, both X
  readings whose nearest score moved 0.221→0.239 and 0.172→0.268 as the four
  new vectors entered their raw topK. (Eight rows were ingested and entered the
  changed set; four reached `ready` and own a vector, and the other four are
  the "not ready, own no vector" half the scope planner skips.) Both sit far
  below the bound (0.45) and
  neither can change a flag. The immediately following sweep reported
  `Snapshot drift: 0`, so it is deferred, not lost. That is the
  exact-versus-approximate paragraph above, measured.
- **12–14x cheaper, and flat in N on a quiet night** (0.98 s against 11.80 s):
  the pass resolves an empty scope and returns before it makes a similarity
  query or reads a reading, provided the marker carries no still-ready
  `unmeasurable_ids`, each of which costs a query and a read on even the
  quietest night, by design. The list-ETag short-circuit those runs took is
  gone with the document that had one; every pass now dates the rows it read,
  which reaches the same empty scope by the route the ETag-less runs already
  took.
- **Tier 1 spends no LLM or embedding tokens at all**, 0 across all eight
  passes. The scope buys wall clock and Cloudflare API calls, not provider
  spend. What it does change is how many readings tiers 2/3 are handed.
- **Escalation: 2 of 5 incremental passes (40%)**, both from purges deliberately
  induced by the measurement; excluding those, 0 of 3. Both escalations named
  their cause and cost ~1 s more than a plain sweep would have. The saturation
  hatch never fired.

Two numbers staging could not supply, so the flip does not claim them: the
production stranger fan-out per changed reading (staging's reverse queries
returned zero strangers, because that corpus is sparse and clustered, so
saturation there says nothing about production) and the natural production
purge rate. Both change the size of the win, not its sign.

A reading with no stored vector, or whose rows no longer satisfy
`ManifestSchema`, is unmeasurable rather than unfinished. The pass records its id under
`unmeasurable_ids` on the marker, measures it again on every later pass until it
is repaired, and exits 3 so it stays visible, the marker advances past it
rather than pinning the whole scope on an ever-older timestamp. A failed query
or a failed snapshot write is different: that pass left work undone, so the
marker stays where it was and the exit is 1. (A reading purged between the
corpus read and its own read is neither: there is nothing to measure and
nothing to repair, the pass says so and carries on, and the next pass sees the
id missing and sweeps.) Note what a frozen marker does and does not buy: the
next incremental pass re-covers everything changed since that older timestamp,
which is more than it would otherwise have looked at, but a reading that failed
without its row moving is not named anywhere (unlike `unmeasurable_ids`),
so the weekly `--full` sweep is what actually finds it again.

**A whole sweep of unmeasurable readings is a different thing again.** A sweep
that measured *none* of its ready readings is not a corpus with a lot of broken
readings; it is a pass that could not read the corpus. A connection string for
the wrong environment, a `--tenant` with no rows, and a database failing every
query all present this way. Advancing the marker there
would declare the whole corpus refreshed on the strength of zero measurements
and never look at it again, so the pass instead leaves both `last_run_at` and
`last_full_run_at` where they were, prints `Configuration failure: this pass
swept the corpus and measured 0 of N ready reading(s)` with the `no vector` /
`failed` / `unparseable` breakdown, and exits 1.

**Only a sweep reports one**, because only a sweep's scope is large enough to
say so, and because a sweep's scope comes from the rows rather than
from the marker, so it reaches the same verdict on the first pass as on the
hundredth, with no marker to bootstrap from. An incremental scope is routinely
one or two readings, often exactly the ones carried under `unmeasurable_ids` for
retry; calling that a configuration failure would freeze the marker on a single
broken reading, grow the scope every night, and page for it forever. On any
night that a ready reading changed, a misconfiguration surfaces anyway, that
reading's vector cannot be found, which escalates the scope to a sweep, and the
sweep reports it. On a night when nothing changed at all it does not: the scope
is then whatever an earlier pass carried under `unmeasurable_ids`, those all
answer "no vector" and the pass exits 3, or, if no pass ever got far enough to
record any, nothing at all, and it exits 0. **The weekly `--full` sweep is the
only guaranteed detector**, which is one more reason to keep it scheduled. A pass narrowed by `--only` or by a
`--limit` that truncated it never reports a configuration failure either, it
measured the subset it was told to, so naming one broken reading with `--only`
exits 3, not 1. Nor does a pass that threw partway through: the targets after
the throw were never attempted, so it reports the abort and exits 1 on that.

There is no minimum corpus size, so a small tenant, a staging or dev corpus of
one or two ready readings, both vectorless, sweeps, reports a
configuration failure, and stays there until someone repairs or re-embeds them:
exit 1 on every sweep, marker frozen. That is the intended
reading of the evidence (a corpus in which nothing is measurable is not a corpus
you can refresh), and on a corpus that small a permanent sweep costs nothing.
The production corpus is in no danger of it by size: a sweep there measures
hundreds of readings, so the condition cannot fire unless the corpus really is
unreadable. It can fire by state, though — a migration that has moved the
readings but not yet their embeddings leaves every ready reading vectorless,
which is what this condition is built to notice. Every sweep will exit 1 for
the length of such a window, while the nightly `--since-last-run` may well go
quiet, since a migration like that moves no row timestamps, so pause the
schedule or finish the embedding backfill before relying on either.

`--only <id>` overrides the scope: a named reading is measured whether or not
the scope would have selected it, and the pass resolves no scope at all rather
than paying for reverse queries it cannot use. The header then reads
`Scope: full — --only names N reading(s)`. `--limit` is different: it still
resolves its scope and then measures the first N of it, so the header and the
report keep saying `incremental`. The report records the narrowing under
`scope.narrowed_by`, always for `--only`, and for `--limit` only when it
actually cut the pass short, so the report and the marker agree about whether
the pass was partial. `--only` never advances the marker; `--limit` pins it
only when it actually cut the pass short, so a limit carried in a cron as a
cost valve and never reached still advances it.

Only a complete `--execute` pass advances the marker, a plan pass writes no
snapshots, `--only` names a subset, and a `--limit` that truncated the plan
measured one, and `last_full_run_at` moves only on a full sweep. A failed
marker write does not fail the run: the cost is the next pass sweeping.

```sh
# Nightly. --since-last-run is the default; spelled out so the schedule says
# which scope it means.
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --since-last-run --execute --sole-writer
# Weekly. A bare invocation runs incrementally and never sweeps, so the weekly
# schedule must ask for --full (scoped runs warn when the sweep is overdue).
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --full --execute --sole-writer --out ./refresh-report-full.json
```

Scoped refreshes (invocations without `--full`) print a stderr warning when
`last_full_run_at` is missing, unusable, or **older than seven days**. Exactly
seven days is still within the threshold. The warning shows the timestamp and
age (or `age unknown`) and a full-sweep command for the selected tenant and
bucket, so a stderr-only log is enough to check before `--execute`. Check the external
weekly schedule and run that command after pausing/draining concurrent
writers for `--sole-writer`.

Plan and execute evaluate the same stored timestamp before resolving scope,
including quiet runs and runs that automatically escalate to full. The warning
itself changes neither corpus state, scope, nor exit status. A completed full
execute pass clears it for subsequent runs; a plan, failed pass, or incremental
pass cannot refresh the full-sweep timestamp. Automatically escalated full
passes count as sweeps. Existing marker rules still apply: partial selections
do not advance it, while a completed sweep that carries unmeasurable readings
can advance it and exit 3. Those readings still need the reported repairs.

Give every writer of a refresh report its **own `--out` path**, the nightly,
the weekly sweep, and any ad-hoc run, and point each schedule's tier-2/3 run at
its own report:

```sh
# Weekly, consuming the sweep — not the nightly report.
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report-full.json
npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --report ./refresh-report-full.json
```

Both tiers default to `./refresh-report.json`, and an incremental report is a
statement about its scope: sharing one path would let a nightly pass, or an
ad-hoc interactive one, overwrite the sweep's corpus-wide report with a
scope-limited and often empty one, exit 0, and leave tier 2/3 judging a handful
of readings while believing they had the sweep. The tier-2/3 commands echo the
report's scope header but neither refuses nor warns about its scope. Consume the
sweep's report promptly, though: both `refresh-connections` and
`refresh-tensions` reject a report whose readings were rewritten after it was
generated.

### Refresh exit codes

`ops corpus refresh-neighbours` distinguishes work the *operator* owns from work
a *reading* owns, so a nightly schedule can alert on one and file the other:

| Code | Meaning | Who acts |
|---|---|---|
| 0 | Nothing outstanding. | nobody |
| 1 | Real work left undone, and the marker did not move past it: a configuration failure (above), a failed similarity query, or a failed snapshot write. | operator, re-run, or fix the connection first |
| 2 | Usage error: an unknown flag or a missing `--tenant` (the dispatcher), or a refusal of the same shape from the command itself, `--execute` without `--sole-writer`, `--since-last-run` with `--full`, `--tenant global`, a non-integer `--limit`. | operator, fix the invocation |
| 3 | The pass itself completed, but specific readings need a human: no stored vector, or rows that fail `ManifestSchema`. | someone, repair those readings (`corpus recover`); re-running changes nothing |

The line between 1 and 3 is whether re-running the same command could help. It
can after a 1 and cannot after a 3, which is why a 3 is not a page: on a pass
eligible to advance the marker, the ids are carried under `unmeasurable_ids` and
every later pass retries them. The exit line says whether the marker actually
moved, because the passes that never advance it, a plan pass, `--only`, a
truncating `--limit`, an invalidation arriving mid-pass, can all exit 3 too.

The codes apply in plan mode as well as under `--execute`; a dry run reports
what it found. A scheduled run therefore wants the `case` below rather than a
bare `if`: a pass whose only complaint is an unmeasurable reading, no stored
vector or rows failing `ManifestSchema`, exits 3 in either mode (or 1 if the
sweep measured nothing at all). A wrapper that pages only on 1 does not page
for it, which is the point: it is a ticket, not a page.

There is no cron wrapper script in this repository, and nothing in git schedules
a refresh pass, the nightly and weekly invocations above are scheduled by the
operator, directly, so a scheduler wanting this distinction has to make it itself (the same `case`
serves the weekly `--full` sweep):

```sh
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --since-last-run --execute --sole-writer
case $? in
  0) ;;            # clean
  3) file_ticket ;; # specific readings need repair; the pass itself was fine
  *) page ;;        # 1 (re-run or fix infrastructure) or 2 (bad invocation)
esac
```

`refresh-connections` and `refresh-tensions` keep the plain 0/1 contract. Every
non-zero cause they have, a planning read that failed, a judgement that failed,
a write refused because the reading changed since it was planned, and a
`--max-backoff` ceiling, is a re-run-or-fix case, which is code 1 under the
same rule. Code 3 stays reserved in those two commands rather than mapped onto
their nearest analogue (a live reading that is invalid at plan time), because
that condition currently shares one `planningFailed` flag with transient read
errors, and splitting it is a separate change.

`ops corpus refresh-connections` consumes that report and rejudges only the
flagged readings. Plan mode validates the report tenant and every live target,
prints the provider/model/effort, each selected judgement, and estimated
synchronous cost, then exits without a provider call or storage write. Both
tier-2 and tier-3 passes echo the report's scope header (`Scope: incremental
(12 reading(s)), …`, `Scope: full, …`, or `Scope: unstated` when the report
carries no header). Missing is not inferred as full: pre-header
`refresh-neighbours` already accepted positional IDs and `--limit`, so a
header-less report may be a hand-picked or capped subset.

```sh
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report.json

# Start with a controlled production write after pausing and draining every
# corpus writer for the selected tenant.
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report.json \
  --execute --sole-writer --limit 1
```

Execute mode reads the target's stored summary and judges it only against live,
ready neighbours carried by the report. It drops provider ids outside that
set, preserves an existing connection object when the provider reaffirms its
id, and replaces `connections`, `novelty_verdict`,
`connections_computed_at`, and `connections_neighbourhood_ids`. Each write is
one transaction that locks the reading's row and re-reads it under that lock,
comparing it against the version the planning read returned; execute re-reads
nothing itself, so a reading that changed between the plan and the write is
refused rather than overwritten. The judgement is made before that write, so a
refusal is a judgement already paid for and thrown away, a run of them is a run
of wasted spend, not just wasted writes. Under `--sole-writer` nothing should
change in that window. The novelty verdict is a column of the same row, so it
lands inside that transaction with the relationships it was judged beside:
there is no second document to flush and nothing that can disagree with it.

A judged reading is its own resume marker: a rerun with the same report costs
nothing for the readings a previous pass finished. `--limit` caps judgement
actions. Provider errors and refused writes leave the reading ready and never
blind-write over newer state. A connection naming a reading deleted while the
judgement ran is dropped inside the transaction and reported
(`skipped connection target rd_… : no longer exists`), so no refresh needs
`corpus purge-connections` run behind it. The price estimate uses a four-UTF-8-bytes-per-token
approximation, a 256-output-token assumption, and the dated price table printed
by the command; it is a planning estimate, not a bill. Execute mode admits
each judgement against the spend caps, billed to `--billing-tenant` (default a
real `--tenant`; see [paid spend](paid-provider-spend.md#synchronous-operator-clients)),
and prints the
tokens the provider reported for each judgement and a run total (`Usage: …`),
counted as soon as the call returns so a judgement that is billed but then
fails to write still appears. The reasoning column is the reasoning share of
the output count, not an extra charge on top of it; OpenAI breaks that share
out, Anthropic does not, so the column is shown only for OpenAI. The input
column excludes Anthropic cache reads and writes, which are billed on top of
it.

Execute mode runs several judgements at once. `--concurrency <n>` sets how
many, defaulting to 4, the ingest queue runs at 3 against the same provider
account, so this is deliberately close to it, and refusing anything above 16,
so a mistyped flag cannot fan a hundred paid calls at that account. Results are
collected and printed in plan order however the calls complete, and every
counter (`Judged`, `failures`, `Usage:`) is folded in that
same order, so a run's output and its exit code do not depend on which call
returned first. The lines that are not in plan order are the rate-limit pause
and the backoff ceiling below, which print when they happen because that is the
point of them. The cost of that ordering is that a finished action's line waits
for the ones planned before it, so a single slow call holds back the lines
behind it; the `Timing:` block at the end is still what separates a slow pass
from a hung one. Pass `--concurrency 1` for a strictly sequential pass, the
rate-limit backoff below still applies.

Two things the pass does not do concurrently. It never has two judgements
holding the same reading at once, in `refresh-tensions`, where a reading sits
in several pairs, an action waits until every reading it writes is free, so
concurrency cannot manufacture a lost CAS or pay for a judgement it then throws
away. And when a judgement comes back rate limited, the whole pass backs off
together. The judge's own retry never covers a 429, it retries 5xx and network
faults, and turns the first 429 into a typed error immediately rather than
sleeping inside the provider call, so this backoff is the only thing pacing a
rate limit: no worker *starts* another judgement until the provider's
`Retry-After` has passed (defaulting to 8 s, capped at 60 s so a wild header
cannot park a sole-writer window). Calls already in flight when the window opens
still finish, and are still billed. The pause prints as `provider rate limited;
pausing new judgements for …`. Workers wake together at the end of a window, so
a limit that is still in force costs one more round of 429s before the next
pause.

The action that hit the limit gets one more attempt, once that window clears. A
429 is usually a queue that has moved on by the time the window is over, so the
retry is what keeps a transient limit costing the pass a pause rather than a
reading. A second 429 on the same action is not a blip: it is counted as a
failure, exactly as a sequential run would have counted it, and never retried a
third time. The run does not abort, and it does not silently re-bill an action
that succeeded.

The total time a pass will spend waiting out limits is bounded by
`--max-backoff`, which defaults to `10m` and takes a duration (`600s`,
`600000ms`, `20m`; a bare number is seconds).

**`--max-backoff` accepts `30s` to `30m`, inclusive; anything outside that range
is a usage error (exit 2).** Below the floor the pass would stop on the first
limit it met, since one honoured window already costs up to 60 s; above the
ceiling the budget has stopped bounding the sole-writer window it exists to
bound. Both ends catch the same unit confusion: `10` is ten seconds, `600m` is
ten hours. A cron entry carrying a larger value such as `2h` fails at parse
time rather than running unbounded.

What counts against it is the
window each limit opens, not each worker that reports one, so a whole round of
workers walking into the same wall is a single charge, and a limit landing
inside a window already open costs nothing at all. It is charged when the
window opens rather than measured as it is served, so a pass whose workers were
mid-call for part of a window is charged more than the wall time it actually
lost; the budget bounds the stall from above. When the next window would
overrun it, the pass stops dispatching judgements: it prints `the next backoff
would pass this pass's … rate-limit ceiling`, lets the judgements already in
flight finish and write their results, reports every judgement it did not reach
as `skip …: backoff ceiling reached before this action ran`, and exits
non-zero. That is what keeps a hard-limited provider from sitting on a scarce
sole-writer window for the length of the plan. The skipped judgements were
never touched, so a rerun when the provider is quieter picks them up unchanged.

The budget is cumulative for the whole pass and nothing resets it, so a long
pass against a provider that limits intermittently can reach the ceiling while
still making progress between windows. That is deliberate, the bound is on how
much of the sole-writer window a pass may spend waiting, not on how badly it is
being limited, but it is the case to raise `--max-backoff` for, up to its `30m`
ceiling. A pass that still cannot finish inside that is one to split with
`--limit` and resume when the provider is quieter, not one to park on the
sole-writer window for hours.

The ceiling bounds the paid work only, on the same rule as `--limit`: an
integrity repair makes no provider call and cannot be rate limited, so the pass
still runs the free work behind the ceiling before it exits.

Ctrl-C is safe at any point: every write is a committed transaction, and a
rerun resumes from the readings.

Because the calls overlap, every `Timing:` row a concurrent action produces, `provider`, `reading write`, and for `refresh-tensions` `reading read`, sums
the call durations rather than the wall time they occupied, the same way
`planning reads` already did, so under `--concurrency` a row can exceed the
run's own total. The `total` row is the one to compare between runs.

Run a fresh neighbour refresh immediately before this command. The report must
name the same `--tenant`; a mismatched selector is refused. The sole-writer
window must cover the provider calls and the writes that follow them. The
command also refuses the report if a target or candidate neighbour was
reprocessed after the report was generated.

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
npm run ops -- corpus refresh-tensions --tenant "$TENANT" --report ./refresh-report.json

# Hand-pick a pair known to conflict. With --pair the report is read only
# when --report is passed explicitly.
npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --pair rd_older,rd_retraction --execute --sole-writer
```

Execute mode makes one pairwise provider call per selected pair and writes
each side's directional entry, `contradicts` (symmetric), `supersedes` /
`superseded_by`, `qualifies` / `qualified_by`, always from that reading's point
of view with one shared reason, plus a `tensions_judged` record to BOTH
readings — in ONE transaction, which locks the two rows in sorted id order
before reading either and is guarded on the versions the planning reads
returned; only a side an earlier action in the same pass already wrote is read
again. A pair therefore never lands half-written, and two passes judging the
same pair from opposite ends cannot deadlock. (The one-sided repairs remain,
for pairs left half-written before that was true and for entries naming a
deleted partner; they cost no paid call.) A `none` verdict removes any prior
entry for the pair and is remembered so the pair is not re-judged nightly. Only
`tensions` and `tensions_judged` change; `updated_at`, connections, and every
summary field stay untouched. `--pair` bypasses
the overlap filter and the judged skip but both sides must still be live ready
manifests. `--limit` caps paid judgements only; free repairs always run.
`--concurrency` and `--max-backoff` work as they do for `refresh-connections`
above, including the rule that two actions touching the same reading never run
at once.
Execute mode prints the provider token usage of each judgement and a run total
on the same terms as `refresh-connections` above.

A pair left one-sided (written before both sides shared one transaction) is
reported as such, and the next run mirrors the inverse entry to the other side
without a paid call as long as that side has not been reprocessed since the
judgement. A partner reprocessed since (its `updated_at` is newer
than the entry's `computed_at`) makes the stored judgement stale: the entry is
dropped, and the pair is re-judged when the report next pairs them. An entry
whose partner is not a ready list row (deleted, in practice: a ready reading
does not normally regress to failed or pending, and one that comes back ready
is rebuilt without tensions and must be re-judged anyway) is purged from the
holder together with its judged record, so tier 1 stops flagging the holder.
`DELETE /api/readings/:id` leaves inbound tensions alone (`ops corpus
purge-connections` removes them with the connections); until a purge or the
next tension refresh removes them, tier 1 flags each
holder `stale_connection` and `refresh-connections` spends one relationship
re-judgement on it. Run `refresh-tensions` in the same window to keep that to
one call per holder. A successful reprocess republishes a reading without its
tensions on purpose. The partner keeps its entry until a report or `--pair`
brings the two readings into a run again: tier 1 flags neighbourhood drift,
not summary changes, so that can take a while, and the pair is re-judged only
when the report pairs them. A failed reprocess keeps the tensions but still
bumps `updated_at`, so that reading's pairs are re-judged once at the usual
cost. Repairs are found among the readings the report or `--pair` names, not
by a corpus-wide scan. A stale report (any reading it names was rewritten
after it was generated) is refused even when `--pair` names the drifted
reading; regenerate it or omit `--report`.

### Purging connections to a deleted reading

`ops corpus purge-connections` is the explicit offline cleanup for inbound
relationship rows that still name one deleted reading. `reading_relationships`
has a foreign key on the source only, so deleting a reading cascades away the
rows it cites but leaves every row that cites IT. `DELETE /api/readings/:id`
deliberately does not clean those up, so a reading-detail link may return 404
until an operator runs this. Cleanup is not automatic.

```sh
# Production founder namespace. Resolve $TENANT from whoami first.
npm run ops -- corpus purge-connections --tenant "$TENANT" --id rd_deleted

# Apply. Pause and drain the realtime writer first.
npm run ops -- corpus purge-connections --tenant "$TENANT" --id rd_deleted --execute --sole-writer
```

`--execute` requires `--sole-writer`. A publish already in flight can commit a
relationship naming the deleted target after the `DELETE` takes its snapshot,
and no single statement can exclude it — a publisher whose transaction opened
before the `DELETE` and commits after any verification read is invisible to
both. Only a paused, drained writer makes the purge verifiable. After deleting,
the command re-reads the inbound count as a check on that assertion: leftovers
are reported with `failure_code: "concurrent_writer"` and the command exits 1.

The target id must be absent from the selected tenant's readings: the command
refuses a target that still exists, and refuses a malformed reading id before
it connects. `--tenant global` is refused too — it names the pre-tenant R2
layout, which has no rows.

The relationship is a row keyed by `target_id`, so the purge is one `DELETE`
statement rather than a rewrite of the documents that cite the target.

**It deletes judged tensions as well as connections.** Both dangle the same way
when their target is deleted, and both live in `reading_relationships`. The
audit reports `tensions_matched` separately, and the command warns on stderr
when that count is non-zero, because tensions cost provider spend to produce.

The single-line JSON audit reports `mode`, the tenant selector (and
`tenant_audit_stamp.tenant_id`), `target_id`, `relationships_matched`,
`sources_matched`, `tensions_matched`, `relationships_would_delete`,
`relationships_deleted`, and `failures`. Failures also include a bounded
`failure_code` (`invalid_target`, `target_present`, `storage_error`) and
`failure_stage`; credentials and driver messages are never copied into the
audit or error stream.

`ops corpus recover` has two execution paths: `--wave` paces realtime
submissions through `POST /api/readings/:id/reprocess`, and `--batch` routes the
same work through the offline provider Batch API path described below.
`DestinationResolutionError` is reprocessed once after the originating attempt, then skipped — the resolver cannot tell a dead name from a blip.

```sh
npm run ops -- corpus audit --tenant "$TENANT" --execute      # writes index.json + INDEX.md
npm run ops -- corpus recover --tenant "$TENANT" --index ./index.json --execute
```

### Redacting key fragments in stored errors

Before reading-lite-gh341.1, provider error text was stored verbatim, and
OpenAI's 401 echoes a masked piece of the rejected key (`Incorrect API key
provided: sk-proj-****wxyz`). New writes are redacted; rows written before then
keep the fragment, and the reading API, MCP, the frontend and
`GET /api/readings/:id/diagnostics` all serve it. `ops corpus redact-key-echoes`
applies the same `redactProviderKeys` to the rows already stored.

```sh
# Plan: list every affected row and field, printing only the redacted text.
npm run ops -- corpus redact-key-echoes --tenant "$TENANT"

# Apply, then re-scan; exits 1 if any row still matches.
npm run ops -- corpus redact-key-echoes --tenant "$TENANT" --execute
```

It scans `readings.error`, `active_attempt`, `last_attempt` and
`enrichment_degradation`, and each `reading_attempts` row's `error` and
`events`. `--execute` rewrites one reading per transaction under its row lock,
so it needs no `--sole-writer`, and changes no status, ownership, content or
`updated_at`. A reprocess would replace only the reading's own error, never the
attempt history, and pays for a summary to do it; recovering a reading that
failed on a rejected key is a separate `corpus audit` and `corpus recover` pass.
The redaction fails safe, so a fetch error naming an `sk-` host is redacted too.

### Purging the manifest-era layout (reading-lite-gh351.5)

Done and retired. `ops corpus purge-legacy` deleted the manifest-era objects no
row referenced (manifests, attempt logs, `processing/` checkpoints, the
`index/` list, pointers, tombstones and refresh marker, superseded
legacy-spelled content and orphan prefixes) from every tenant root on staging
and production on 2026-09-26, and was removed in reading-lite-gh351.7. The
counts and checks are on reading-lite-gh351.6. Imported readings that no
attempt has touched still serve their legacy-spelled `raw.{ext}` /
`extracted.md` under `key_prefix`; those objects are referenced and stay.

### Founder corpus migration (s1k.6)

**Completed; tooling retired.** Production cutover finished on 2026-08-31,
with counts/hashes, tenant paths, vectors and connections reconciled. The
[cutover report](founder-cutover.md) preserves the procedure and acceptance
record. The one-time `ops corpus migrate-founder` command, its planner/state
module and dedicated tests have been removed from the supported CLI. The
[last pre-retirement implementation](https://github.com/brian-bell/reading-lite/blob/b74a9b69af96b7101300d974e808e91ba34abdf9/scripts/ops-lib/commands/corpus-migrate-founder.ts)
and its tests remain available in Git history for historical recovery analysis.

New environments start with tenant storage. Rebuilt environments need their
restored tenant data verified before activation; the [activation guard](#tenant-mode-activation-guard)
remains. Retiring this command does not delete retained legacy data, remove the
`TENANT_DATA_PLANE` gate, change schema migrations, or remove general corpus
repair tools. A future migration needs its own scoped design,
tests and rehearsal, not a recurring founder-cutover release check.

### Library export and import (reading-lite-gh348)

Retired in reading-lite-gh351.4. `ops migrate export` and `ops migrate import`
moved a tenant's library and the whole control plane from the legacy stores (R2
manifests and pointers, the D1 control plane, Vectorize) into PostgreSQL. The
production import ran on 2026-09-24 ([record](postgres-cutover.md#production-cutover-record-2026-09-24)),
and rollback to the legacy stores is no longer supported, so the commands had no
job left. Their source is in git history before reading-lite-gh351.4; the
mapping decisions are in [ADR 0005](decisions/0005-postgresql-storage.md#importer-decisions-reading-lite-gh348).
Restores use `pg_dump` archives: the cutover dumps and a post-cutover dump were
verified restorable on reading-lite-gh351.1.

### The extract-agent

The Worker enforces per-hop scheme, DNS-vs-private, redirect, size, and time
limits on every extraction fetch. Cloudflare private-egress blocking is not
that contract. Some sites still hard-block datacenter egress, so
`fetch_source` fails where a residential IP succeeds. `ops extract agent` is
operator-local recovery: it polls the reading API for `fetch_source`-failed
readings and re-extracts them locally, an SSRF-guarded static tier with
browser headers, falling back to a headless Playwright render when the static
tier is challenged or finds no real article, plus an anonymous Reddit
thread-JSON path. Playwright is not in the hosted product path. Successful
markdown re-enters through `POST /api/readings/import-markdown`.

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
  --folder "Computing/AI/MCP" --url https://readinglite.ai/api/readings
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
them. The Worker also dedupes through its per-tenant URL ownership
(`reading_urls`), so deleting the local index is safe, it just re-POSTs every URL once to rebuild it.

### Local markdown

Imports `.md` files without re-fetching their source URLs. Each file must carry
a source line:

```md
**Source:** https://example.com/article
```

That URL becomes the canonical reading URL and the body is sent to
`POST /api/readings/import-markdown`. Duplicate files sharing a source URL are
collapsed before submit, the largest file wins. Imported readings store the
markdown as both raw content and `extracted.md`, then reuse the normal
embedding, similarity, summary and publication pipeline.

```sh
npm run ops -- import markdown --dir ~/Documents/articles           # plan, no token needed
npm run ops -- import markdown --dir ~/Documents/articles --execute  # local dev
npm run ops -- import markdown --dir ~/Documents/articles --execute \
  --url https://readinglite.ai/api/readings/import-markdown
```

`--url` is the full import endpoint; token resolution matches the other scripts.
Files above the Cloudflare Queues 128 KB message limit are blocked before any
POST. Successful new/existing responses are recorded in
`.import-markdown-index.json` (scoped by destination URL) and move every file
for that source URL into a `processed/` subdirectory. The CLI accepts `--email`, but hosted import delivery is always silent;
the send-time policy ignores notification requests for imports.

### Provider Batch APIs

`import-markdown` summarizes every file **realtime** through the Worker queue.
For large backfills, `ops corpus ingest` runs the same directory through the
configured provider's **Batch API**, and `ops corpus recover --tenant "$TENANT" --batch` does the same
for readings already in the corpus. Both use the bucket-paired direct PostgreSQL
connection for reading state and `CORPUS_R2_*` credentials for captured bytes.
Source `NEON_MAIN_DATABASE_URL` (production) or `NEON_REHEARSAL_DATABASE_URL`
(staging), or use the paired deployment variable. `--database-url-env` selects
an accepted variable explicitly. Both need `OPENAI_API_KEY` for embeddings;
`ANTHROPIC_API_KEY` is needed only to start or resume an Anthropic batch.
`--execute` requires the applicable
credentials; a dry run can show a local plan without them. There is no
cross-provider fallback. PostgreSQL batches require a tenant id and refuse
`--tenant global`.

```sh
# dry run (default): print the plan; with creds it also shows ownership skips
npm run ops -- corpus ingest --tenant "$TENANT" --dir ~/Documents/articles

# for real — confirm the realtime writer is paused/drained first
npm run ops -- corpus ingest --tenant "$TENANT" --dir ~/Documents/articles \
  --execute --sole-writer --bucket reading-lite
```

The resulting readings have the same contract as realtime imports, including
`source_type: "markdown"`, captured content and embedding usage. Activation
writes fresh content under the attempt's immutable R2 revision prefix, then
commits URL ownership and the offline attempt. It creates no realtime queue
job. Terminal publication atomically commits the reading, revision, content
references, relationships, embedding and terminal attempt summary. Failed
recovery preserves the current publication and its content and embedding.
Legacy sidecars without attempt identity can write only a vacant pending row;
they never adopt a newer attempt or recreate a purged reading.

**`--sole-writer` is enforced, not assumed.** `ops corpus ingest --tenant "$TENANT" --execute` and
`ops corpus recover --tenant "$TENANT" --batch --execute` refuse to submit without it. Both batch paths
eagerly claim by-url slots (recover via a failed→pending flip that keeps its
claim on failure, so the URL stays re-submittable), but that claim is
defense-in-depth rather than a replacement for pausing the realtime writer. An
acknowledged run prints a loud banner before any submit; dry runs submit nothing
and never require the flag. The enforcement lives in
`scripts/corpus-lib/sole-writer.ts`.

**Idempotency** uses tenant-scoped `reading_urls` ownership. Fresh ingest skips
ready and pending owners, retries failed owners in place, and mints an id only
for an unclaimed URL with no existing reading. A failed ingest keeps its URL
claim as a failed owner, so a later ingest or reprocess retries it in place; a
reading left without a claim by an older batch run is found by URL and its id
reused.
Activation revalidates ownership transactionally. Interrupted publication retains
the submitted sidecar, and resume skips already committed attempts before
embedding. R2 receives no manifests, pointers or list index.

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
same request body as realtime (`low`, `medium`, or `high` on Claude Sonnet
5.5; invalid values fail closed before submit). OpenAI's pre-submit upload/create phases are
persisted, a companion `<sidecar>.input.jsonl` holds the exact JSONL bytes,
written before the `uploading` checkpoint. On resume the reconciler adopts what
already exists: remote files by filename (`reading-lite-${runId}.jsonl`), remote
batches by `metadata.run_id`. A sidecar-scoped file lock serializes the initial
upload/create transition against any later resume.

The expensive `create` step is deliberately **fail-closed**: a list-then-create
cannot distinguish a successful-but-lost-response prior create from a failed one
(the OpenAI Batch API has no idempotency key, and listing can lag), so an
ambiguous match or no visible remote batch at the create step aborts and asks
for a manual reconcile. Anthropic pre-submit and OpenAI `activating` sidecars
also require manual reconcile. If a batch request fails, the write phase
commits the target as failed (a published reading keeps its publication) and
leaves its URL claim in place.

**Spend.** `--execute` admits each provider batch against the payer's and the
global daily spend caps before the first pending sidecar, and settles it from
the downloaded results. The payer defaults to `--tenant`. A resume settles against the
tenant its sidecar recorded and refuses a different `--billing-tenant`. The
authority follows `--bucket`, so a bucket with no mapped environment cannot
execute. A budget denial writes no sidecar; rerun once the cap allows it. A
resume after the operation record's retention (admission day plus one UTC day)
logs the maximum as permanently held and still writes its results. See
[operator provider batches](paid-provider-spend.md#operator-provider-batches).

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
**existing production readings**, use the compare-summary-effort skill, not
`ops eval summarizer` (that is the fixture-based quality matrix).

```sh
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
  --target rd_EXAMPLE \
  --target 'https://example.com/article' \
  --model gpt-5.6-luna \
  --effort max
```

Plans by default (prints the readings × candidates matrix and a conservative
cost ceiling). `--execute` is the only paid path and requires `--env` and
`--billing-tenant`, whose spend caps admit each request. Production is GET-only: no
`/reprocess`, no reading or embedding writes, no wrangler or production config
change. Anthropic effort is optional; omit `--anthropic-effort` to run Sonnet
once with no effort field. See `.agents/skills/compare-summary-effort/SKILL.md`.

## Sources that need a local skill

### Reddit

Reddit serves a bot challenge to datacenter egress, so the Worker cannot fetch
thread JSON, `POST /api/readings` with a `reddit.com` / `redd.it` URL
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
from the public oEmbed metadata (title + author, the reliable floor), plus a
best-effort description (from the page's `ytInitialPlayerResponse`) and
transcript (the first caption track) when YouTube serves them. Unlike Reddit the
URL summarizes to `ready` directly, but in practice the Worker is usually blocked
from the watch page and lands the floor only. When watch-page or transcript
enrichment misses with a non-terminal fetch-guard error, the ready reading
records `enrichment_degradation` (tier + redacted reason) on its row, which
the detail and list responses both carry. List those candidates with:

```sh
npm run ops -- corpus audit --tenant "$TENANT" --degraded
```

Do not reprocess them through the Worker — the same enrichment wall will fire.
For a full extraction, description plus transcript, run the
**`youtube-import`** skill locally, which fetches the watch page from your
residential IP and uses `yt-dlp` for the transcript, then imports the rich
markdown through the same parsers the Worker uses. Requires `yt-dlp` on PATH.

```sh
npm run ops -- import youtube "<youtubeUrl>" --execute   # omit --execute to preview
```

## Seeding local data

To exercise the read path or the frontends against real data locally, stop
`wrangler dev`, seed, then start `npm run dev` again.

The fixture pack from [issue #366](https://github.com/brian-bell/reading-lite/issues/366)
seeds every accepted reading state (ready baselines with connections and
tensions, sparse archive, unavailable source, degraded YouTube, old manifest,
long title, imported Markdown, pending, stalled pending, two threads, and one
failed reading per failure category) and a staged inbox with one command, in
the state names Phase 3 slices cite:

```sh
npm run seed:local
```

It writes both halves of each reading:

- **Rows in [local Postgres](#local-postgres)**, which is what the Worker reads
  for list, detail, lookup, `q` search, similarity and diagnostics. They go
  under the local founder's tenant id with deterministic vectors and each
  fixture's attempt log, through the same manifest-to-rows mapping the runtime
  uses. The tenant's existing reading rows are deleted first, so a reseed drops
  any other local reading. Its inbox items are replaced the same way.
- **Content objects in local R2** (`extracted.md`, `raw.{ext}`), which
  `/content` and `/content/raw` read. They are written by
  `wrangler r2 object put --local` into the same on-disk store
  `.wrangler/state/v3/r2` that the dev server binds (verified against
  wrangler 4.130). Local dev leaves `TENANT_DATA_PLANE` unset, so the keys are
  global-rooted; do not seed under `u/<tenantId>/`.

Content goes first, then the rows that point at it. The seeder verifies by
counting the tenant's readings, attempts, vectors and inbox items back from
Postgres. It writes no manifests, pointers or `index/list.json`: reading state
is rows.

The command is idempotent. Re-run it to refresh the pending fixture once it
passes the 15-minute pending TTL, and to restore the pack after deleting
readings while testing. To reset local R2 too, stop the dev server and run:

```sh
rm -rf .wrangler/state/v3/r2 && npm run seed:local
```

Then start `npm run dev` again. Accounts and sessions live in local Postgres
and are untouched.

To add a reading, add it to the fixture pack (`test/fixtures/local-seed.ts`
and [the fixture-pack design](design/connected/fixture-pack.md)) rather than
writing objects by hand: a hand-written manifest or list row is invisible to
the Worker, and a hand-inserted row needs its content objects at the row's
`key_prefix` for `/content` to serve anything.

## Local Postgres

The storage migration ([ADR 0005](decisions/0005-postgresql-storage.md)) adds
PostgreSQL 18 with pgvector 0.8.x beside R2. It holds every reading and
control-plane row, so the Worker test suite, `npm run dev`, and
`npm run seed:local` all need one. Tests never connect to Neon.

The supported local server is the docker-compose `postgres` service
(`pgvector/pgvector:0.8.1-pg18`), published on host port **54329** so it cannot
collide with a Postgres you already run:

```sh
docker compose up -d --wait postgres   # npm run dev does this for you
docker compose stop postgres           # data persists in the postgres_data volume
docker compose down -v                 # also deletes it
```

| Who | Database | How it connects |
|---|---|---|
| `npm run dev` | `reading_lite` | `dev:setup` starts the service, runs the migration runner, then bootstraps the founder here. The Worker's `HYPERDRIVE` binding uses `localConnectionString` in `wrangler.toml`. |
| `npm run seed:local` | `reading_lite` | After writing the content to R2 it migrates, then writes the fixture pack as rows (readings, attempts, deterministic vectors, inbox items) for the local founder's tenant id. Re-running replaces the pack's rows. |
| `npm test` | `reading_lite_test_<hash>` | One database per checkout, named from its path, so worktrees never truncate each other's rows or trip migration drift. Vitest globalSetup creates and migrates it once per run and truncates the reading tables. `vitest.workspace.ts` always sets the workers pool's Hyperdrive string to this database, whatever the shell exports. Without Postgres the run fails fast with one line. |
| CI Worker jobs | `reading_lite_test` | A service container in each of the two jobs (Workers pool, Node pool); `TEST_DATABASE_URL` points the job's pool at it. |

To use your own server instead, set `READING_LITE_DATABASE_URL` (shell or
`.dev.vars`) for `npm run dev` and `seed:local`, and `TEST_DATABASE_URL` for
tests. Dev setup then starts nothing. It is deliberately not `DATABASE_URL`,
which many shells already export for another project: dev setup migrates and
seeds whatever this names. The Worker does not read it: also export
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` with the same value,
or `wrangler dev` keeps using port 54329. Two checkouts cannot both publish
port 54329; run the service from one of them, since they can share it.

Migrations live in `db/migrations/` and are forward-only. Plan first,
against a **direct** connection string, never a Hyperdrive one:

```sh
DATABASE_URL=postgres://reading_lite:reading_lite@127.0.0.1:54329/reading_lite \
  npm run ops -- db migrate              # lists applied and pending; changes nothing
set -a; . ~/.config/reading-lite/neon.env; set +a
npm run ops -- db migrate --database-url-env NEON_DEV_DATABASE_URL --execute
```

The runner refuses when an applied file has changed or disappeared, so never
edit an applied migration; add the next number. On a local database the fix
for drift from branch-hopping is `docker compose down -v` and a fresh start.

Under `--execute`, `ops deploy worker` refuses a Hyperdrive binding whose id is
still a placeholder (`scripts/ops-lib/hyperdrive-binding.ts`). Create
Hyperdrive configs with query caching disabled; see the ADR.

## Paid-work policy and accounting

Use `npm run ops -- system status --env staging|production [--tenant usr_…]`
to inspect policy and charged spend. `system policy` plans changes by default;
writes require `--execute --acknowledge-guard-version <current row version>`
and production also requires `--confirm-production`. See
[the paid-work operator runbook](paid-provider-spend.md#operator-policy-and-accounting)
for setup, exact commands, version/retry semantics, and accounting limitations.
Paid operator commands bill `--billing-tenant` through the `OperatorSpend`
entrypoint; the [dispatch inventory](paid-provider-spend.md#operator-dispatch-inventory)
lists each one and its payer.

## Orphaned in-flight processing leases

A Worker death can leave tenant and global `inFlight` slots occupied because
the expiry sweep does not delete them. A terminal/purged redelivery recovers
leftovers automatically. An incomplete attempt reaches recovery after the
24-hour defer ceiling only when its lease heartbeats are overdue. Recovery
retires the attempt before freeing its slots, so a delayed delivery cannot
restart it in the window before the failed reading is written. Unconfirmed
cleanup requeues even when the reading is already terminal. Only confirmed
cleanup logs `processing_lease_orphan_released` with tenant, attempt and reason.

For an orphan with no redelivery left, or before the ceiling runs out, use
`npm run ops -- system lease-clear --env staging|production --tenant usr_… --attempt <attemptId> [--execute]`.
Find the attempt and rows with `system status --env … --tenant usr_… --details`:
lease records carry `attemptId`, `tenantId` on global rows, and
`heartbeatOverdueMs`. The command plans by default; `--execute` re-observes and
submits the expected expiries through the service-binding-only
`OperatorLeaseClear` entrypoint. The read-only `OperatorStatus` never mutates,
and `OperatorSpend` reaches only the four spend verbs.
Observations and responses contain no dispatch fences or reading content.

Both automatic and operator recovery use the global guard's `recover_leases`
authority. It checks global state and conditionally retires the tenant under
the global lock, then deletes global capacity. A renewed row refuses with
`changed`, a fresh row with `not_overdue`, and a paused row with
`not_in_flight`; the other side reports `peer_refused` and is not deleted.
Unavailable responses return exit 1. Re-run after a partial failure: a retired
tenant with a global leftover remains recoverable. Absent rows converge.

Retirement persists a small attempt-ID marker until tenant teardown and
prevents reacquisition of that attempt. The next queued delivery records the
attempt as failed; if no delivery remains, use the normal reading reprocess
workflow to create a new attempt. This command does not resume paid work or
cancel a provider request already sent. It requires the updated Worker;
older deployments fail closed.

## Archive export queue plumbing

`ARCHIVE_EXPORT_JOBS` (reading-lite-mxwx) uses dedicated queues
`reading-lite-staging-export` / `reading-lite-staging-export-dlq` and
`reading-lite-export` / `reading-lite-export-dlq`, shared by every tenant.
`ops staging setup` and `ops staging teardown` manage the staging pair.
Wrangler does not create queues on deploy, so provision the production pair
before the first Worker deployment that binds them:

```sh
npx wrangler queues create reading-lite-export
npx wrangler queues create reading-lite-export-dlq
```

The archive is built under the tenant's `exports/{exportId}/` prefix, one
segment per delivery (reading-lite-mxwx.3). A delivery claims the row by
bumping `lease_seq`, packs up to 200 readings or 16 MiB from the stored
`cursor`, writes `segments/segment-NNNN` and its `state-NNNN.json` to R2, then
commits the cursor only if `lease_seq` is still the one it claimed, and sends
itself the envelope. A delivery that lost the lease logs
`archive_export_lease_held` and acks. After the last reading, one more
delivery writes the closing files, `central`, and `eocd`, and marks the row
ready. Segment keys are fixed per sequence number so a redelivery rewrites
them; that is safe only while the consumer keeps `max_concurrency = 1`.

`continuations` counts the self-sends; past `ARCHIVE_EXPORT_MAX_CONTINUATIONS`
(65,531, one per reading a ZIP32 archive can hold plus the hand-off to
finalize) the delivery throws, the message dead-letters, and the export fails.
The `*/15` cron re-enqueues a queued or building export whose `updated_at` is
older than 30 minutes (a lost continuation or message). The DLQ marks a queued
or building export failed and then deletes that prefix; a database or R2 error
retries the dead letter instead of acknowledging it. A ready export keeps its
parts. A failed export does not count toward the daily limit, so the account
can request another at once.

A ready export expires seven days after it finished (`expires_at`). From then
the download returns 410 `{"error":"expired"}`, and the same `*/15` cron marks
the row `expired`. It deletes the prefix six hours later
(`ARCHIVE_EXPORT_DOWNLOAD_GRACE_MS`), so a download that started just before
`expires_at` can finish streaming, and clears `segments` only once the delete
succeeds. An `expired` row past that grace with `segments` still set is a
delete that failed (`archive_export_expire_failed`); a later tick retries it.
Each tick touches the rows it tries and takes the least recently touched
first, so a delete that keeps failing moves behind newer expiries rather than
blocking them. A row whose `tenant_id` does not parse is logged once with
`reason: "invalid_tenant_id"` and its `segments` cleared: a build writes parts
only under a parsed tenant matching the row, so there is nothing to delete.

Account deletion (reading-lite-mxwx.4): `beginAccountDeletion` cancels a queued
or building export after the `deleting` fence, and again when rerun. A delivery
re-reads `users.status` when it claims the row and before it writes a segment,
and marks the export ready only under `users FOR SHARE` with the account
active; otherwise it cancels the row and deletes the prefix. A segment that
races past those checks loses its commit to the cancel, and the delivery then
deletes the prefix itself. If that delete fails, the segment stays under
`u/{tenant}/exports/`, which the wipe's objects phase lists, so the late object
reopens a finished wipe. Teardown
deletes the tenant's `archive_exports` rows, and the residue scan reports
`pg.archive_exports`.

### A stuck export

A queued or building export holds the tenant's one active slot, so
`POST /api/exports` answers 409 until it ends. Don't change `status` by hand:
that leaves the parts under `exports/{exportId}/` behind, and a delivery still
holding the lease can overwrite the change. Use the export commands. Both
require `--tenant` (`/api/whoami`'s `tenant_id`), take
`--bucket reading-lite-staging` for staging, and resolve the database through
the operator-db pairing (`PRODUCTION_DATABASE_URL` or `NEON_MAIN_DATABASE_URL`,
`STAGING_DATABASE_URL` or `NEON_REHEARSAL_DATABASE_URL`). R2 access uses the
`.corpus.vars` credentials.

```sh
npm run ops -- export inspect --tenant <usr_…> [--export <exp_…>]
```

`inspect` is read-only. It prints each row's status, times, `lease_seq`,
`continuations`, cursor, `error`, and the objects under its prefix. A queued or
building row also shows how long it has been idle against the 30-minute lease.
`updated_at` moves on every delivery and every cron renewal. `lease_seq` rises
once per claim. `continuations` counts self-sends. If `updated_at` keeps
moving and `lease_seq` climbs while the cursor stays put, the export is failing
and will reach the DLQ. `error` is `dead_letter`, `zip_limit` (past 65,535
entries or 4 GiB), or `enqueue_failed` (the request committed but its first
send failed) on a failed row, and `operator_cancelled` on a row `export cancel`
ended. `inspect` also lists parts with no row, and flags a cancelled or failed
row that still holds parts.

Two paths end a stuck export on their own, so check first whether one of them
will:

- **A lost message** (a dropped continuation, or a crash between the cursor
  commit and the self-send) leaves the row idle. The first `*/15` tick after
  `updated_at` is 30 minutes old renews the row and sends the envelope again,
  so the build resumes from its cursor within about 45 minutes.
- **A delivery that keeps failing** throws, retries (`max_retries = 3`), and
  dead-letters. The DLQ marks the row `failed` with `{"code":"dead_letter"}`
  and deletes the prefix. The slot frees at once, and a failed export does not
  count toward the daily limit.

A database outage long enough to exhaust the DLQ's own retries drops the dead
letter and leaves the row building; the cron resumes it 30 minutes later.
Neither path runs if `ARCHIVE_EXPORT_JOBS` is unbound (the cron logs
`archive_export_resume_skipped`) or the cron is not firing. Fix that, or cancel
the export when the slot has to free now:

```sh
npm run ops -- export cancel --tenant <usr_…> --export <exp_…>            # plan
npm run ops -- export cancel --tenant <usr_…> --export <exp_…> --execute
```

`cancel` locks the row and changes it only from queued or building: status
`cancelled`, `error` `{"code":"operator_cancelled"}`, `lease_seq` bumped. It
commits, then deletes the prefix with the same loop the DLQ uses. A delivery
still running loses its commit, so it cannot mark the export ready. It then
deletes the prefix again, because its segment may have landed after the
command's delete. A cancelled export does not count toward the daily limit, so
the account can request another at once. On a row that is already cancelled or
failed, `cancel` leaves the row alone and only sweeps the prefix. Rerun it
after a delete that failed, or when `inspect` flags leftover parts. It refuses
ready and expired exports: the `*/15` expiry owns their parts.

In Workers Logs, look for `archive_export_lease_held` (a duplicate delivery
lost the lease, which is harmless), `archive_export_resume_failed`, and the
consumer's thrown error.

## Relationship refresh queue plumbing

Hosted processing requires Workers Paid; `usage_model: standard` alone does not
establish that subscription. Both hosted environments pin `limits.cpu_ms=30_000`.
See the [CPU diagnosis and recovery procedure](relationship-refresh-recovery.md)
before resuming a run interrupted by CPU terminations.
The weekly pass is watched by RL OpsBot's routine on the shared box.
[Relationship refresh monitor](relationship-refresh-monitor.md) holds its prompt
and recreates it from scratch. The read is `npm run ops -- corpus refresh-status --tenant <usr_…> --bucket reading-lite`.
Add `--json` for one JSON document. The command only reads. Sunday 03:07 UTC is
Saturday 10:07 PM EST or 11:07 PM EDT.

`RELATIONSHIP_REFRESH_JOBS` uses dedicated queues
`reading-lite-staging-refresh` / `reading-lite-staging-refresh-dlq` and
`reading-lite-refresh` / `reading-lite-refresh-dlq`. `ops staging setup` and
`ops staging teardown` manage the staging pair. Provision the queue pairs before
Worker deployment; the production DLQ must be created separately, like the other
production DLQs (`wrangler queues create reading-lite-refresh-dlq`).

`RELATIONSHIP_REFRESH=1` is configured in staging and production. Staging uses
`REFRESH_MAX_JUDGEMENTS=2`; production uses `REFRESH_MAX_JUDGEMENTS=150`.
`REFRESH_MAX_TENSION_JUDGEMENTS` caps tension pairs the same way: 2 in staging,
100 in production. The
owner-authorized single actual staging run passed on 2026-09-08 before
production enablement. See [staging evidence](relationship-refresh-staging.md).
Gate-off queue deliveries acknowledge and discard without storage/provider
access; the refresh cron also does nothing. DLQ deliveries log and acknowledge
without changing readings.

With the gate set to `1`, the separate `7 3 * * SUN` cron (Sunday 03:07 UTC)
starts or resumes a full scan for the active account matching `FOUNDER_EMAIL`.
`TENANT_DATA_PLANE=1` is required. The existing */15 digest/wipe cron is separate.
Each queue shard reads at most 25 readings and runs the pgvector similarity
query from each one's stored embedding; no embedding calls are made. Missing, non-ready, and purged readings are skipped.
A ready target whose `active_attempt` is still running inside `PENDING_TTL_SECONDS`
is skipped at scan time; the same in-TTL running state on a judge delivery throws
`DeferPaidWorkError` and re-enqueues that `(runAt, readingId, keyPrefix)` without
a checkpoint row. A TTL-expired (zombie) running attempt is not a terminal skip:
scan still flags the target, and the judge treats it as not running. The weekly
cap still counts a reserved judge identity, including identities later deferred
for in-TTL running. The existing offline neighbourhood-drift rules select judge
targets. All scan shards finish before any judge jobs are enqueued.

Progress lives at `u/{tenantId}/index/refresh-cursor.json`: the scan's fixed target
list, scan offset, flagged candidates, dispatch offset and weekly allowance.
Cursor writes use CAS. `REFRESH_MAX_JUDGEMENTS` defaults to `100` and accepts
integers 1–1000. The cap counts distinct reserved judge jobs per weekly budget,
not delivery attempts. Remaining candidates carry into later Sundays without
rescanning. A fresh full scan begins on a later Sunday after dispatch completes.
The scan does not read or update the offline refresh pass's run marker (the
`corpus_refresh_state` row), or rewrite similarity snapshots, readings or
vectors. The two markers are deliberately separate: this cursor is the hosted
scan's, an R2 object with its own ETag CAS, and the operator's marker is a
PostgreSQL row beside the readings it describes.

A pending batch reserves allowance before sending. Failed/uncertain sends retain
that reservation; the next scheduled invocation recovers a lost continuation.
Retries can deliver the same `(runAt, readingId)` judge identity more than once.
The judge consumer deduplicates that identity before paid work and revalidates
the tenant and reading. Pending batches keep their original allowance
until their send is confirmed. A recorded allowance for the new period then takes effect
immediately, so recovery does not skip that period. Invalid cursor data fails closed and is retained
for diagnosis rather than silently restarting a run.

Issue #175 slice 3 consumes judge jobs with the configured OpenAI or Anthropic
relationship adapter. It reads the stored summary and current floored neighbours;
it does not extract, embed, re-summarize, change status, or refresh tensions.
Tensions are the separate tension jobs described below.
Each HTTP attempt presents the shared processing leases and passes tenant/global
spend admission. Refresh does not consume a new-reading quota slot.

`relationship_refresh_jobs` holds one latest checkpoint per reading. After admission and immediately before fetch, the delivery marks
that job dispatched. HTTP retries within that delivery each receive fresh spend
admission. Confirmed 429 responses record a retry time and remain eligible for
delayed re-enqueue with fresh admission; early duplicates honor Retry-After.
Expected lease/spend deferrals also re-enqueue without consuming queue retries,
falling back to queue retry if enqueue fails. Jobs expire 24 hours after their
first deferral and leave the ready reading unchanged. Unknown
charges remain held in the spend authority. A duplicate of an uncertain dispatch
leaves the ready judgement alone;
a later scan with a newer run identity may try again. This deliberately favors
avoiding duplicate charges over retrying a job whose provider outcome is unknown.

Successful results save only a relationship patch, the hash of the resulting
reading (as its manifest projection), and the neighbour versions used as input.
Those versions must still match before dispatch, result storage, and
publication, including checkpoint replay. Publication is one compare-and-replace
under the reading's row lock that writes `connections`, `novelty_verdict`,
`connections_computed_at`, and `connections_neighbourhood_ids`, preserving
every other field. The novelty verdict the list serves is a column of the same
row, so there is no second write to reconcile. A saved result replays its
publication after a crash without another paid call. A lost compare,
reprocessing, purged inputs, and tenant suppression stop publication; errors
never create a failed reading. The checkpoint contains no article summary and
is removed by reading purge, the tenant wipe, and the guarded account-teardown
transaction.

### Weekly tension pairs

The same scan shards also collect tension pairs (reading-lite-mtdh): for each
target, every reading in its floored ready neighbourhood whose pair clears the
overlap pre-filter `ops corpus refresh-tensions` uses (a shared person or org,
keyword Jaccard of at least 0.2, or a citation either way), is not already
judged on both sides since either was last rewritten, and has summary text on
both sides. Each pair is recorded once, canonically (`a < b`). A pair whose side
is running inside `PENDING_TTL_SECONDS` is skipped at scan time. Unlike the
operator pass, which judges pairs of the readings its report flagged, the
weekly scan considers every pair, so the first Sundays work through a backlog
and later Sundays see only new or reprocessed readings.

Pairs dispatch as `tension` jobs `(runAt, a, b)` after the connection judges,
reserved in batches of 25 against `REFRESH_MAX_TENSION_JUDGEMENTS` (default 100),
which is separate from the connection cap. Only one batch of either kind is
reserved at a time. Pairs left when the period's allowance runs out are not
carried forward. Once the connection candidates are done, the next Sunday starts
a fresh scan, which finds the still-unjudged pairs again. When that Sunday's
cron finds a batch of either kind still reserved, the fresh scan starts as soon
as the batch's send is confirmed, so the new allowance is never spent on the old
scan's pairs. A cursor written
before these fields existed parses with no tension allowance, so that run
dispatches no pairs and the next Sunday's allowance starts them.

A tension job revalidates both readings and the pair's eligibility, so a pair
judged since the scan (by the operator, say) or whose admitting citation the
connection judge removed makes no provider call. It takes the same leases, spend
admission, deferrals, 429 handling and 24-hour deferral expiry as a judge job.
`tension_refresh_jobs` holds one latest checkpoint per pair, with the same
rules as `relationship_refresh_jobs`: claimed after admission and immediately
before fetch, never repeated after an uncertain dispatch, and replayed from a
saved result. The saved result is the judgement and the hash of each resulting
reading, no summary text. Publication is one `replacePublishedSetIf`
transaction that locks both readings in id order and writes each side's
directional `tensions` entry and `tensions_judged` record; if either reading
changed since dispatch, neither is written. A pair is removed from the table by
purging either reading, by the tenant wipe, and by account teardown.

### Weekly tension repairs

The scan also plans the free one-sided repairs `ops corpus refresh-tensions`
performs (`findOneSided`, reading-lite-qxfh), for every pair a scanned reading
names in `tensions` or `tensions_judged`: mirror a judgement or judged record the
other side lost, drop a side a reprocess made stale, and purge a tension naming
a partner that is no longer ready. A purge removes the purged reading's own
rows but not its partners' entries naming it (`reading_relationships` cascades
from the source only), and that dangling entry makes tier 1 flag the holder
`stale_connection` on the operator's nightly pass. The hosted connection judge rewrites connections, not
tensions, so without the repair it would be paid for again each Sunday.

Repairs dispatch as `repair` jobs `(runAt, a, b)` before the connection judges,
in batches of 25 and uncapped, since they call no provider. The consumer runs
one job at a time, so a holder's dangling entry is gone before its connection
judge re-measures the neighbourhood, and that judge then finds nothing to do.
A pair a mirror settles is not collected for a paid tension judgement; a pair
whose repair only drops a stale side is still judged afterwards.

A repair job takes no lease, spend admission or checkpoint. It recomputes the
pair's repairs from the live readings, so a redelivery of a finished repair
does nothing, and writes every side they touch in one `replacePublishedSetIf`
on the versions it read. The side a mirror copies from is passed as a guard:
locked and version-checked in the same transaction but not rewritten. If either
side changed, nothing is written and the next scan plans again. An in-TTL running side defers the job like a judge.

The slice-4 single-night staging acceptance check passed on 2026-09-08. Staging
keeps a two-judgement weekly cap. Production uses one hundred fifty connection judgements.
