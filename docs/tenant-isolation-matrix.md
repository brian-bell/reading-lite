# Tenant isolation CI matrix (#198)

The core contract is that tenant B cannot discover or mutate tenant A's
resources. Direct resource attacks must return the same status and body as an
unknown resource. Collection queries must return only the caller's records.
Scope denial precedes ownership lookup (403 for both foreign and unknown
resources). Positive controls prove an authorized owner can still do the work.

All test paths below run in `npm test` through `vitest.workspace.ts`. The
Worker CI jobs run `npm run test:workers:ci` and `npm run test:node:ci`, the
essential lists in `test/ci-scope.ts`.
A path outside those lists still runs in `npm test`. `npm run test:quiet` runs
the same full suite as `npm test`, with filtered logs, and preserves failures. No live credentials, production
writes, or paid provider calls are needed; integration tests use local
PostgreSQL with pgvector (a per-file database cloned from a migrated template),
local R2, and provider fakes. This validates the application boundary (every
query scoped by `tenant_id`, every R2 key under the tenant root), not
PostgreSQL's or Cloudflare's own isolation.
SSRF and cost-control coverage inventory is outside this work item.

Rows whose evidence reads _None_ were covered by Node-pool unit tests that
were removed when that pool was cut to three guard files
(`test/unit/{operator,control-plane,pipeline}-guards.test.ts`). Of those
rows, only the `--tenant` refusal of every corpus and export command is still
pinned, by `test/unit/operator-guards.test.ts`.

## Hosted reading routes

Evidence in this section and the next is `test/integration/tenant-guards.test.ts`
unless a row says otherwise: `readings look unknown` is its first test (every
HTTP, MCP and FrontendReads row compares a foreign id with an unknown one, then
checks the owner's R2 objects, queue, reading, embedding and URL claim are
unchanged), and `same URL` is its second. When the Workers pool was cut to four
guard files, several finer cases were removed; rows name what is no longer
pinned.

| Route | Adversarial behavior and owner control | Canonical evidence |
| --- | --- | --- |
| `POST /api/readings` | Two principals save the same URL and finish with independent ids, URL claims, list rows and embeddings. | `same URL` |
| `POST /api/readings/import-markdown` | Same URL imports in B's slot; A's manifest and lookup remain unchanged. | _None._ Its integration test was removed. |
| `GET /api/readings` | List/search exclude A from B; owner search finds A. | `readings look unknown` |
| `GET /api/readings/lookup` | Owner URL resolves; foreign URL equals never-submitted URL. | `readings look unknown`. That lookup writes nothing is no longer pinned. |
| `GET /api/readings/:id` | Owner succeeds; foreign equals unknown. | `readings look unknown`. The stale pending attempt annotation is no longer pinned. |
| `GET /api/readings/:id/content` and `/content/raw` | Owner succeeds; foreign equals unknown. | `readings look unknown` |
| `GET /api/readings/:id/diagnostics` | Owner receives diagnostics; foreign equals unknown rather than exposing URL ownership, objects or attempts. | `readings look unknown` |
| `POST /api/readings/similar` | Each caller's similar results hold only its own ids. | `same URL` |
| `POST /api/readings/:id/reprocess` | Foreign equals unknown; owner remains ready. | `readings look unknown`. The owner's later activation and queue-send rollback are no longer pinned. |
| `DELETE /api/readings/:id` | Foreign equals unknown and purges nothing. Owner delete removes the reading row, content, URL claim and embedding. | `readings look unknown`; the purge itself is `test/integration/publication-guards.test.ts`, `a purged reading leaves no row and takes no late write` |
| Connection/novelty output | A's second reading sees A's first as a neighbour/connection; B sees neither, and B's summarizer prompt names no reading. | `same URL` |
| Scope and expected-tenant headers | Read-only tokens are denied every MCP write before ownership lookup; a mismatched `x-expected-tenant` on account deletion refuses. | `readings look unknown`, and the credentials test (third). The per-route HTTP scope matrix and the other routes' pins are no longer tested. |

## MCP

The first test in `test/integration/tenant-guards.test.ts` runs its MCP rows
through `/mcp`:

| Tools | Contract |
| --- | --- |
| `get_reading`, `get_reading_content`, `get_diagnostics` | Owner-positive, foreign/unknown equality, R2 inventory unchanged and no enqueued job. |
| `reprocess_reading`, `delete_reading` | Foreign id matches an unknown id; the owner's reading survives ready. |
| `submit_url`, `import_markdown`, `reprocess_reading`, `delete_reading` | A read-only token gets identical 403 results for known and unknown inputs, with no R2 changes or jobs. |
| `list_readings`, `search_readings`, `list_inbox`, `get_inbox_item`, `discard_inbox_item`; per-tenant `submit_url` and `import_markdown` | _None._ Their integration tests were removed. |

