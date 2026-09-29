# Relationship refresh monitor

The **RL Nightly Refresh** scheduled task watches the Worker's nightly
relationship refresh in production and reports on it every night. It runs in
the Claude desktop app on an operator's machine, not in this repository, so
this runbook is its source of truth: everything needed to recreate it from
nothing is here. The task only reads. It never enqueues, never runs `ops corpus`
commands, and never changes policy.

What it watches is documented in [relationship refresh queue
plumbing](operations.md#relationship-refresh-queue-plumbing): one founder-tenant
pass at 03:07 UTC that scans every ready reading, then sends free tension
repairs, connection judges (`REFRESH_MAX_JUDGEMENTS`) and tension pairs
(`REFRESH_MAX_TENSION_JUDGEMENTS`). It is not the offline
`ops corpus refresh-neighbours` sweep.

## What it needs

The task is three files and a set of secrets. Where each lives is up to the
host; the prompt and script below name them only through these placeholders,
which you fill in when you create the task.

| Placeholder | What it stands for |
|---|---|
| `<workspace>` | A checkout of this repository that tracks `main` and is used for nothing else. The task pulls `main` into it before every run and imports the repository's R2 client and SQL seam from it, so a development checkout on another branch won't do. Install its dependencies with `mise exec node@22 -- npm ci --no-audit --no-fund`. |
| `<status-script>` | Where the [status script](#status-script) is saved. |
| `<load-secrets>` | A shell command that exports the [secrets](#secrets) into the current shell, for example sourcing one or more env files between `set -a` and `set +a`. |

The third file is the task itself, which the desktop app stores when you
[create it](#create-the-task).

The host also needs `mise` (Node 22) and `gh`.

### Secrets

| Secret | Variables | Used for | Access it needs |
|---|---|---|---|
| Production R2 credentials | `CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`, `CORPUS_R2_SECRET_KEY` | Reading the refresh cursor | Read on the production bucket `reading-lite` |
| Production PostgreSQL connection string | `NEON_MAIN_DATABASE_URL` | Checkpoints, corpus tension health, spend policy | Read; a read-only role is enough |
| Cloudflare login for Wrangler | Wrangler's own credentials (`npx wrangler login`) | The spend check's read-only `OperatorStatus` binding | The production account |
| GitHub access for `gh` | `gh`'s own credentials | Reading deploy runs | Read on `brian-bell/reading-lite` |

The task never prints any of them. Keep them out of the repository and take
them from the operator's secure store.

## Status script

The script prints the cursor's progress through all three kinds of work, both
checkpoint tables, and the corpus's tension health (dangling and one-sided
entries). It prints ids and counts, never secrets or summary text. Save it at
`<status-script>`, with `<workspace>` in the two imports replaced by the
checkout's absolute path (the TypeScript loader does not expand `~`).

```ts
// Read-only status of the production nightly relationship refresh, for rl-nightly-refresh.
// Covers all three kinds of nightly work since #555 (tension pairs) and #556 (free repairs):
// the R2 cursor, both checkpoint tables in PostgreSQL, and the corpus's tension health.
// Prints ids and counts only, never secrets or summary text.
// Run from <workspace> with the secrets loaded (docs/relationship-refresh-monitor.md). Replace <workspace>
// in the two imports with the checkout's absolute path.
import { makeR2Client } from "<workspace>/scripts/lib/cf-clients";
import { sqlFromConnectionString } from "<workspace>/src/modules/db/sql";

const T = "usr_1700450b-c2df-4421-8805-c308a63b4dea";
const e = process.env;
const out = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

// ---- Cursor (R2) ----------------------------------------------------------
const r2 = makeR2Client({ accountId: e.CORPUS_R2_ACCOUNT_ID!, accessKeyId: e.CORPUS_R2_ACCESS_KEY!, secretAccessKey: e.CORPUS_R2_SECRET_KEY!, bucket: "reading-lite" });
const key = `u/${T}/index/refresh-cursor.json`;
const body = await r2.get(key);
const meta = (await r2.listObjects(`u/${T}/index/refresh-cursor`)).find(o => o.key === key);
if (body == null) {
  console.log("CURSOR: MISSING at", key);
} else {
  let c: Record<string, any> | null = null;
  try { c = JSON.parse(body); } catch { console.log("CURSOR: UNPARSEABLE at", key); }
  if (c) {
    const len = (v: unknown) => Array.isArray(v) ? v.length : 0;
    const scan = { targets: len(c.targets), offset: c.scan_offset ?? 0 };
    const repairs = { candidates: len(c.repair_candidates), offset: c.repair_offset ?? 0, pending: len(c.repair_pending) };
    const judges = { candidates: len(c.candidates), offset: c.judge_offset ?? 0, limit: c.limit, dispatched: c.dispatched, pending: len(c.pending) };
    const tensions = { candidates: len(c.tension_candidates), offset: c.tension_offset ?? 0, limit: c.tension_limit ?? null, dispatched: c.tension_dispatched ?? 0, pending: len(c.tension_pending) };
    // Where the state machine is: sends first, then scan, repairs, judges, tension pairs.
    const phase =
      judges.pending ? "sending connection judges" : tensions.pending ? "sending tension pairs" : repairs.pending ? "sending repairs"
      : scan.offset < scan.targets ? "scanning"
      : repairs.offset < repairs.candidates ? "reserving repairs"
      : judges.offset < judges.candidates && judges.dispatched < judges.limit ? "reserving connection judges"
      : tensions.offset < tensions.candidates && tensions.dispatched < (tensions.limit ?? 0) ? "reserving tension pairs"
      : "idle until next night";
    console.log("CURSOR lastModified:", meta?.lastModified, "etag:", meta?.etag?.slice(0, 8));
    out("CURSOR", {
      version: c.version, run_at: c.run_at, budget_at: c.budget_at, rollover: c.rollover ?? null, token_present: !!c.token, phase,
      // A missing field means the cursor was last written by code from before that ship.
      fields: { tensions_555: "tension_candidates" in c, repairs_556: "repair_candidates" in c },
      scan, repairs: { ...repairs, remaining: repairs.candidates - repairs.offset },
      judges: { ...judges, remaining: judges.candidates - judges.offset },
      tensions: { ...tensions, remaining_unsent: tensions.candidates - tensions.offset },
    });
  }
}

// ---- PostgreSQL -------------------------------------------------------------
const sql = sqlFromConnectionString(e.NEON_MAIN_DATABASE_URL!);
try {
  const q = <R = Record<string, unknown>>(text: string, params: unknown[] = [T]) => sql.query<R>(text, params);

  // Connection judge checkpoints. A judge that noops (empty diff, e.g. after a
  // repair removed its only drift) writes no row, so rows <= judge offset.
  out("PG connection counts", (await q(`SELECT count(*)::int total, count(result_json)::int with_result,
      (count(*)-count(result_json))::int no_result, count(*) FILTER (WHERE retry_at > now() - interval '2 days')::int recent_retry
    FROM relationship_refresh_jobs WHERE tenant_id=$1`))[0]);
  out("PG connection by run_at", await q(`SELECT run_at, count(*)::int n, count(result_json)::int with_result
    FROM relationship_refresh_jobs WHERE tenant_id=$1 GROUP BY run_at ORDER BY run_at DESC LIMIT 5`));
  out("PG connection no_result", await q(`SELECT reading_id, run_at, retry_at FROM relationship_refresh_jobs
    WHERE tenant_id=$1 AND result_json IS NULL ORDER BY run_at DESC, reading_id LIMIT 15`));

  // Tension pair checkpoints (#555, migration 0009). Only pairs that passed
  // admission and dispatched have a row, so rows <= tension offset.
  const [{ present }] = await q<{ present: boolean }>(`SELECT to_regclass('public.tension_refresh_jobs') IS NOT NULL AS present`, []);
  if (!present) {
    console.log("PG tension_refresh_jobs: TABLE MISSING (migration 0009 not applied)");
  } else {
    out("PG tension counts", (await q(`SELECT count(*)::int total, count(result_json)::int with_result,
        (count(*)-count(result_json))::int no_result, count(*) FILTER (WHERE retry_at > now() - interval '2 days')::int recent_retry
      FROM tension_refresh_jobs WHERE tenant_id=$1`))[0]);
    out("PG tension by run_at", await q(`SELECT run_at, count(*)::int n, count(result_json)::int with_result
      FROM tension_refresh_jobs WHERE tenant_id=$1 GROUP BY run_at ORDER BY run_at DESC LIMIT 5`));
    out("PG tension verdicts (latest run_at)", await q(`SELECT coalesce(result_json->'judgement'->>'verdict', '(no result)') verdict, count(*)::int n
      FROM tension_refresh_jobs WHERE tenant_id=$1 AND run_at = (SELECT max(run_at) FROM tension_refresh_jobs WHERE tenant_id=$1)
      GROUP BY 1 ORDER BY 2 DESC`));
    out("PG tension no_result", await q(`SELECT reading_a, reading_b, run_at, retry_at FROM tension_refresh_jobs
      WHERE tenant_id=$1 AND result_json IS NULL ORDER BY run_at DESC, reading_a LIMIT 15`));
  }

  // Corpus tension health: what #556's repairs exist to drive to zero. A
  // dangling tension names a reading that is no longer ready; tier 1 flags its
  // holder stale_connection, and a connection judge is paid for, every night
  // until it is repaired. A one-sided tension has no inverse on its partner.
  out("CORPUS tensions", (await q(`
    WITH ready AS (SELECT id FROM readings WHERE tenant_id=$1 AND status='ready'),
    t AS (SELECT source_id, target_id FROM reading_relationships
          WHERE tenant_id=$1 AND kind='tension' AND source_id IN (SELECT id FROM ready))
    SELECT count(*)::int tension_rows,
      count(DISTINCT source_id)::int readings_with_tensions,
      count(*) FILTER (WHERE target_id NOT IN (SELECT id FROM ready))::int dangling,
      count(*) FILTER (WHERE target_id IN (SELECT id FROM ready)
        AND NOT EXISTS (SELECT 1 FROM t b WHERE b.source_id = t.target_id AND b.target_id = t.source_id))::int one_sided
    FROM t`))[0]);
  out("CORPUS dangling judged records", (await q(`
    SELECT count(*)::int n FROM readings rd
    JOIN reading_revisions v ON (v.tenant_id, v.reading_id, v.id) = (rd.tenant_id, rd.id, rd.current_revision_id)
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.tensions_judged, '[]'::jsonb)) j
    WHERE rd.tenant_id=$1 AND rd.status='ready'
      AND NOT EXISTS (SELECT 1 FROM readings p WHERE p.tenant_id=$1 AND p.id = j->>'id' AND p.status='ready')`))[0]);
  out("CORPUS dangling tensions (sample)", await q(`
    SELECT r.source_id, r.target_id FROM reading_relationships r
    WHERE r.tenant_id=$1 AND r.kind='tension'
      AND NOT EXISTS (SELECT 1 FROM readings p WHERE p.tenant_id=$1 AND p.id=r.target_id AND p.status='ready')
    ORDER BY r.source_id LIMIT 10`));
} finally {
  await sql.end();
}
```

## Create the task

Create it from a Claude Code session in the desktop app. Ask Claude to create
a scheduled task with exactly these settings and the prompt below, or use the
app's scheduled-task UI. Fill in the three placeholders in the prompt first.

| Setting | Value |
|---|---|
| Task id | `rl-nightly-refresh` |
| Title | `RL Nightly Refresh` |
| Description | `Monitor the Worker's nightly refresh: repairs, connection judges, and tension pairs (#555, #556).` |
| Schedule | cron `30 23 * * *`, local time (America/New_York): about 25 minutes after the 03:07 UTC pass in summer time, about 85 minutes after it in winter |
| Enabled | yes |

Prompt:

````text
You are RL OpsBot, reading-lite production ops. Every night, report on the Cloudflare Worker's nightly relationship refresh. It runs on wrangler cron `7 3 * * *` (03:07 UTC / 11:07pm ET), and this task fires about 25 minutes later. Report on the most recent 03:07 UTC pass. You only observe: never run a mutating command, never run `ops corpus` commands, never change policy, and never touch the queue. Every command below is read-only.

This task is reconstituted from docs/relationship-refresh-monitor.md in the reading-lite repo, with its placeholders filled in for this host. If this prompt and that runbook disagree beyond those placeholders, the runbook on main wins: say so in the report.

## What the nightly job does now

Since #555 (tension pairs) and #556 (free repairs), one pass for the founder tenant does three kinds of work. They share one R2 cursor and one queue, which processes one job at a time:

1. **Scan.** A full read-only scan of every ready reading, in shards of 25. For each reading it collects:
   - connection candidates (neighbourhood drift);
   - tension pairs: floored neighbour pairs that clear the overlap pre-filter and aren't judged yet;
   - repairs: one-sided or dangling tension entries, fixed with no provider call.
2. **Repairs.** Sent first. No cap and no spend. Each job recomputes on the live pair and writes all affected sides in one transaction. A repeated delivery does nothing.
3. **Connection judges.** Paid, capped by `REFRESH_MAX_JUDGEMENTS=100`. Because repairs run first, a judge whose only drift was a dangling tension now finds nothing to do: an empty-diff noop with no checkpoint row.
4. **Tension pairs.** Paid, capped separately by `REFRESH_MAX_TENSION_JUDGEMENTS=100`, and sent after the connection judges. Pairs over the cap are not carried over. The next night's fresh scan finds them again, so a large "remaining" count while the backlog clears is normal.

A fresh full scan starts on a night when the previous scan's connection candidates are all dispatched. A new `run_at` with the scan in progress is normal then.

Every paid call first reserves its maximum possible cost against the tenant's daily spend budget. A call the budget refuses is deferred and re-queued (about every 15 seconds, for up to 24 hours), not dropped, and it makes no provider call.

## Fixed context

- Founder tenant: usr_1700450b-c2df-4421-8805-c308a63b4dea. Never use `--tenant global`. Never source a staging `.corpus.vars`.
- Cursor: R2 key `u/{tenantId}/index/refresh-cursor.json` on bucket reading-lite.
- Checkpoints live in production PostgreSQL (Neon main):
  - `relationship_refresh_jobs`: one row per reading.
  - `tension_refresh_jobs`: one row per pair `(reading_a < reading_b)`, from migration 0009.
  - In both tables, `result_json IS NULL` means the provider may have been called and no result was saved (an uncertain dispatch). It is not retried until a later run.
- Ships: #555 (119950ba) deployed to production 2026-09-28 02:00 UTC with migration 0009. #556 (ce853c76) deployed 2026-09-28 02:53 UTC. The 2026-09-28 03:07 UTC pass was the first with both.
- Spend: the founder tenant's daily budget is $10.00 (raised from $1.00 on 2026-09-28, tenant policy version 2). A full pass costs about $1.50: about $0.80 for 100 connection judges and $0.72 for 100 tension pairs. Each call reserves about $0.03 up front. Under the old $1.00 cap, the first pass had 75 tension pairs deferred for the rest of the day, and new saves would have stayed pending too.
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
   - Check `wrangler.toml` production vars: `RELATIONSHIP_REFRESH = "1"`, `REFRESH_MAX_JUDGEMENTS = "100"`, `REFRESH_MAX_TENSION_JUDGEMENTS = "100"`.
3. Run the read-only status script. Never print secrets.

       cd <workspace> && <load-secrets> && mise exec node@22 -- npx tsx <status-script>

   Ignore the multi-line pg SSL "SECURITY WARNING" on stderr. The script forces bucket reading-lite and imports from this workspace. If an import path moved, fix the path in the script; don't build a different data path.
4. Read the tenant's spend (read-only; uses `NEON_MAIN_DATABASE_URL` and Wrangler's Cloudflare login):

       cd <workspace> && <load-secrets> && mise exec node@22 -- npm run -s ops -- system status --env production --tenant usr_1700450b-c2df-4421-8805-c308a63b4dea --details

   It prints two JSON documents. From the first, take `tenantPolicy.daily_spend_microdollars` (the budget). From the second, take `dayKey`, `tenantChargedMicrodollars` (spent so far this UTC day, including holds) and the count of `tenantDetails.leases.records`. Don't paste the spend records. If it fails with "Accounting unavailable", Wrangler's Cloudflare login has lapsed: say so, and carry on without spend.
