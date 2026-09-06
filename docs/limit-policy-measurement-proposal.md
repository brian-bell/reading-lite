# Issue 193: Terra/high measurement proposal

> Historical 193-v2 proposal. [Revision 193-v2.1](limit-policy-measurement-proposal-193-v2.1.md)
> changed the context fixture to 90 seeds. Preparation later completed, and paid
> measurement was deferred. The [handoff](193-v2.1-handoff.md) records the latest
> decision; the proposal below does not authorize execution.

Proposal version: **`193-v2`**, September 6, 2026 UTC. Status: **read-only inventory complete; paid execution and production policy not approved**. [Issue #193](https://github.com/brian-bell/reading-lite/issues/193) criteria 2 and 3 remain accepted. This proposal addresses the economic evidence for criterion 1 and does not reopen the accepted control drill.

Brian authorized the read-only cohort inventory and this versioned proposal. That authorization does not include paid calls, staging data writes, policy changes, publishing, or production activation. The accompanying [inventory](limit-policy-cohort-inventory.md) records observations, selection, limitations, and private evidence paths. `193-v1` remains the historical staging proposal; this document does not overwrite its approval or results.

## Outcome and decision rule

Establish the cost and reservation-headroom distribution for the current hosted OpenAI Terra/high pipeline on a frozen, real-content cohort. Use the result to propose numeric tenant/global production limits with explicit financial rationale and human sign-off.

Retain the provisional **$3 monthly provider-cost envelope at 60 readings** as the decision target: weighted mean all-in charge ≤$0.05 per submitted reading, while separately reporting charge per successful ready reading. Do not call a low mean a pass when paid failures make the successful outcome unaffordable. At 60 successful readings, both measures and the observed failure rate must be visible to the approver. Exclude stress-only cases from the representative mean but report their operational and cost consequences.

If the mean exceeds $0.05, propose a reduced allowance or an explicitly evaluated model/effort change before activation. If uncertainty spans $0.05, collect more observations or seek an explicitly bounded beta-loss decision; do not round to a pass. Report a stratified bootstrap interval for the mean, alongside the raw per-stratum results. With only ten samples per stratum, the interval and p95 are provisional rather than proof of tail safety. Zero uncertain outcomes in this run would not establish a zero uncertainty rate.

The product brief's $6/month or $60/year revenue and $4.90/$4.46 estimated monthly net are planning assumptions, not verified current billing economics. At the $3 cost envelope they leave $1.90/$1.46 before infrastructure and other costs. Neither those figures nor historical batch discounts establish hosted margins.

## Fixed cohort and measurement lanes

**Primary: 60 readings**, ten from each length/selected-connection stratum in the inventory, with population weights N/544. **Stress: five additional longest sources**, reported separately. Use the exact private selection packet and recorded hashes; no substitutions based on outcomes. A missing/changed input is a preflight failure requiring a recorded revision.

Prefer a prospective **hosted staging** run with production captured Markdown, realistic similarity context, and the actual three paid stages. New staging artifacts and any context seeding require execution authorization. Preserve the original source identity in the private mapping and use a distinct staging tenant or a proven collision-free scope. Do not reprocess production readings. Replaying Markdown measures processing after capture; it does not measure live extraction success or external extraction expenses.

The ready/captured cohort is conditioned on historical success. Report the 14 current failures and 15 raw-only records as exclusions. Do not infer customer-wide cost per save from this cohort. Before broad customer approval, observe a consecutive prospective intake window (including failures) under an explicitly approved beta allowance, or explicitly accept this founder-corpus limitation in a time-limited approval. No new live retry fault injection is required to re-prove criteria 2 and 3.

The local comparison runner is useful only as a supplemental summary-cost screen. It omits hosted embedding/guard/retry accounting and reconstructs selected connections. Its printed estimate does not enforce a cap; #319 remains open. Do not execute that runner under the staging financial authorization below or represent it as an all-in economics result.

## Proposed financial and execution boundary

Candidate authorization for a later approval: **up to $25 additional hosted staging budget charges**, shared across cohort work, the five stress readings, any explicitly enumerated paid context preparation, retries, and retained uncertain maxima. This is a proposed loss ceiling, not an expected invoice or a guarantee that all 65 readings finish. No paid run is authorized now.

The frozen read-only quotes total $15.071564 for one summary and source embedding per target. That excludes new summary embeddings and retries, and hosted context may differ. The $25 candidate provides $9.928436 beyond those partial quotes, but that difference is not a proven worst-case allowance. Recalculate after exact staging context is known. If preparation or quotes cannot fit, shrink the approved execution scope through a new revision or request another explicit allowance; never increase it automatically.

Use the existing hosted guard, with global and selected-tenant absolute daily caps set to their observed baseline plus the approved allowance. Require no unrelated staging paid work or outstanding reservations so both deltas are attributable. Both budgets bound the same shared allowance; they are not additive. Disable paid work before preparation, verify runtime/migration/catalog, then enable only within approved caps. Capture original policies and versions and keep all counters intact.

Run serially, target at most 19 new imports in any sliding hour, and finish within one UTC admission day. Plan a five-hour operator window with at least six hours before midnight; confirm the live intake/monthly allowances support the exact schedule before approval. Do not enqueue the whole cohort to wait for hours: submit the next reading only after its predecessor is terminal, and pause when the hourly window has no headroom. Submit fewer or stop if time, quota, or spend constraints prevent completion. Long processing/deferral is an observed failure or incomplete result, not permission to extend into another daily allowance.

The $1 production candidate tenant cap must not be used as the measurement cap: at least one frozen stress request needs a $1.662126 reservation. Keep stress admission behavior visible in the production proposal. A maximum request larger than a full daily budget can remain unadmittable across resets until it expires; a cheap expected settlement does not solve that.

## Mandatory read-only preflight before presenting execution approval

The [September 6 preflight](limit-policy-staging-preflight.md) is complete. Staging runtime/pricing/accounting/backlog checks passed, but execution is not ready: an identity-preserving 91-reading context copy and supported quota/reservation visibility are prerequisites. The target map is 54 new imports plus 11 reprocesses; do not import all 65 under new IDs after seeding.

1. Record the actual staging Worker version, source commit, migration state, tenant ownership, current policy versions, queue state, current daily accounting, and UTC deadline. Verify available tenant/monthly slots for the chosen scope. Never infer today's staging state from the earlier drill's retained-state report.
2. Inspect the staging similarity corpus. Produce the exact context-preparation manifest, counts, copied object/vector scope, paid request matrix, and costs if needed. An empty staging corpus is not an acceptable stand-in for connected inputs. Existing APIs do not inject a frozen full top-K into the hosted consumer; no new harness or route is authorized here. If a safe supported preparation cannot be specified, return that concrete prerequisite before paid execution.
3. Resolve a stable source-to-staging mapping and validate ownership/collision behavior. Record each source/content/context hash, target model/effort/service tier, prompt/schema hash, and pricing catalog. Reverify official pricing against catalog 1. Record differences between reconstructed context and actual hosted context; keep per-reading context counts and request fingerprints for the measurement.
4. Requote the exact supported requests, including explicitly planned context setup. Use catalog request bounds, not the comparison runner's historical-token estimate. Settle unknown future summary-embedding size and retries through the live guard; they remain inside the same allowance.
5. Present the final action list: exact environment/tenant, mutations, cap values relative to fresh baselines, expected import schedule, retained evidence/artifacts, stop time, and restoration. Obtain approval for that concrete packet. This proposal is financially bounded but is **not yet an execution-ready command plan**, because live staging state and context preparation have not been established.

## Evidence collected during execution

Capture deployment/configuration provenance and source mapping before the first call. For every paid operation retain stage, reading/attempt/operation identity, request fingerprint, quote maximum, admission day, usage, charged settlement or retained maximum, and outcome. Use complete `paid_spend` diagnostics together with authoritative tenant/global counters. Logs alone are not an accounting authority.

Reconcile sum of unique operation charges to both counter deltas. Count provider retries as new paid attempts; count guard-RPC replays once. Record source embedding, summary, and summary embedding separately, and retain failed/uncertain charges in the numerator. An unexplained delta prevents economic sign-off. Separate billable usage estimates from budget charges and provider invoice evidence.

Record time from staging intake to terminal state and stage timings, failure reason, context count, input/output/cached/reasoning tokens, and every defer reason. Reading creation dates and old last-attempt timestamps do not substitute for measured time to ready. Check schema validity and source adequacy; inspect the ten most expensive results and all failures/stress cases so cheap but unusable outputs are not accepted as healthy economics.

Report weighted mean and weighted empirical p50/p95 for the main cohort, unweighted per-stratum statistics, maxima, a confidence interval for the mean, and failure/uncertainty counts. Preserve denominators for submitted, completed, failed, and unresolved readings. Report cost per successful ready reading in addition to cost per submission; do not discard failed targets or replace them. Stress results and context-preparation costs are separate lines; setup still counts toward the $25 execution allowance.

Include sensitivity calculations at 1%, 5%, and 10% additional uncertain dispatches charged at observed conservative maxima. Label them scenarios, not observed probabilities. State that extraction, email, storage, Worker/queue activity, and payment fees are outside this provider-cost measurement unless independently measured.

## Production policy decision after measurement

Draft a separately approved version containing named tenants or beta population, effective time, exact values, policy-row versions, catalog version, economic evidence, accepted residual risks, review date, and operator identity. Candidate values remain 20 submissions/hour, 60 readings/calendar month, tenant/global concurrency 2/3, tenant/global daily spend $1/$5, processing lease/heartbeat 10 minutes/30 seconds, defer interval 15 seconds, maximum defer age 24 hours. None is activated by this document.

- $1/$5 daily caps are incident limits. $5/day permits $155 over 31 days for covered hosted charges; neither cap enforces the $3 tenant-month target.
- Decide how sources with request maxima above $1 are handled before approving that tenant cap: accept explicit deferral/failure behavior, revise admission/product constraints, or approve a different budget. Do not assume tomorrow's reset makes them admissible.
- #320 remains open: a delayed/released reading reservation can bypass the intended reading quota. Fix it before relying on 60/month as an enforceable economic bound, or explicitly accept the residual under a bounded beta loss policy. Spend enforcement remains independent.
- The policy CLI changes spend/catalog/paid-work permission only. Applying 60/month needs a reviewed existing-tenant update and new-account-default change; do not overwrite founder allowances implicitly. Deferral settings are compiled. The original drill did not prove concurrency ceilings, and this serial measurement does not either.
- Keep #319 operator enforcement and #316 Anthropic verification separate. No Anthropic, batch, judgment, or comparison provider calls are included here.

Proposed initial review: 14 days after activation or the first 200 completed beta readings, whichever comes first. Review immediately on an unexplained charge, unadmittable ordinary input, repeated long deferrals, or mean cost above $0.05. A monitor is not installed by this document. A production beta may explicitly accept incomplete representative economics as a temporary loss-budget decision, but that must be recorded as such rather than as a measurement pass.

## Stop and restoration

Stop new intake on unknown accounting, content/provenance drift, unplanned staging activity, unsupported pricing, lost evidence capture, exhausted allowance, or the deadline. Disable paid work using a freshly read policy version; in-flight authorized calls may finish against existing reservations. Never reset counters, refund uncertain maxima manually, auto-increase the allowance, or carry the run into a new daily budget.

After completion or abort, retain measurement artifacts and charges, restore selected tenant limits with version checks, and leave staging paid work disabled unless the later approval explicitly specifies another state. List any pending readings and their ages; do not call an aborted run clean. Do not delete staged content as implicit cleanup. Publishing evidence, production activation, and closing #193 remain separate authorized actions.
