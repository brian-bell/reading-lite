# Tenant isolation CI matrix (#198)

The core contract is that tenant B cannot discover or mutate tenant A's
resources. Direct resource attacks must return the same status and body as an
unknown resource. Collection queries must return only the caller's records.
Scope denial precedes ownership lookup (403 for both foreign and unknown
resources). Positive controls prove an authorized owner can still do the work.

All test paths below run in `npm test` through `vitest.workspace.ts` and the
Worker CI job in `.github/workflows/ci.yml`. `npm run test:quiet` runs the same
suite with filtered logs and preserves failures. No live credentials, production
writes, or paid provider calls are needed; integration tests use real local
D1/R2 and namespace-aware Vectorize and provider fakes. This validates the
application boundary, not Cloudflare's implementation of namespace filtering.
SSRF and cost-control coverage inventory is outside this work item.

## Hosted reading routes

| Route | Adversarial behavior and owner control | Canonical evidence |
| --- | --- | --- |
| `POST /api/readings` | Two principals save the same URL and finish with independent ids, URL claims, list rows and vectors. | `test/integration/readings.test.ts`: `two-tenant save-to-ready lifecycle` |
| `POST /api/readings/import-markdown` | Same URL imports in B's slot; A's manifest and lookup remain unchanged. | Same file: `cross-tenant mutation matrix` |
| `GET /api/readings` | List/search exclude A from B; owner search finds A. MCP additionally pages populated A/B corpora. | Same file: `cross-tenant read-path matrix`; MCP matrix below |
| `GET /api/readings/lookup` | Owner URL resolves; foreign URL equals never-submitted URL. Separate lookup tests prohibit repair writes. | Same file: `cross-tenant read-path matrix` and lookup tests |
| `GET /api/readings/:id` | Owner succeeds; foreign equals unknown, including stale pending attempt annotation. | Same file: `cross-tenant read-path matrix` |
| `GET /api/readings/:id/content` and `/content/raw` | Owner succeeds; foreign equals unknown. | Same file: `cross-tenant read-path matrix` |
| `GET /api/readings/:id/diagnostics` | Owner receives diagnostics; foreign equals unknown rather than exposing pointers, objects or attempts. | Same file: `cross-tenant read-path matrix` |
| `POST /api/readings/similar` | Identical vectors in populated A/B namespaces return only each caller's id and metadata; query changes neither vectors nor queue. | Same file: `returns only the caller's neighbours when two tenants store identical vectors` |
| `POST /api/readings/:id/reprocess` | Foreign equals unknown; owner remains ready and can activate its own retry. Queue-send rollback stays in the failing tenant's namespace. | Same file: `cross-tenant mutation matrix` |
| `DELETE /api/readings/:id` | Foreign equals unknown and purges nothing; owner delete removes manifest, content, list, URL claim and vector. | Same file: `DELETE /api/readings/:id (purge)` |
| Connection/novelty output | Second A reading sees first A reading as a neighbour/connection; B sees neither. Model stub derives output from actual supplied context. | Same file: `keeps similarity, novelty, and connections private to the active tenant` |
| Scope and expected-tenant headers | Read/write/import/delete scopes grant only their routes; mismatched layout pin refuses. MCP adds scope-denied foreign/unknown comparisons. | `test/integration/auth-principal.test.ts`: scope and expected-tenant matrices |

## MCP

`test/integration/mcp.test.ts` exercises the HTTP MCP dispatch boundary. The
`MCP adversarial tenant matrix` covers all eight registered tools:

| Tools | Contract |
| --- | --- |
| `get_reading`, `get_reading_content`, `get_diagnostics` | Owner-positive, foreign/unknown equality, byte-for-byte R2 inventory unchanged and no enqueued job. |
| `reprocess_reading` | Same checks with forced Markdown replacement, followed by a successful owner activation. |
| `list_readings`, `search_readings` | Two populated corpora, matching query, page size one, empty second page and no foreign-only search result; no writes. |
| `submit_url`, `import_markdown` | Owner deduplicates; other principal gets its own id for the same URL, becomes ready, and leaves the owner's diagnostics intact. Import's polling returns the importing principal's reading. |
| All three write tools | Read-only tokens for both tenants get identical 403 results for known/foreign and unknown inputs, with no R2 changes or jobs. |

The existing suite also checks authentication, tool registration, origin checks,
`/api/mcp` alias dispatch and stateless unsupported methods. The adversarial
matrix runs through `/mcp`; alias correctness is a separate dispatch test.

## Auth, queues and operators

| Surface | Evidence and boundary | Canonical tests |
| --- | --- | --- |
| Session/token list and revoke | Two authenticated sessions; foreign ids match unknown responses and remain usable until their owner revokes them. Lists omit the foreign resource. Mismatched `x-expected-tenant` returns 412 and revokes nothing. | `test/integration/auth-sessions.test.ts`, `auth-tokens.test.ts` |
| Email-change redemption | A user cannot redeem another user's email-change credential; the owner can still redeem it, while the other user's session and API token remain usable. A request with a mismatched `x-expected-tenant` returns 412 and sends no link. | `test/integration/auth-email-change.test.ts` |
| Revoke-all and logout | Cookie and bearer revoke-all clear every session only for their caller; another tenant's session and token survive. Logout clears one session while another session for that user and another tenant remain usable. | `test/integration/auth-sessions.test.ts` |
| Settings and identity | Each principal sees its own identity/settings; changing A leaves B unchanged. Mismatched `x-expected-tenant` on settings returns 412 and changes nothing. | `test/integration/auth-settings.test.ts` |
| Account deletion | B enters deleting; A stays active with a working session. Mismatched `x-expected-tenant` returns 412 and fences nothing. | `test/integration/auth-account-delete.test.ts` |
| Reading queue admission | An envelope claiming A with B's credential is acknowledged before processing or mutation. | `test/integration/dead-letter.test.ts`, `test/unit/control-plane/envelope.test.ts` |
| Reading DLQ | Identical id/key in A and B: only the admitted tenant's manifest/list becomes failed. | `test/integration/dead-letter.test.ts` |
| Retry and concurrent publication | Admission precedes retry dispatch; concurrent A/B terminal commits preserve separate lists and vectors. | `test/unit/queue/dispatch.test.ts`, `test/integration/readings.test.ts` |
| Digest send and DLQ | Separate tenant recipients/content; digest DLQ changes its ledger, not reading state. | `test/integration/digest-pipeline.test.ts` |
| Wipe and teardown replay | Target prefix is removed while foreign prefix survives; old jobs cannot recreate torn-down data. A deterministic interleave runs populated A/B wipes with the same reading ids through independent D1 progress/ledger rows, R2 roots, delayed vector confirmation, retries, and completion. | `test/integration/account-wipe.test.ts`, `account-deletion-queue-limits.test.ts` |
| Destructive corpus maintenance | With identical ids in populated A/B roots, sweep and orphan deletion alter only the selected root and its composed vector. Rebuild, tag/relationship repair, and connection maintenance use the same selector-aware R2 contract. | `test/unit/scripts/ops-corpus-group.test.ts`, `ops-corpus-refresh-neighbours.test.ts`, `ops-corpus-refresh-connections.test.ts`, `ops-corpus-refresh-tensions.test.ts`, `ops-corpus-purge-connections.test.ts` |
| Operator audit/recovery | Audit reads only selected root and stamps provenance. Foreign audit refuses before API, annotation, sidecar or batch work. Bearer identity must match selected layout. | `test/unit/scripts/ops-corpus-audit.test.ts`, `ops-corpus-recover.test.ts`, `realtime-tenant.test.ts` |
| Batch ingest/recover and vector repair | Batch configuration carries the selected tenant into its R2 root, namespace, ledger, composed vector writes, and resumable sidecars. Foreign audit/sidecar provenance refuses before provider work. | `test/unit/scripts/ops-corpus-group.test.ts`, `ops-corpus-recover.test.ts`, `test/unit/corpus/batch/sidecar.test.ts`, `test/unit/corpus/tenant.test.ts` |
| System policy and status | A tenant policy update leaves a second populated tenant unchanged. Status forwards the selected tenant to the private entrypoint, whose tenant details do not include a second tenant's guard reservations. | `test/unit/scripts/system-policy.test.ts`, `system-status.test.ts`, `system-status-remote.test.ts`, `test/integration/operator-status.test.ts` |
| Staging context preparation | The command keeps explicit, distinct production source and staging destination tenants through its reader seam. The artifact rejects source/vector mismatch and occupied destination state before any remote write. | `test/unit/scripts/context-copy.test.ts` |

### Operator command applicability

The registry has one of the following tenant boundaries for every supported
command. This is an inventory of the command surface, not a replacement for
the behavioral tests named above.

| Commands | Boundary and evidence |
| --- | --- |
| `system policy`, `system status` | Explicit tenant selector. The selected D1 row and private `OperatorStatus` request are covered by the populated two-tenant cases above. |
| Paid execution of `corpus backfill-vectors`, `refresh-connections`, `refresh-tensions`, `ingest`, `recover --batch`; `eval summarizer`; the compare-summary-effort script | A payer selector separate from the storage selector: `--billing-tenant` (defaulting to a real `--tenant`, required for `--tenant global`, pinned by a batch sidecar) names the one tenant whose cap, with the global cap, admits each request through the private `OperatorSpend` entrypoint. The entrypoint forwards only the four spend verbs for a valid tenant id (`test/integration/operator-spend.test.ts`); payer resolution and forwarding are covered by `test/unit/scripts/ops-corpus-refresh-connections.test.ts` (synchronous payer rules), `ops-corpus-group.test.ts` (batch payer rules), `ops-corpus-recover.test.ts`, `ops-extract-eval.test.ts`, and `test/unit/corpus/compare-summary-effort.test.ts`. This proves who is charged, not a two-tenant ledger case. |
| `corpus audit`, `recover`, `ingest`, `sweep`, `delete-orphans`, `backfill-similarity`, `backfill-vectors`, `backfill-source-date`, `refresh-neighbours`, `refresh-connections`, `refresh-tensions`, `normalize-tags`, `rebuild-list`, `purge-connections`, `seed-vector-ledger` | Explicit corpus selector. R2 roots, report/sidecar provenance, Vectorize namespace/composed IDs, and D1 ledger ownership are covered by the command suites above; destructive overlapping-ID cases cover sweep/orphan deletion, seed-ledger, and connection purge. `corpus drop` is covered by its dedicated regression PR. |
| `reading submit`; `import markdown`, `bookmarks`, `reddit`, `youtube`; `reading-list process` | Thin API clients with no operator tenant selector or direct corpus store. The bearer principal selects the hosted tenant, so their tenant boundary is the authenticated API/MCP matrix and the shared `readingApiFor` contract; `corpus recover` additionally verifies its explicit selector against `/api/whoami` before it invokes the same API. |
| `reading-list check` | Requires `--tenant` and queries that tenant's readings; `--tenant global` is refused. Covered by `test/unit/scripts/ops-imports-reading-list.test.ts`, including that a missing selector fails before any connection. |
| `deploy worker`, `deploy wipe-check`, `deploy web`; `staging setup`; `founder bootstrap`; `extract probe`; `eval summarizer` | Environment configuration, deployment, bootstrap, local extraction, or fixture evaluation. These commands have no caller-selected live corpus tenant. |
| `staging teardown` | Intentional environment-wide deletion: empties the entire staging R2 bucket, including every tenant's `u/{tenant}/…` objects, and deletes the staging Worker, queues, Vectorize index, D1 database, and bucket. The boundary is the isolated staging environment; resource-name guards, plan-first execution, and credential preflight are covered by `test/unit/deploy/staging-env.test.ts` and `test/unit/scripts/ops-deploy-staging.test.ts`. |
| `staging smoke` | Authenticated API workflow that submits, imports, and reprocesses readings in the bearer principal's tenant. It performs staging writes with `--execute`; target validation and workflow behavior are covered by `test/unit/scripts/ops-deploy-staging.test.ts`. |
| `extract agent` | Authenticated hosted polling/import client. It has no independent storage selector, so submitted work is scoped by its bearer principal; its poll bearer header is covered in `test/unit/extract-agent/poll.test.ts` and its imports use the hosted API boundary. |
| `staging prepare-context` | Intentional, explicitly named cross-tenant copy. It treats the source and destination as separate scopes and produces a local artifact only. |
| `account wipe`, `residue-scan`, `audit-bare-vectors` | Explicit account/namespace selector, with tenant status and audit/ledger queries keyed by that selector. A populated A/B fixture proves enqueue admission, residue scans, and bare-vector repair leave the other account's vector, R2, and D1 state intact (`test/unit/scripts/ops-account-s5.test.ts`). `sweep-wipe-prefix` is global maintenance of the bucket-root `wipe/` prefix; it derives tenants from those keys and has no caller-selected corpus owner. |

## Remaining limits

This is a bounded improvement to #198, not a claim that its literal “every
path with two principals” acceptance criterion is complete. Operator coverage composes each command's selector,
provenance, or authenticated-client wiring with populated shared R2, Vectorize,
ledger, and API boundary cases; thin wrappers do not duplicate an end-to-end
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