5. Check health and report (see below).

Worker logs are optional (`wrangler tail` is live-only). Skip them without blocking.

## Health checks

Freshness and version:
- The cursor's `lastModified` and `budget_at` should fall shortly after the most recent 03:07 UTC.
- `fields.tensions_555` and `fields.repairs_556` should both be true. Either being false after a post-deploy night means that deploy didn't take effect: page.
- `PG tension_refresh_jobs: TABLE MISSING` means migration 0009 is not applied: page.

Progress (`phase`):
- "idle until next night" means every batch was reserved and sent.
- Any other phase at report time is normal on a heavy night. Jobs run one at a time, and up to 200 paid calls can outlast the 25-minute gap. Report the phase and counts; don't page.
- Page only if the cursor did not advance at all at the last cron, or is missing or unparseable.

Spend:
- Report charged vs budget for the UTC day.
- Charged within about $0.10 of the budget is a ticket. Deferred jobs then retry all day, and the user's own saves stay pending until 00:00 UTC.
- Tension checkpoint rows far below `tensions.dispatched`, with the budget nearly spent, means pairs are deferred on budget, not failing.
- A tenant lease still held long after the cursor went idle is deferral churn. Mention it.

Repairs (#556):
- After the pass, `repairs.remaining` and `repairs.pending` should be 0, because repairs are uncapped.
- The corpus's `dangling` and `CORPUS dangling judged records` should be 0 after a pass that ran repairs, unless readings were purged after that scan. List the sample if not.
- `one_sided` should stay at or near 0.

Connection judges:
- `dispatched <= limit`. Fewer is healthy when candidates run out first.
- Checkpoint rows for the current `run_at` should be `<=` `judges.offset`. The gap is noop judges. Rows greater than the offset is a bug: page.

Tension pairs (#555):
- `tensions.dispatched <= tensions.limit` (100).
- Checkpoint rows for the latest tension `run_at` should be `<=` `tensions.offset`. Pairs judged since the scan, or no longer eligible, write no row.
- `remaining_unsent > 0` is the backlog (229 after the first pass). Report it: `tensions.candidates` should shrink across fresh scans while the backlog clears.
- Report the verdict mix for the latest run (none / contradicts / supersedes / qualifies).

Uncertain dispatches:
- Report any `no_result` rows in either table.
- One or two isolated rows is a ticket, not a page.
- Page if the count grows night over night, or if rows cluster on one `run_at` along with `recent_retry` (that points to a provider incident).

## Report

Always send a short nightly status to Brian, including on a quiet night:
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

1. Run the status script by hand, exactly as step 3 of the prompt does. Expect
   a `CURSOR` line with `phase` and both `fields` true, then `PG connection`,
   `PG tension` and `CORPUS` lines. `CURSOR: MISSING` before the first nightly
   pass of a fresh environment is expected; afterwards it is a page.
2. Run the spend check in step 4 of the prompt, and confirm it prints the
   tenant's budget and `"accounting": "available"`.
3. Press **Run now** on the task once, and approve the tools it asks for. The
   approvals are stored on the task, so scheduled runs don't stop on
   permission prompts. A run before that night's 03:07 UTC pass reports the
   previous night.

## Maintenance

- **When the nightly job changes** (a cursor field, a checkpoint table, a cap,
  or an order), update the script and the prompt here in the same pull request
  as the change, then reapply both to the task. The live task is this page
  with its placeholders filled in; this page is the original.
- **The prompt's history and spend numbers are dated.** When you recreate the
  task much later, refresh the Fixed context section from the current script
  and spend output rather than leaving 2026-09-28 figures in place.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_MODULE_NOT_FOUND` from the script | `<workspace>` has no `node_modules`, or the lockfile changed: run `npm ci` there. |
| An import path in the script no longer exists | A repository module moved. Fix the path in the script (and here); don't read the data another way. |
| `PG tension_refresh_jobs: TABLE MISSING` | Migration 0009 is not applied in production: page. |
| `Accounting unavailable` from the spend check | Wrangler's Cloudflare login lapsed or `OperatorStatus` isn't deployed. Run `npx wrangler login` on the host. |
| A pg "SECURITY WARNING" about SSL modes on stderr | Noise from the pg client. Ignore it. |
| Tension checkpoint rows well below `tensions.dispatched` with the day's spend near the budget | Pairs deferred on budget. They retry for up to 24 hours and new saves stay pending until 00:00 UTC. Raise the tenant's cap with `ops system policy`, or lower the refresh caps. |
