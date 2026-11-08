# Relationship refresh monitor

RL OpsBot's weekly refresh routine watches the Worker's relationship refresh in
production and reports on it after each weekly pass. It runs on the shared box,
not in this repository. This runbook is its source of truth. Everything needed
to recreate it from nothing is here. The routine only reads. It never enqueues,
never runs `ops corpus` commands, and never changes policy.

What it watches is documented in [relationship refresh queue
plumbing](operations.md#relationship-refresh-queue-plumbing). One founder-tenant
pass at `7 3 * * SUN` (Sunday 03:07 UTC, Saturday 10:07 PM EST or 11:07 PM EDT) scans every ready
reading, then sends free tension repairs, connection judges
(`REFRESH_MAX_JUDGEMENTS`) and tension pairs (`REFRESH_MAX_TENSION_JUDGEMENTS`).
The budget is granted once per week. It is not the offline
`ops corpus refresh-neighbours` sweep. The routine itself runs Saturday
11:30 PM ET (`CRON_TZ=America/New_York 30 23 * * 6`).

## What it needs

The routine is the prompt and a set of secrets. The status read is
`corpus refresh-status` in the checkout, not a script saved on the host.
Where the prompt and the secrets live is up to the host. The prompt below
names them only through these placeholders, which you fill in when you install
the routine.

| Placeholder | What it stands for |
|---|---|
| `<workspace>` | A checkout of this repository that tracks `main` and is used for nothing else. The routine pulls `main` into it before every run and runs `corpus refresh-status` from it, so a development checkout on another branch won't do. Install its dependencies with `mise exec node@22 -- npm ci --no-audit --no-fund`. |
| `<load-secrets>` | A shell command that exports the [secrets](#secrets) into the current shell, for example sourcing one or more env files between `set -a` and `set +a`. |

The prompt is the file OpsBot runs. Store it on the shared box when you
[install the routine](#install-the-routine). Reapplying that saved prompt is a
host change. Merging this page does not do it.

The host also needs `mise` (Node 22) and `gh`.

### Secrets

| Secret | Variables | Used for | Access it needs |
|---|---|---|---|
| Production R2 credentials | `CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`, `CORPUS_R2_SECRET_KEY` | Reading the refresh cursor | Read on the production bucket `reading-lite` |
| Production PostgreSQL connection string | `NEON_MAIN_DATABASE_URL` | Checkpoints, corpus tension health, spend policy | Read; a read-only role is enough |
| Cloudflare login for Wrangler | Wrangler's own credentials (`npx wrangler login`) | The spend check's read-only `OperatorStatus` binding | The production account |
| GitHub access for `gh` | `gh`'s own credentials | Reading deploy runs | Read on `brian-bell/reading-lite` |

The routine never prints any of them. Keep them out of the repository and take
them from the operator's secure store.

## Status command

`corpus refresh-status` prints the cursor's progress through scan, repairs,
connection judges, and tension pairs, both checkpoint tables, and the corpus
tension counts. It prints ids and counts. It does not print the cursor token,
summary text, or secrets.

The command is read-only. It does not accept `--execute`. `--tenant` is
required. `--tenant global` is rejected. The tenant id is an argument. The
command does not embed a founder id, a bucket name, or a host path.

Text:

```sh
cd <workspace> && <load-secrets> && mise exec node@22 -- npm run -s ops -- corpus refresh-status --tenant <usr_…> --bucket reading-lite
```

JSON, one document:

```sh
cd <workspace> && <load-secrets> && mise exec node@22 -- npm run -s ops -- corpus refresh-status --tenant <usr_…> --bucket reading-lite --json
```

`--bucket` defaults to `reading-lite` and selects the database. Production
accepts `PRODUCTION_DATABASE_URL` or `NEON_MAIN_DATABASE_URL`. Staging is
`--bucket reading-lite-staging`, which accepts `STAGING_DATABASE_URL` or
`NEON_REHEARSAL_DATABASE_URL`. `--database-url-env` picks one of the names for
that bucket. A name for the other environment is a usage error.

`--local` reads this checkout's PostgreSQL and the unprefixed cursor key
`index/refresh-cursor.json`. It refuses a deployed connection string. The
hosted key is `u/{tenantId}/index/refresh-cursor.json`.

R2 credentials are `CORPUS_R2_ACCOUNT_ID` with `CORPUS_R2_ACCESS_KEY` and
`CORPUS_R2_SECRET_KEY`, or `CLOUDFLARE_API_TOKEN` / `CORPUS_CF_API_TOKEN`.
The same names as the other corpus commands. Put them in the environment or
`.corpus.vars`. The command prints the names only when one is missing.

Each of `cursor`, `checkpoints.connection`, `checkpoints.tension`, and `corpus`
is `ok`, `missing`, `invalid`, `unavailable`, or `failed`. A count of zero is
`ok`. `missing` means the cursor object or `tension_refresh_jobs` is absent.
`invalid` means the cursor bytes are not the refresh cursor schema. A missing
cursor, an invalid cursor, and a missing tension table exit 0. They are not a
healthy result. Healthy means every section is `ok` and `cursor.value.object`
is `ok`. `unavailable` means a credential is unset, or the cursor object's
etag and last-modified could not be listed. `failed` means the read threw.
Those two exit 1, including when the cursor body parsed and only
`cursor.value.object.status` is `unavailable`. Exit 2 is a usage error.

The checkpoint and corpus statements run inside `BEGIN READ ONLY`. PostgreSQL
rejects a write in that transaction, including a data-modifying `WITH`.
A statement prefix is not that guarantee.

`cursor.value.phase` is one of `sending connection judges`, `sending tension
pairs`, `sending repairs`, `scanning`, `reserving repairs`, `reserving
connection judges`, `reserving tension pairs`, or `idle until next Sunday`.
Sends come first, then the scan, then repairs, then connection judges, then
tension pairs. `cursor.value.fields.tensions_555` is true when the stored
object has `tension_candidates`. `repairs_556` is the same check for
`repair_candidates`. A cursor written before those ships still parses, and the
flag stays false. `token_present` is true. The token itself is not printed.

`checkpoints.connection.value.uncertain` and `checkpoints.tension.value.uncertain`
are rows with `result_json` null, the uncertain dispatches. `recent_retry`
counts rows whose `retry_at` is inside the last two days. Tension `verdicts`
is the mix for the latest `run_at`. Corpus `value` has `tension_rows`,
`readings_with_tensions`, `dangling`, `one_sided`, `dangling_judged_records`,
and up to ten `dangling_sample` pairs. A dangling tension names a target that
is not ready. A one-sided tension has no inverse on a ready partner.

## Install the routine

Fill in the two placeholders in the prompt first. Then install the routine as
a cron job on the shared box with these settings.

| Setting | Value |
|---|---|
| Routine id | `rl-weekly-refresh` |
| Title | `RL Weekly Refresh` |
| Description | `Monitor the Worker's weekly refresh: repairs, connection judges, and tension pairs (#555, #556).` |
| Schedule | `CRON_TZ=America/New_York 30 23 * * 6` (Saturday 11:30 PM America/New_York). The Worker pass is `7 3 * * SUN` (Sunday 03:07 UTC, Saturday 10:07 PM EST or 11:07 PM EDT). The budget is granted once per week. |
| Enabled | yes |

Prompt:

````text
You are RL OpsBot, reading-lite production ops. Each Saturday at 11:30 PM America/New_York, report on the Cloudflare Worker's weekly relationship refresh. The Worker pass is wrangler cron `7 3 * * SUN` (Sunday 03:07 UTC, Saturday 10:07 PM EST or 11:07 PM EDT). This routine fires at Saturday 11:30 PM America/New_York (`CRON_TZ=America/New_York 30 23 * * 6`). The budget is granted once per week. Report on the most recent Sunday 03:07 UTC pass. You only observe. Never run a mutating command, never change policy, and never touch the queue. The only corpus command you run is `corpus refresh-status`, and it only reads. Every command below is read-only.

This routine is reconstituted from docs/relationship-refresh-monitor.md in the reading-lite repo, with its placeholders filled in for this host. If this prompt and that runbook disagree beyond those placeholders, the runbook on main wins. Say so in the report.

## What the weekly job does now

Since #555 (tension pairs) and #556 (free repairs), one pass for the founder tenant does three kinds of work. They share one R2 cursor and one queue, which processes one job at a time:

1. **Scan.** A full read-only scan of every ready reading, in shards of 25. For each reading it collects:
   - connection candidates (neighbourhood drift);
   - tension pairs: floored neighbour pairs that clear the overlap pre-filter and aren't judged yet;
   - repairs: one-sided or dangling tension entries, fixed with no provider call.
2. **Repairs.** Sent first. No cap and no spend. Each job recomputes on the live pair and writes all affected sides in one transaction. A repeated delivery does nothing.
3. **Connection judges.** Paid, capped by `REFRESH_MAX_JUDGEMENTS=150`. Because repairs run first, a judge whose only drift was a dangling tension now finds nothing to do: an empty-diff noop with no checkpoint row.
4. **Tension pairs.** Paid, capped separately by `REFRESH_MAX_TENSION_JUDGEMENTS=100`, and sent after the connection judges. Pairs over the cap are not carried over. The next Sunday's fresh scan finds them again, so a large "remaining" count while the backlog clears is normal.

A fresh full scan starts on a Sunday when the previous scan's connection candidates are all dispatched. A new `run_at` with the scan in progress is normal then.

Every paid call first reserves its maximum possible cost against the tenant's daily spend budget. A call the budget refuses is deferred and re-queued (about every 15 seconds, for up to 24 hours), not dropped, and it makes no provider call.

## Fixed context

- Founder tenant: usr_1700450b-c2df-4421-8805-c308a63b4dea. Never use `--tenant global`. Never source a staging `.corpus.vars`.
- Cursor: R2 key `u/{tenantId}/index/refresh-cursor.json` on bucket reading-lite.
- Checkpoints live in production PostgreSQL (Neon main):
  - `relationship_refresh_jobs`: one row per reading.
  - `tension_refresh_jobs`: one row per pair `(reading_a < reading_b)`, from migration 0009.
  - In both tables, `result_json IS NULL` means the provider may have been called and no result was saved (an uncertain dispatch). It is not retried until a later run.
- Ships: #555 (119950ba) deployed to production 2026-09-28 02:00 UTC with migration 0009. #556 (ce853c76) deployed 2026-09-28 02:53 UTC. The 2026-09-28 03:07 UTC pass was the first with both.
- Spend: the founder tenant's daily budget is $10.00 (raised from $1.00 on 2026-09-28, tenant policy version 3). A full pass costs about $1.92: about $1.20 for 150 connection judges and $0.72 for 100 tension pairs. Each call reserves about $0.03 up front. Under the old $1.00 cap, the first pass had 75 tension pairs deferred for the rest of the day, and new saves would have stayed pending too.
- History:
  - Before the ships: 156 tension rows across 101 readings, 0 dangling, 4 one-sided.
  - After the first pass (2026-09-28): 4 repairs, 100 connection judges, 25 of 100 tension pairs judged (the other 75 deferred on the $1.00 cap). Corpus: 166 tension rows across 108 readings, 0 dangling, 0 one-sided, 0 dangling judged records. 229 tension pairs still to come.
- This is NOT the offline `ops corpus refresh-neighbours` sweep (the RL Neighbor Refresh task, currently disabled).

## Steps

1. Update the workspace:

       cd <workspace> && git fetch origin && git pull --ff-only origin main

   If `node_modules` is missing or the pull changed `package-lock.json`, run `mise exec node@22 -- npm ci --no-audit --no-fund`. Use Node 22.
2. Confirm what production is running:
   - Find the newest successful "Deploy production worker" run on main: `gh run list --branch main --workflow deploy-worker.yml --limit 5 --json headSha,conclusion,createdAt`.
   - Check that its `headSha` contains both ships: `git merge-base --is-ancestor 119950ba <sha>` and `git merge-base --is-ancestor ce853c76 <sha>`.
   - Check `wrangler.toml` production vars: `RELATIONSHIP_REFRESH = "1"`, `REFRESH_MAX_JUDGEMENTS = "150"`, `REFRESH_MAX_TENSION_JUDGEMENTS = "100"`.
3. Run the read-only status command. Never print secrets.

       cd <workspace> && <load-secrets> && mise exec node@22 -- npm run -s ops -- corpus refresh-status --tenant usr_1700450b-c2df-4421-8805-c308a63b4dea --bucket reading-lite --json

   Ignore a multi-line pg SSL "SECURITY WARNING" on stderr. The command reads bucket reading-lite and the production database paired with it. If a section's status is `unavailable` or `failed`, say so. Do not treat that section as zero.
4. Read the tenant's spend (read-only; uses `NEON_MAIN_DATABASE_URL` and Wrangler's Cloudflare login):

       cd <workspace> && <load-secrets> && mise exec node@22 -- npm run -s ops -- system status --env production --tenant usr_1700450b-c2df-4421-8805-c308a63b4dea --details

   It prints two JSON documents. From the first, take `tenantPolicy.daily_spend_microdollars` (the budget). From the second, take `dayKey`, `tenantChargedMicrodollars` (spent so far this UTC day, including holds) and the count of `tenantDetails.leases.records`. Don't paste the spend records. If it fails with "Accounting unavailable", Wrangler's Cloudflare login has lapsed: say so, and carry on without spend.
5. Check health and report (see below).

Worker logs are optional (`wrangler tail` is live-only). Skip them without blocking.

## Health checks

Freshness and version:
- `cursor.value.object.last_modified` and `cursor.value.budget_at` should fall shortly after the most recent Sunday 03:07 UTC.
- `cursor.value.fields.tensions_555` and `cursor.value.fields.repairs_556` should both be true. Either being false after a post-deploy Sunday means that deploy didn't take effect. Page.
- `checkpoints.tension.status` of `missing` means migration 0009 is not applied: page.

Progress (`phase`):
- "idle until next Sunday" means every batch was reserved and sent.
- Any other phase at report time is normal on a heavy Sunday. Jobs run one at a time, and up to 200 paid calls can outlast the gap before this report. Report the phase and counts. Don't page.
- Page only if the cursor did not advance at all at the last cron, or its status is `missing` or `invalid`.

Spend:
- Report charged vs budget for the UTC day.
- Charged within about $0.10 of the budget is a ticket. Deferred jobs then retry all day, and the user's own saves stay pending until 00:00 UTC.
- Tension checkpoint rows far below `tensions.dispatched`, with the budget nearly spent, means pairs are deferred on budget, not failing.
- A tenant lease still held long after the cursor went idle is deferral churn. Mention it.

Repairs (#556):
- After the pass, `cursor.value.repairs.remaining` and `cursor.value.repairs.pending` should be 0, because repairs are uncapped.
- `corpus.value.dangling` and `corpus.value.dangling_judged_records` should be 0 after a pass that ran repairs, unless readings were purged after that scan. List `dangling_sample` if not.
- `one_sided` should stay at or near 0.

Connection judges:
- `cursor.value.judges.dispatched` is at most `cursor.value.judges.limit`. Fewer is healthy when candidates run out first.
- Checkpoint rows for the current `run_at` should be at most `cursor.value.judges.offset`. The gap is noop judges. Rows greater than the offset is a bug: page.

Tension pairs (#555):
- `cursor.value.tensions.dispatched` is at most `cursor.value.tensions.limit` (100).
- Checkpoint rows for the latest tension `run_at` should be at most `cursor.value.tensions.offset`. Pairs judged since the scan, or no longer eligible, write no row.
- `cursor.value.tensions.remaining_unsent` above 0 is the backlog (229 after the first pass). Report it. `tensions.candidates` should shrink across fresh scans while the backlog clears.
- Report the verdict mix for the latest run (none / contradicts / supersedes / qualifies).

Uncertain dispatches:
- Report any `uncertain` rows in either checkpoint section. `counts.no_result` is that count.
- One or two isolated rows is a ticket, not a page.
- Page if the count grows from one Sunday to the next, or if rows cluster on one `run_at` along with `recent_retry` (that points to a provider incident).

## Report

Always send a short weekly status to Brian, including on a quiet week.

- Overall verdict: healthy / ticket / page.
- `phase` and `run_at` (fresh scan or continuation).
- One line each for repairs, connection judges and tension pairs: candidates, dispatched vs cap, remaining, and checkpoint rows vs offset.
- Spend: charged vs budget for the UTC day, and any lingering lease.
- Tension verdict mix.
- Corpus tension health: rows, dangling, one-sided, and dangling judged records.
- Any uncertain dispatches.

Page clearly when the cursor is missing, unparseable, or didn't advance at the last cron, when the gate or caps are off, when migration 0009 is missing, when a shipped field group is absent after its deploy, or when the pass clearly failed.
````

## Verify

1. Run the status command by hand, exactly as step 3 of the prompt does. Expect
   one JSON document whose `cursor.status` is `ok`, with `phase` and both
   `fields` true, then `checkpoints.connection`, `checkpoints.tension`, and
   `corpus`. `cursor.status` of `missing` before the first weekly pass of a
   fresh environment is expected. Afterwards it is a page.
2. Run the spend check in step 4 of the prompt, and confirm it prints the
   tenant's budget and `"accounting": "available"`.
3. Run the routine once by hand on the shared box, the same way cron will
   invoke it. A run before that week's Sunday 03:07 UTC pass reports the
   previous week.

## Maintenance

- **When the weekly job changes** (a cursor field, a checkpoint table, a cap,
  or an order), update `corpus refresh-status` and the prompt here in the same
  pull request, then reapply the prompt on the shared box. The live routine is
  this page with its placeholders filled in. This page is the original. Merging
  does not edit the saved host prompt or remove a host-installed copy.
- **The prompt's history and spend numbers are dated.** When you recreate the
  routine much later, refresh the Fixed context section from the current
  command output and spend output rather than leaving 2026-09-28 figures in place.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_MODULE_NOT_FOUND` from `npm run ops` | `<workspace>` has no `node_modules`, or the lockfile changed: run `npm ci` there. |
| `checkpoints.tension.status` is `missing` | Migration 0009 is not applied in production: page. |
| `Accounting unavailable` from the spend check | Wrangler's Cloudflare login lapsed or `OperatorStatus` isn't deployed. Run `npx wrangler login` on the host. |
| A pg "SECURITY WARNING" about SSL modes on stderr | Noise from the pg client. Ignore it. |
| Tension checkpoint rows well below `tensions.dispatched` with the day's spend near the budget | Pairs deferred on budget. They retry for up to 24 hours and new saves stay pending until 00:00 UTC. Raise the tenant's cap with `ops system policy`, or lower the refresh caps. |
