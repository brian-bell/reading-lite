# Issue 286: second staging email-reuse run, 2026-09-05

This is a separate historical run, supplementing the
[original drill](286-staging-email-reuse-2026-09-05.md). Its source is the
[published live follow-up evidence on PR302](https://github.com/brian-bell/reading-lite/pull/302#issuecomment-5552386494).
All times below are UTC on September 5, 2026. This documentation amendment
transcribes existing evidence; it does not rerun staging operations.

The original run remains the evidence for refusal while the account is deleting.
This second run closes the original nonempty-corpus, real-credential replay,
and post-teardown spent-invite negative-test gaps. The two runs used different
accounts and must not be combined into one lifecycle.

## Fixture and positive baselines

Staging remained `invite_only` with `TENANT_DATA_PLANE=1`. Authentication used
real temporary-mail delivery and browser magic-link redemption; the founder
was preserved. Credential secrets and magic-link URLs are omitted.

| Selector | Second-run value |
|---|---|
| Tenant A | `usr_81d2d901-9fd4-47e0-8100-9e39b5a555b3` |
| Tenant B | `usr_5d4f5a78-1711-42e0-95f5-a9094ee23a2e` |
| Reading | `rd_6RY4B8JMFX` |
| Synthetic marker | `amber-orchard-286` |
| Source URL | `https://example.com/reading-lite-286-followup-20260905` |

The Markdown import returned 202 at 13:42:11 and became ready at 13:42:28
through real summarization and embedding. Before deletion, the inventory held
eight R2 objects and one composed, tenant-namespaced vector.

The actual session and a newly minted `readings:read` bearer each returned 200
for whoami, list, detail, content, and URL lookup. An earlier accidentally
logged-out session was excluded from the evidence; replay used the subsequently
authenticated session and the same bearer that passed these baselines.

## Observations

| Check | Observed result |
|---|---|
| Normal A deletion | `DELETE /api/account` returned 200; retained real session and bearer then returned 401 JSON on whoami and all four previously successful reading routes |
| Ordinary wipe | Completed at 13:47:43.872; current and first residue flags were 0; R2 prefix empty and known composed vector absent |
| Automatic teardown | `torn_down_at_ms=1788616826000`; by 14:01:49 A user, invite, and challenge rows were absent; durable audit retained |
| Negative signup before fresh invite | At 14:02:10.937, no-cookie challenge returned generic 200; users/invites/challenges/issued-login/mail-marker counts stayed 0; refreshed mailbox had no new email |
| Paired fresh-invite positive | Exactly one fresh invite inserted after the negative check; a real delivered link created B at the same email with a different tenant ID |
| B positive baseline | whoami returned 200 for B; list and marker search returned 200 with empty results |
| B requesting A fixture | Detail, content, raw content, and URL lookup each returned 404 with expected tenant B |
| Tenant mismatch | B session with expected tenant A returned 412 |
| Old credentials after reuse | Exact original A session and bearer each still returned 401 JSON |

A's grace acceleration was one conditional timestamp update after normal
DELETE: original `deleting_at_ms=1788615865913`, accelerated value
`1787924712000`, exactly one changed row. No forced cron, schedule change,
force enqueue, or manual users/wipe-progress deletion was used.

The negative signup was paired with the immediately successful fresh-invite
signup through the same path after an elapsed rate window. Internal rate
counters were not inspected; the paired control is evidence, not a claim
that every transient rate-limit or mail-provider possibility was excluded.

## Relationship to the original acceptance map

| Original label | First-run evidence retained | Second-run or later supplement |
|---|---|---|
| A2 | Reading fixture skipped; corpus isolation N/A | Nonempty fixture, ordinary cleanup, and B denied access to A's reading |
| A3 | Refusal while deleting; automatic teardown | Separate automatic wipe/teardown observed; original run supplies deleting-time refusal |
| A4 | Fresh invite succeeded; consumed-invite refusal inferred | Negative signup before fresh invite, followed by successful fresh-invite signup |
| A5 | Dummy-HMAC session-selector probe and D1 absence; no real bearer or corpus baseline | Actual working session/bearer replay before and after deletion/reuse, plus corpus isolation |
| A7 | Publication was pending when the report was written | Existing comments on #286/#195/#263 fulfilled publication; second-run evidence published separately |

Original publication links:
[#286](https://github.com/brian-bell/reading-lite/issues/286#issuecomment-5552034639),
[#195](https://github.com/brian-bell/reading-lite/issues/195#issuecomment-5552034799),
and [#263](https://github.com/brian-bell/reading-lite/issues/263#issuecomment-5552034705).
The [second-run #286 acceptance update](https://github.com/brian-bell/reading-lite/issues/286#issuecomment-5552392070)
links the fuller PR supplement. Those original parent comments describe the
first run; they are not second-run observations. The subsequent reconciliation
comments on [#195](https://github.com/brian-bell/reading-lite/issues/195#issuecomment-5552516122)
and [#263](https://github.com/brian-bell/reading-lite/issues/263#issuecomment-5552516281)
link the second run directly. [#286 was closed as completed](https://github.com/brian-bell/reading-lite/issues/286#issuecomment-5552516364)
with its accepted limits; both parent issues remained open.

## Audit, accepted limits, and cleanup

A's read-only scoped residue scan reported **`residue:false, incomplete:true`**.
Attributable R2, Vectorize namespace/inventory, vector ledger, and D1 sources
were clear; the durable deletion audit remained. Wipe residue flags and this
scanner result are different observations.

The user accepted these visibility limits as non-blocking for #286:
uninspected Durable Object internals, AuthRateGuard state, queue/in-flight
activity, snapshot/concurrency bounds, and global legacy scope. This does not
certify those surfaces, resolve #288, or establish full #195 acceptance.
#285 legacy cleanup remains explicitly deferred, not completed.

One HTTP baseline omission remains: `/content/raw` was not requested before
deletion. Its `raw.md` object existed in the pre-delete inventory, and B's raw
request returned 404. No production reuse or open-signup result is claimed.

B's normal account DELETE returned 200; D1 confirmed deleting with zero live
sessions/tokens. B was not backdated: physical cleanup remained subject to
normal seven-day grace at the end of this run. This report does not assert
that B has since been physically removed.

The staging mail allowlist was restored to its original empty string with all
36 bindings preserved. Second-run restoration deployment:
`108c3775-284a-451f-9c72-5f3ef2cc8119`; Worker version:
`00fe57fe-c4f8-4c1c-ad74-9b33303ffbbd`. This was a settings-only update, not a
source deployment. Founder remained active. These are separate from the
original run's 12:49 restoration event.

## Verification boundary

PR302 merged at 14:17:24 as `a7c53e5d5d1360a37932dd76c92cdd3999061409`.
Its checked-in file contains the first run; its published follow-up comment
contains the second. This amendment preserves that provenance and historical
distinction. No live provider state or application tests were rerun to write
this supplement. The functional #286 evidence is accepted with the limits
above; broader cleanup acceptance remains under #195/#288.
