# Issue 286: staging email-reuse evidence, 2026-09-05

This staging drill exercised **real signup, invite_only address ownership, and
email reuse after automatic teardown** for a captain-authorized disposable
address. It fills the signup-shaped gap left by
[#284](https://github.com/brian-bell/reading-lite/pull/284), which proved HTTP
deletion, ordinary wipe, and automatic teardown with a synthetic tenant and
did not exercise signup, verification, or reuse through a new signup.

This is evidence for the observed **staging** paths, not production reuse, not
open signup mode, and not an unconditional zero-residue certificate. Wipe
completion recorded **`residue = 0` on `wipe_progress` / `account_deletions`**
for an empty tenant (no readings). That is not a claim that Durable Object
storage, AuthRateGuard windows, or every scanner source were empty. Scanner
limits remain those recorded in the
[S5 staging drill](195-staging-drill-2026-09-05.md)
(`residue:false, incomplete:true`, DO uninspected).

All times are UTC on September 5, 2026. This is a historical report, not a
statement of current staging state. Operational procedures remain in the
[operations runbook](../operations.md) (invite trap and staging rehearsal).
[#286](https://github.com/brian-bell/reading-lite/issues/286) tracks this
proof; [#195](https://github.com/brian-bell/reading-lite/issues/195) and
[#263](https://github.com/brian-bell/reading-lite/issues/263) remain the
deletion-acceptance parents. Adding this document does not close those issues
or update their GitHub threads.

## Source and scope

- Environment: staging only. Worker `reading-lite-staging`; D1
  `reading-lite-control-staging`; R2 / Vectorize `reading-lite-staging`.
- Host: `https://reading-lite-staging.bbell.dev`. Worker JSON probes that must
  distinguish 401 from Cloudflare challenge HTML used the
  `*.workers.dev` origin (see A5).
- Live policy: `signup_mode = invite_only`; `TENANT_DATA_PLANE=1`; ordinary
  cron `*/15 * * * *`. Signup was not flipped to `open`.
- Disposable address (captain-authorized staging mail only):
  `gepogot984@liondapt.com`.
- No production operations, no production account deletion, no allowlist
  change in this documentation step, and no manual `DELETE` of `users` or
  `wipe_progress`.
- This report makes no application source change beyond the document itself.
  Raw magic-link URLs, cookie secrets, Resend keys, and machine paths are
  omitted.

## Acceptance map (A0–A7)

These labels map [#286](https://github.com/brian-bell/reading-lite/issues/286)
acceptance plus the optional reading fixture. They are not a claim that every
[#195](https://github.com/brian-bell/reading-lite/issues/195) cleanup bullet
is now satisfied.

| ID | Requirement | Result |
|---|---|---|
| A0 | Staging-only prep; authorized mail; preserve existing accounts | Observed |
| A1 | Real signup and ownership/challenge associations | Observed |
| A2 | Optional reading fixture / corpus isolation | **Skipped** (N/A) |
| A3 | Reuse refused while deleting; automatic wipe and teardown | Observed |
| A4 | `invite_only`: consumed invite does not grant signup; fresh invite after teardown creates a new tenant | Observed |
| A5 | Old credentials invalid; new tenant cannot see old data | Observed for sessions; corpus N/A |
| A6 | Document released-address / invite-trap / residue limits | This section |
| A7 | Sanitized evidence; GitHub issue comments | This file; comments are Quartermaster's |

### A0 — Prepare

The address was a disposable inbox, authorized for staging mail only. Staging
stayed `invite_only`. Existing accounts were preserved: founder
`usr_24b3629b-a738-440a-9122-99ee70e04aa1` remained `active` with
`deleting_at_ms` NULL throughout. No production account was touched.

A live mail allowlist overlay was applied so the disposable address could
receive magic-link mail. **Restoring the allowlist after the drill is operator
hygiene and is not proven in this document.**

### A1 — Signup (Tenant A)

Tenant A signed up at **11:47:35.396Z**:

| Field | Value |
|---|---|
| Tenant A | `usr_e6422da8-13f9-4d93-be5e-dc8962136084` |
| Session A | `ses_ddc1071c-e1a6-4db4-a369-1db9f45133e9` |
| Signup challenge | `ml_e1da45e1-167b-4211-8f19-bdf393ef892a` (`purpose=login`, consumed) |
| `completed_user_id` | Tenant A |
| Invite consumed | same timestamp as create / `email_verified_at_ms` |
| API tokens minted | **0** |

The PREP invite that enabled this signup was inserted at **11:41:46.182Z**.
Inbox for this phase included the signup magic-link mail (URL omitted).

### A2 — Optional reading fixture (skipped)

No reading was submitted for Tenant A. R2 `u/{A}/` was empty; `vector_ledger`
rows for A were 0. **Corpus isolation is N/A.** Session/token isolation is A5.

### A3 — Reuse refused while deleting; automatic teardown

`DELETE /api/account` succeeded at **11:49:57.163Z**. Tenant A became
`status=deleting`; session A was revoked with `revocation_reason=account_delete`.
The founder stayed active. No force-wipe envelope was used.

While `status=deleting`, a reuse `POST /api/auth/challenge` returned **HTTP 200**
with the generic ok body (anti-enumeration). **No second magic-link mail was
sent.** The inbox showed signup mail plus the deletion-started notice only.
D1 still held only the original signup challenge; no new challenge row and no
new `mail_sent_at_ms` after delete.

`deleting_at_ms` was backdated at **11:59:08.372Z** by 8.04 days
(`now − 8d − 1h` → `1787914748372` = 2026-08-28T10:59:08.372Z) with
**`changes=1`**, so ordinary cron could start a new wipe without `{ force: true }`.
Only this deleting row was updated.

The ordinary **12:00** cron completed the wipe at **12:00:06.511Z**:

- `completed_at_ms = first_completed_at_ms = 1788609606511`
- `residue = first_residue = 0`
- `force = 0`
- `phase = done`; `objects_deleted = 0` (empty tenant; A2 skipped)

The ordinary **12:15** cron ran automatic S4 teardown at **12:15:26.000Z**
(`torn_down_at_ms = 1788610526000`). After that, `users` and `wipe_progress`
for Tenant A were gone. Neither row was deleted by an operator `DELETE`.

Retained audit (queried columns):

```json
{
  "tenant_id": "usr_e6422da8-13f9-4d93-be5e-dc8962136084",
  "deleting_at_ms": 1787914748372,
  "completed_at_ms": 1788609606511,
  "residue": 0,
  "first_completed_at_ms": 1788609606511,
  "first_residue": 0,
  "torn_down_at_ms": 1788610526000
}
```

`residue = 0` here is the wipe/audit flag for this empty tenant. It is not a
repeat of the S5 scanner's full-source verdict, and it is not a production
claim.

### A4 — Fresh invite after teardown (Tenant B)

Under `invite_only`, teardown removed Tenant A's consumed invite, so that
spent row could not grant signup. A **fresh** invite was inserted only after
the `users` row was confirmed gone, at **12:23:07.145Z** (invite-trap timing
in the runbook).

Tenant B signed up at **12:28:13.892Z**:

| Field | Value |
|---|---|
| Tenant B | `usr_1fd1e0e2-4a19-4a3e-af4c-e09f910d4ffa` |
| Created / verified / invite consumed | 12:28:13.892Z |
| Challenge | `ml_308850eb-6850-43da-a72c-855629e6029c` (`purpose=login`, consumed) |
| `completed_user_id` | Tenant B |
| Session B | `ses_a208c44e-ea1f-458b-a7cc-693ed8f12f4f` |

Tenant B is a **new** tenant id. Exactly one `users` row existed for the
disposable address after reuse. Founder remained active.

### A5 — Old credentials and isolation

| Check | Observation |
|---|---|
| Session A selector → `GET /api/whoami` | **401** `{"error":"unauthorized"}` on the workers.dev host |
| Session A selector → `GET /api/readings` | **401** (same) |
| Same requests on the custom domain without a browser User-Agent | Cloudflare challenge **HTML**, not Worker JSON — not scored as 401 |
| D1 sessions / API tokens for Tenant A | **0** |
| Tenant A minted API tokens | **0** (no real old bearer to replay) |
| R2 `u/{A}/` and `u/{B}/` | both empty |
| Tenant B readings | 0; cannot demonstrate corpus isolation |

Corpus isolation is N/A because A2 was skipped. Session isolation is the 401
plus D1 absence. A dummy HMAC suffix on the saved selector is enough once the
session row is gone; a captured cookie secret was not required and is not
included here.

### A6 — Limits (do not over-read)

- **Invite trap:** do not insert a fresh invite while `status=deleting`.
  Teardown sweeps a consumed invite and any invite for the account's current
  address. This drill waited until `users` was absent (A4). It did not
  negatively test inserting-during-deleting.
- **#284 vs this drill:** #284 proved wipe and teardown without signup-shaped
  `auth_challenges` / `signup_invites`. This drill is signup-shaped reuse on
  staging. It does not replace #284's repair, HTTP fence matrix, or
  preservation inventory.
- **Residue:** `wipe_progress` / `account_deletions` recorded `residue = 0`
  for this empty tenant. Known inert residues and scanner
  `incomplete:true` limits remain as in #284. Durable Objects were **not**
  inspected. AuthRateGuard is **not** claimed purged.
- **Allowlist:** set for the disposable address so staging mail could be
  delivered. Restore is ops hygiene and is **not** proven here.
- **Not claimed:** production email reuse; `signup_mode=open`; a clean DO;
  zero residue across every source; S7 legacy cleanup.

### A7 — Evidence file; GitHub comments

This file is the sanitized evidence. Quartermaster comments on GitHub
[#286](https://github.com/brian-bell/reading-lite/issues/286),
[#195](https://github.com/brian-bell/reading-lite/issues/195), and
[#263](https://github.com/brian-bell/reading-lite/issues/263)
separately. This document does not post those comments and does not change
issue status.

## Timeline

| UTC | Event |
|---|---|
| 11:41:46.182 | PREP invite insert for the disposable address |
| 11:47:35.396 | Tenant A created, verified, invite consumed, session A minted |
| 11:49:57.163 | `DELETE /api/account`; A `deleting`; session A revoked `account_delete` |
| (while deleting) | Reuse challenge HTTP 200 generic ok; no second magic-link mail |
| 11:59:08.372 | `deleting_at_ms` backdated 8.04d, `changes=1` |
| 12:00:06.511 | Ordinary cron wipe complete; `residue=0`, `force=0` |
| 12:15:26.000 | Automatic teardown; `users` + `wipe_progress` gone |
| 12:23:07.145 | Fresh invite insert (after `users` absent) |
| 12:28:13.892 | Tenant B created, verified, invite consumed, session B minted |

## Selectors recorded before attribution was erased

Recorded while Tenant A still existed, then confirmed absent after teardown:

- Tenant A `usr_e6422da8-13f9-4d93-be5e-dc8962136084`
- Session A `ses_ddc1071c-e1a6-4db4-a369-1db9f45133e9`
- Signup challenge `ml_e1da45e1-167b-4211-8f19-bdf393ef892a`

After teardown those D1 rows were gone (0 sessions/tokens/challenges/invites
for A). The audit row above is the surviving handle.

## Validation and evidence provenance

Documentation only. Adding this file does not rerun staging operations or
application tests. No production commands were issued for this report.

Observations were transcribed from the captain-authorized staging drill
(PREP invite, signup, delete, backdate, ordinary wipe/teardown, fresh invite,
Tenant B signup, and A5 HTTP probes). Raw logs, magic-link URLs, cookie
secrets, Resend keys, and machine-specific paths remain operator-local and
are not attached to this repository.
