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
| Session/token list and revoke | Two authenticated sessions; foreign ids match unknown responses and remain usable until their owner revokes them. Lists omit the foreign resource. | `test/integration/auth-sessions.test.ts`, `auth-tokens.test.ts` |
| Settings and identity | Each principal sees its own identity/settings; changing A leaves B unchanged. | `test/integration/auth-settings.test.ts` |
| Account deletion | B enters deleting; A stays active with a working session. | `test/integration/auth-account-delete.test.ts` |
| Reading queue admission | An envelope claiming A with B's credential is acknowledged before processing or mutation. | `test/integration/dead-letter.test.ts`, `test/unit/control-plane/envelope.test.ts` |
| Reading DLQ | Identical id/key in A and B: only the admitted tenant's manifest/list becomes failed. | `test/integration/dead-letter.test.ts` |
| Retry and concurrent publication | Admission precedes retry dispatch; concurrent A/B terminal commits preserve separate lists and vectors. | `test/unit/queue/dispatch.test.ts`, `test/integration/readings.test.ts` |
| Digest send and DLQ | Separate tenant recipients/content; digest DLQ changes its ledger, not reading state. | `test/integration/digest-pipeline.test.ts` |
| Wipe and teardown replay | Target prefix is removed while foreign prefix survives; old jobs cannot recreate torn-down data. | `test/integration/account-wipe.test.ts`, `account-deletion-queue-limits.test.ts` |
| Operator audit/recovery | Audit reads only selected root and stamps provenance. Foreign audit refuses before API, annotation, sidecar or batch work. Bearer identity must match selected layout. | `test/unit/scripts/ops-corpus-audit.test.ts`, `ops-corpus-recover.test.ts`, `realtime-tenant.test.ts` |
| Batch resume | Foreign tenant sidecar refuses before provider/batch work; matching sidecar resumes. | `test/unit/scripts/ops-corpus-recover.test.ts`, `test/unit/corpus/batch/sidecar.test.ts` |
| Operator stores and vector writes | Selector determines R2 root, namespace and composed vector id; report mismatches refuse. | `test/unit/corpus/tenant.test.ts`, `test/unit/scripts/ops-neighbours-r2.test.ts`, `ops-corpus-group.test.ts`, `ops-corpus-refresh-neighbours.test.ts`, `refresh-scope.test.ts` |

## Remaining limits

This is a bounded improvement to #198, not a claim that its literal “every
path with two principals” acceptance criterion is complete. Email-change
credential swapping and revoke-all/logout across two principals are not added
here. Existing wipe coverage preserves a foreign prefix but does not run two
simultaneous tenant wipes. Operator root/namespace tests are distributed across
command suites; not every operator command has a populated two-tenant execution
test.

The local operator has account-scoped credentials and may explicitly select any
tenant. Its boundary is selector/provenance consistency, not end-user
permission checks. Digest and wipe jobs are internally created and have no
end-user actor credential. Public health/login options and authentication
challenge/redemption are not foreign-resource lookup routes.

New surfaces still require review and behavior tests. Merely documenting a
route would not make its isolation tested; this change adds no source-text
inventory checks or new CI machinery.