The fourth test refuses an MCP request from a foreign Origin.

## Auth, queues and operators

| Surface | Evidence and boundary | Canonical tests |
| --- | --- | --- |
| Session/token list and revoke | Foreign ids match unknown responses and stay usable; lists omit the foreign resource. | `test/integration/tenant-guards.test.ts`: `one tenant's credentials cannot list, revoke or delete…`. The 412 on a mismatched `x-expected-tenant` is no longer pinned. |
| Email-change redemption | A user cannot redeem another user's email-change credential, and neither address changes. | Same test. The owner's own redemption and the mismatched-pin 412 are no longer pinned. |
| Revoke-all and logout | Cookie revoke-all clears only the caller's sessions; another tenant's session and token survive. | Same test. Bearer revoke-all and logout are no longer pinned. |
| Settings and identity | Each principal sees its own identity/settings; changing A leaves B unchanged. Mismatched `x-expected-tenant` on settings returns 412 and changes nothing. | _None._ Its integration test was removed. |
| Account deletion | B enters deleting; A stays active with a working session. Mismatched `x-expected-tenant` returns 412 and fences nothing. | Same test |
| Reading queue admission | An envelope claiming A with B's credential is acknowledged before processing or mutation. | `test/integration/deletion-guards.test.ts`: `reading queue acks an envelope claiming the founder…` |
| Reading DLQ | Identical id/key in A and B: only the admitted tenant's reading becomes failed and its job dead. | `test/integration/deletion-guards.test.ts`: `reading DLQ fails only the admitted tenant's reading of a shared id` |
| Retry and concurrent publication | Concurrent A/B terminal commits preserve separate list rows and embeddings. | `test/integration/tenant-guards.test.ts`: `two tenants save the same URL…`. That admission precedes retry dispatch is not pinned. |
| Digest preview, send and DLQ | Each tenant's digest preview and mail carry only its own readings, and the mail goes only to its own address, never to `EMAIL_TO`; digest DLQ changes its ledger, not reading state. | `test/integration/tenant-guards.test.ts`: `previews and sends each tenant's digest only to that tenant…`; `test/integration/deletion-guards.test.ts`: `digest DLQ fails only its tenant's ledger row` |
| Wipe and teardown replay | The target tenant's rows, embeddings, inbox items, refresh checkpoints and prefix are removed while another tenant's survive; saved reading, wipe and digest jobs cannot recreate torn-down data. | `test/integration/deletion-guards.test.ts`: `account wipe`, `saved jobs after hard teardown` |
| Destructive corpus maintenance | Drop, sweep and purge-connections delete only the selected tenant's rows and R2 root. A full neighbour refresh rewrites no other tenant's rows; connection and tension refresh write only the selected tenant's relationships. | _None._ Its Node-pool tests were removed. |
| Operator audit/recovery | Audit reads only the selected tenant's rows, never reports another tenant's corpus, and stamps provenance. Foreign audit refuses before API, annotation, sidecar or batch work. Bearer identity must match selected layout. | _None._ Its Node-pool tests were removed. |
| Batch ingest/recover | Batch configuration carries the selected tenant into its R2 root, its tenant-scoped PostgreSQL claims and publication, and resumable sidecars. Foreign audit/sidecar provenance refuses before provider work. | _None._ Its Node-pool tests were removed. |
| System policy and status | A tenant policy update leaves a second populated tenant unchanged. Status forwards the selected tenant to the private entrypoint, whose tenant details do not include a second tenant's guard reservations. | _None._ Its Node-pool and integration tests were removed. |
| Staging context preparation | The command keeps explicit, distinct production source and staging destination tenants through its reader seam. The artifact rejects foreign content keys and occupied destination state before any remote write. | _None._ Its Node-pool tests were removed. |

### Operator command applicability

The registry has one of the following tenant boundaries for every supported
command. This is an inventory of the command surface, not a replacement for
the behavioral tests named above.

| Commands | Boundary and evidence |
| --- | --- |
| `system lease-clear` | Explicit `--tenant` and `--attempt` selector; it observes and clears only that attempt's tenant and global lease rows, compare-and-set on the observed expiry. No automated test. |
| `system policy`, `system status` | Explicit tenant selector. The selected PostgreSQL row and private `OperatorStatus` request are covered by the populated two-tenant cases above. |
| Paid execution of `corpus refresh-connections`, `refresh-tensions`, `ingest`, `recover --batch`; `eval summarizer`; the compare-summary-effort script | A payer selector separate from the storage selector: `--billing-tenant` (defaulting to a real `--tenant`, required for `--tenant global`, pinned by a batch sidecar) names the one tenant whose cap, with the global cap, admits each request through the private `OperatorSpend` entrypoint. The entrypoint forwards only the four spend verbs for a valid tenant id (`test/integration/spend-guards.test.ts`, which also denies one tenant at its cap while another with the same cap is admitted); payer resolution has no automated test. |
| `corpus audit`, `drop`, `recover`, `ingest`, `sweep`, `refresh-neighbours`, `refresh-connections`, `refresh-tensions`, `purge-connections`, `redact-key-echoes` | Explicit corpus selector. Every query is scoped by `tenant_id` through the Worker's own stores (`scripts/pg-lib/operator-corpus.ts`), and the row-reading commands refuse `--tenant global`. The stores' tenant scoping is covered by `test/integration/publication-guards.test.ts` (`every store read is scoped to its tenant`); `test/unit/operator-guards.test.ts` pins that each of these commands refuses to run without `--tenant`. The commands themselves have no automated test. The commands retired in reading-lite-gh347.4.6 are listed in the [operator tooling inventory](operator-tooling.md). |
| `reading submit`; `import markdown`, `bookmarks`, `reddit`, `youtube`; `reading-list process` | Thin API clients with no operator tenant selector or direct corpus store. The bearer principal selects the hosted tenant, so their tenant boundary is the authenticated API/MCP matrix and the shared `readingApiFor` contract; `corpus recover` additionally verifies its explicit selector against `/api/whoami` before it invokes the same API. |
| `reading-list check` | Explicit `--tenant`; resolves each exported URL against that tenant's `reading_urls` rows, and refuses `--tenant global`. Its PostgreSQL path has no automated test. |
| `deploy worker`, `deploy wipe-check`, `deploy release`; `db migrate`; `staging setup`; `founder bootstrap`; `extract probe`; `eval summarizer` | Environment configuration, deployment, bootstrap, local extraction, or fixture evaluation. These commands have no caller-selected live corpus tenant. |
| `staging teardown` | Intentional environment-wide deletion: empties the entire staging R2 bucket, including every tenant's `u/{tenant}/…` objects, and deletes the staging Worker, queues, and bucket. It retains the staging PostgreSQL database. The boundary is the isolated staging environment; resource-name guards, plan-first execution, and credential preflight have no automated test. |
| `staging token-revocation` | Unpaid token lifecycle drill on one controlled staging account: the operator session's and the minted token's `/api/whoami` must both name `--tenant` before the drill proceeds. |
| `staging smoke` | Authenticated API workflow that submits, imports, and reprocesses readings in the bearer principal's tenant. It performs staging writes with `--execute`; target validation and workflow behavior have no automated test. |
| `extract agent` | Authenticated hosted polling/import client. It has no independent storage selector, so submitted work is scoped by its bearer principal; its imports use the hosted API boundary. |
| `staging prepare-context` | Intentional, explicitly named cross-tenant copy. It treats the source and destination as separate scopes and produces a local artifact only. |
| `account wipe`, `residue-scan` | Explicit account selector, with tenant status and audit queries keyed by that selector. Enqueue admission and residue verdicts have no automated test. `audit-bare-vectors` was retired in reading-lite-gh347.4.6 and `sweep-wipe-prefix` in reading-lite-gh351.7. |

## Remaining limits

This is a bounded improvement to #198, not a claim that its literal “every
path with two principals” acceptance criterion is complete. Operator coverage composes each command's selector,
provenance, or authenticated-client wiring with populated shared PostgreSQL,
R2, and API boundary cases; thin wrappers do not duplicate an end-to-end
two-tenant corpus fixture when they introduce no additional storage boundary.

The local operator has account-scoped credentials and may explicitly select any
tenant. Its boundary is selector/provenance consistency, not end-user
permission checks. Environment-wide operations use the environment boundary:
staging teardown intentionally deletes data for every staging tenant.
`--tenant global` deliberately addresses retained legacy data.
Context preparation intentionally crosses tenants, and its evidence
asserts the declared source and destination rather than treating that copy as
an isolation failure. Digest and wipe jobs are internally created and have no
end-user actor credential. Public health/login options and authentication
challenge/redemption are not foreign-resource lookup routes.

New surfaces still require review and behavior tests. Merely documenting a
route would not make its isolation tested; this change adds no source-text
inventory checks or new CI machinery.
