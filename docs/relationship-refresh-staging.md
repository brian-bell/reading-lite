# Relationship refresh staging rollout

> **Historical evidence (2026-09-07/08).** Production refresh is enabled; the
> current gate, caps and queues are in
> [operations](operations.md#relationship-refresh-queue-plumbing). The manifests,
> list rows, D1 and Vectorize named below are the pre-PostgreSQL stores
> ([ADR 0005](decisions/0005-postgresql-storage.md)).

Issue #175 slice 4. On 2026-09-07 the owner authorized **one clean actual nightly
staging run** before acceptance and production enablement, replacing the earlier
“several nights” rollout window. The actual 2026-09-08 scheduled run passed that check; production enablement
uses the same two-judgement cap and retains existing spend budgets.

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

## Single-night acceptance: passed

The actual **2026-09-08 03:07 UTC** cron fired with
`scheduledTime=2026-09-08T03:07:13.000Z`. The captured scheduled event used the
staging candidate version above, returned `outcome=ok`, and had no exceptions.
The owner-authorized single-night acceptance window is satisfied.

| Check | Observed result |
|---|---|
| Actual scheduler | `7 3 * * *`, recorded before any manual invocation |
| Budget rollover | `budget_at=2026-09-08T03:07:13.000Z`; original run identity retained |
| Scan/cursor | scan_offset remained 129; judge_offset advanced from 2 to 4 |
| Nightly cap | dispatched 2, limit 2, pending empty; 102 candidates remain |
| New judgements | `rd_0HCB4V1KVQ` and `rd_0M9KT1535F`, both saved and published |
| Protected data | Only expected relationship fields/list verdicts changed; all 129 readings stayed ready |
| Provider work | 2 reservations and 2 settlements; 7,048 microdollars ($0.007048) |
| Runtime | 4 refresh queue events; zero exceptions or non-OK outcomes |
| Completion | Refresh queue and DLQ backlogs zero |

Read-only verification at `2026-09-08T03:08:24.005Z` compared the corpus against
the retained pre-smoke baseline. Exactly four expected manifests differed (two
smoke and two nightly); no unrelated fields differed and every list verdict
matched its manifest and saved checkpoint. No cursor reset or manual budget
advance was performed for this run.

Private evidence is retained as `nightly-tail.jsonl`, `nightly-summary.json`,
`nightly-metrics.json`, `latest-observation.json`, and `verification.json` under
`.refresh-rollout.tmp/`. [Acceptance was recorded on PR #343](https://github.com/brian-bell/reading-lite/pull/343#issuecomment-5578505577)
before production configuration changed; #175 and #170 reflect the authorized
one-night window.

## Production enablement

Enable `RELATIONSHIP_REFRESH=1` with `REFRESH_MAX_JUDGEMENTS=2` through the normal
reviewed configuration PR and CI/migration/Worker/SPA release chain. Existing
paid-work policies and budgets remain unchanged. The production refresh queue
and DLQ already exist and were empty at the acceptance check. Verify the deployed
gate, cap, cron, queue bindings, and release health after deployment. No manual
production refresh is required: its first run will be the next 03:07 UTC cron.
