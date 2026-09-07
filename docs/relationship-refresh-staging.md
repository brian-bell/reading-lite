# Relationship refresh staging rollout

Issue #175 slice 4. On 2026-09-07 the owner authorized **one clean actual nightly
staging run** before acceptance and production enablement, replacing the earlier
“several nights” rollout window. Production refresh remains disabled until that
check passes.

## Deployed candidate and preparation

- PRs #333 and #334 merged; main includes both at `522ad64`.
- Staging candidate: `7030c9a`; Worker version
  `12986662-f68d-409c-8fed-d173bb715907`.
- Deployed through `ops deploy worker --env staging --release-sha <full SHA>
  --execute`; migration `0014_relationship_refresh_jobs.sql` applied successfully.
- Staging gate is `RELATIONSHIP_REFRESH=1`, with
  `REFRESH_MAX_JUDGEMENTS=2`. Nightly cron is `7 3 * * *` (03:07 UTC).
- `ops staging setup --execute` created/confirmed the resources and refresh
  queue/DLQ. Setup now recognizes Vectorize `duplicate_name` and Queue
  “already taken” responses as existing resources.
- All six pre-existing staging queues had zero backlog before paid work resumed.
  The existing corpus contained 129 ready and 10 failed readings; no production
  corpus copy or new fixtures were required.
- Staging paid-work policy changed from version 7/disabled to version 8/enabled,
  retaining the $2 global and $1 founder-tenant daily budgets.
- The production refresh queue and DLQ were provisioned after their absence
  blocked the automatic deployment. Provisioning did not enable its gate.

## Live smoke evidence

At `2026-09-07T15:50:55.252Z`, the scheduler function was invoked locally with
remote staging D1/R2 adapters and the real staging queue producer. All scan and
judge jobs then ran in the deployed Worker. This tests the queue flow; it is
**not evidence of an actual cron invocation**.

| Check | Observed result |
|---|---|
| Scan before judgement | All 129 targets scanned before judge fan-out |
| Candidate selection | 106 candidates |
| Cap | Exactly 2 jobs reserved/dispatched; 104 candidates retained |
| Cursor after smoke | scan_offset 129, judge_offset 2, dispatched 2, limit 2, pending empty |
| Judgements | 2 saved checkpoints and published relationship results |
| Publication | Exactly 2 manifests changed; only relationship fields changed |
| List consistency | Both verdicts match manifests; no other list fields changed |
| Ready data | 129 ready readings before and after; all other manifest fields preserved |
| Paid work | 2 reservations, 2 settlements, total 7,602 microdollars ($0.007602) |
| Duplicate delivery | Both completed judge identities redelivered; no additional provider calls or spend |
| Runtime logs | 12 refresh queue events, no exceptions, no non-OK outcomes |
| Queue completion | Refresh backlog returned to zero |

The completed identities are `rd_07P4GTB63J` and `rd_09RR0NZ3QG`, both under
run identity `2026-09-07T15:50:55.252Z`.

Local verification: 3,975 tests across 251 files pass, typecheck passes, staging
build dry-run succeeds, and structured review reports no actionable findings.
Regression tests cover gate-off, CAS/reprocess/purge races, provider failures,
spend admission, deferrals, duplicate dispatch, and list recovery. These failure
paths were not destructively injected into the live staging corpus.

Private snapshots, scripts, logs, and checkpoints are retained in the ignored
`.refresh-rollout.tmp/` directory on the operator checkout. They contain corpus
content and must not be committed. Smoke logs originated under
`/tmp/reading-lite-refresh-rollout/` and are copied into that private directory.

## Single-night acceptance: pending

Observe the actual **2026-09-08 03:07 UTC** trigger (September 7 at 11:07 p.m.
America/New_York). A thread follow-up starts at 11:05 p.m. to capture the run.
Do not reset the cursor or manually advance its budget to manufacture evidence.

Expected continuation from the smoke baseline:

1. The scheduled event advances `budget_at` from September 7 to the actual
   September 8 cron time, retaining the original scan/run identity.
2. `scan_offset` remains 129; the next two candidates advance `judge_offset`
   from 2 to 4, with at most two reservations in the new nightly budget.
3. Both new jobs finish with saved results, matching manifest/list verdicts,
   no unrelated manifest changes, and no duplicate paid dispatch.
4. Refresh queue and DLQ are empty after completion; logs show no exceptions
   or unresolved provider outcomes. Spend remains within existing budgets.
5. Record the observed timestamps, results and costs here before accepting
   #175 and updating #170. Only then enable production through the normal
   reviewed configuration and CI/release flow, initially capped at two jobs.

If the scheduled run fails or evidence is missing, leave production disabled
and retain the cursor/checkpoints for diagnosis.
