# Manual Test Checklist — Idempotent URL Submits

Branch: `codex/issue-33-idempotent-url-submits`

The by-url pointer is now an **eager ownership claim** written at submit time
(not only on success). Every submit / import / lookup routes through one
`ReadingClaim.resolveOwner` protocol. The single invariant to protect:

> **One URL → exactly one reading id, forever**, no matter how many times it is
> submitted in any state (`ready` / `pending` / `failed` / `initializing`).

## Environments

| Surface | Use for | Limitation |
|---|---|---|
| `npm test` | Authoritative check (incl. races/damaged pointers) | — |
| Local `wrangler dev` (`http://127.0.0.1:8787`) | Auth, validation, no-queue `503` paths | No queue/Vectorize → submits can't complete |
| Cloudflare staging | Real end-to-end matrix without touching prod corpus | **Needed before A/B/C/D/H deployed-style smoke** |

Companion script: `scripts/manual/idempotency-smoke.sh` (concrete curls for A–D).

---

## Group 0 — Automated gate (do first)

- [x] `npm test` — full vitest suite passes
- [x] `npm run typecheck` — clean
- [x] Confirm new suites ran: `test/unit/modules/reading-claim.test.ts`,
      `test/unit/process-reading/attempt-ownership.test.ts`,
      `test/unit/process-reading/commit-terminal.test.ts`, expanded
      `test/integration/readings.test.ts`

Local-only rerun (2026-06-20): `npm test` passed, including the four
idempotency-focused suites above. `npm run typecheck` passed. No deployed
endpoints or remote corpus tooling were used.

---

## Group S — Cloudflare staging prerequisite

The deployed-style matrix needs Cloudflare staging infrastructure so smoke tests
can exercise real Queue, R2, and Vectorize behavior without mutating the
personal production corpus.

- [x] **S1** Provision an isolated staging Worker route/base URL.
- [x] **S2** Provision isolated staging R2 bucket, Vectorize index, Queue, and DLQ bindings.
- [x] **S3** Configure staging secrets/env separately from prod (`READER_API_TOKEN`,
      Anthropic/OpenAI keys, email settings if enabled).
- [x] **S4** Add documented staging run commands for `scripts/manual/idempotency-smoke.sh`
      (`BASE=<staging-url>` plus staging token).
- [x] **S5** Add or document staging-safe corpus audit/drop commands that target
      only the staging bucket/index.
- [x] **S6** Confirm staging cleanup can remove every throwaway URL created by
      A/B/C/D/H before running the full matrix.

Run note (2026-06-20): Cloudflare staging resources were created and the
Worker was deployed at `https://reading-lite-staging.bellbm.workers.dev`.
Resources: R2 bucket `reading-lite-staging`, Vectorize index
`reading-lite-staging`, Queue `reading-lite-staging`, DLQ
`reading-lite-staging-dlq`. Staging secrets were set with `wrangler secret put
--env staging`. A read-only lookup smoke against staging returned `404
{error:"not found"}` for an unknown URL.

Run note (2026-06-21): staging setup/teardown wrappers were added:
`npm run staging:setup` / `npm run staging:teardown` dry-run by default, with
`-- --execute` to mutate Cloudflare resources. Make targets
`make staging-setup EXECUTE=1` and `make staging-teardown EXECUTE=1` wrap the
same scripts. The teardown command builder is hard-coded to staging names and
refuses production-looking resource names.

Run note (2026-06-21 teardown): `npm run staging:teardown -- --execute`
completed against Cloudflare staging. It treated already-missing Queue
consumers, Worker, Queue/DLQ, and Vectorize index as satisfied, emptied five
remaining objects from `reading-lite-staging`, and deleted the R2 bucket. A
second execute run also completed with every staging resource already absent,
including the R2 bucket.

Run note (2026-06-20 staging smoke): staging cleanup removed all throwaway
ready/failed readings created by the smoke run, including ready Vectorize
vectors and `index/by-url/{hash}` pointers. Final staging audit and list both
reported zero readings.

---

## Group A — Submit idempotency matrix (Cloudflare staging)

Use a fresh throwaway `$U` per row.

- [x] **A1** new URL → `POST /readings {url}` returns `202 {id,status:"pending",poll}`; poll → `ready`
- [x] **A2** re-submit the now-`ready` URL → **`200`** with existing manifest, **same id**, no duplicate list row
- [x] **A3** re-submit while `pending` (two quick POSTs) → both resolve to the **same id**, never a second reading
- [x] **A4** re-submit a `failed` URL → **`202` reprocessing the same id** (new `attempt_id`); `GET /readings/:id` flips back to `pending`
- [x] **A5** `email:true` / `email:false` both accepted; default `true` for submit
- [x] **Across A2–A4**: `GET /readings/lookup?url=$U` returns the same id throughout; `npm run corpus-audit` shows no orphan-duplicate

Run note (2026-06-20 staging smoke): A1/A2/A5 passed for
`rd_FS1FQZA06G`. A3 visible-pending re-submit returned `200` with the same id
`rd_SSW82MJRJ0`; a true concurrent variant hit the initializing guard with
`409` but still returned the same owner id `rd_ZPGHRGPKDM`. A4 failed URL
`rd_435XVHP05S` re-submitted with `202`, same id, and a new attempt.

---

## Group B — Markdown-import idempotency (Cloudflare staging)

`POST /readings/import-markdown {source_url, markdown, title?}`

- [x] **B1** new `source_url` → `202`, processes markdown → `ready`
- [x] **B2** re-import a `ready` `source_url` → **`200`** existing manifest, no duplicate
- [x] **B3** re-import a `failed` `source_url` → **`202`** same id; new markdown/title **replaces** raw + extracted; `active_attempt`/`error` cleared
- [x] **B4** re-import over a visible `pending` non-failed owner → **`200`** existing pending manifest, same id, no duplicate
- [x] **B5** default `email` for import is **false** (no email unless `email:true`)

Run note (2026-06-20 staging smoke): B1/B2 passed for markdown import id
`rd_RY5XATQWYN`.

Run note (2026-06-21 staging): B3 passed for URL
`https://example.com/reading-lite-staging-b3-fail-20260621T001259Z`, id
`rd_49KY4EX13H`. The initial URL submit reached `failed`; markdown re-import
returned `202` with the same id, reached `ready`, changed `source_type` to
`markdown`, replaced both extracted and raw markdown content, set title
`B3 Replacement 20260621T001259Z`, and cleared `error` / `active_attempt`.
B5 passed from the same import attempt: diagnostics showed zero `send_email`
events for the default import body and latest trigger `import`.

B4 passed after product decision: visible-pending re-import for
`https://example.com/reading-lite-staging-b4-20260621T001259Z`, id
`rd_7CNWDH302Q`, returned `200` with the same id and status `pending`. That
matches the current router behavior and the integration test
`deduplicates Markdown imports for the same source URL while pending`.

---

## Group C — Lookup is read-only (Cloudflare staging + integration)

- [x] **C1** `ready` URL → `200 {id}`
- [x] **C2** `pending` URL → `200 {id}`
- [x] **C3** `failed` URL → `200 {id}`
- [x] **C4** owner inside missing-manifest grace window → `409 "reading owner is still initializing"` `{id,poll}`
- [x] **C5** unknown URL → `404 {error:"not found"}`
- [x] **C6 (integration):** damaged pointer → lookup returns `404` and does **no** deep scan / **no** R2 write

Run note (2026-06-20 staging smoke): C1/C2/C3/C5 passed on staging. A targeted
C4 lookup race returned `404` before the pointer was visible, so the
deterministic fixture below was used to prove the grace-window behavior.

Run note (2026-06-21 staging): C4 passed deterministically by writing a fresh
staging-only `index/by-url/{hash}` pointer with no manifest, then calling
`GET /readings/lookup`. The lookup returned `409` with
`error:"reading owner is still initializing"`, id
`rd_C420260621001259`, and poll `/readings/rd_C420260621001259`. The fixture
pointer was deleted immediately afterward.

---

## Group D — Reprocess regression (Cloudflare staging)

`POST /readings/:id/reprocess`

- [x] **D1** reprocess `failed` → `202`, `pending` → `ready`
- [x] **D2** reprocess `ready` whose attempt then fails → prior ready manifest **preserved** with `last_attempt.status="failed"`
- [x] **D3** reprocess while `running`, no force → `409 "reading already has an active attempt"`
- [x] **D4** same with `{force:true}` → `202`
- [x] **D5** reprocess a `markdown` reading with no stored extracted → `409 "markdown content not available"`

Run note (2026-06-20 staging smoke): D3/D4 passed against ready reading
`rd_FS1FQZA06G`; the forced reprocess finished and cleared `active_attempt`.

Run note (2026-06-21 staging): D1 passed by seeding a staging-only retryable
failed manifest for `https://example.com/?reading-lite-staging-d1=20260621T001259Z`,
id `rd_D120260621001259`, then calling `POST /readings/:id/reprocess`.
The endpoint returned `202`, the queue processed the real URL, and the reading
reached `ready` with `last_attempt.trigger:"reprocess"` and
`last_attempt.status:"succeeded"`.

D2 passed in a focused rerun with seeded ready id `rd_D2R20260621001741` and
failing URL `https://example.com/reading-lite-staging-d2-fail-20260621T001741Z`.
`POST /readings/:id/reprocess` returned `202`; while running, the manifest
remained `ready` with the prior title. After the active attempt cleared, the
manifest was still `ready`, title `D2 Preserved Title` was preserved, and
`last_attempt` was `trigger:"reprocess"`, `status:"failed"`,
`error.stage:"fetch_source"`.

D5 passed for markdown id `rd_RGXT9G8FRM`: after deleting its staging
`extracted.md`, `POST /readings/:id/reprocess` returned `409` with
`error:"markdown content not available"`.

---

## Group E — Terminal-write ownership gating (integration-primary)

- [x] **E1** superseded attempt finishing late does **not** overwrite newer manifest/list/vector (`hasConflict` early-return)
- [x] **E2** success path emails/publishes only when `published === true`
- [x] **E3** lost-CAS terminal write re-syncs list only if we still own the by-url pointer (no row resurrection)
- [x] **E4** non-owner duplicate failure clears **list row only**, never the URL pointer or winner's vector
- [x] **E5** DLQ `markDeadLettered` on a taken-over reading does **not** clobber (strict `isActive` gate)

---

## Group F — Setup / queue-send failure (local + integration)

- [x] **F1 (local):** no `READING_JOBS` → `POST /readings`, `/import-markdown`, `/reprocess` all `503 "queue binding READING_JOBS is not configured"`
- [x] **F2 (integration):** queue `send` throws → `503 {error:"queue send failed",id}`; reading left as retryable `failed` (`QueueSendError`, `retryable:true`)
- [x] **F3 (integration):** `ready` reading whose reprocess queue-send fails → rolls back to `ready` + `last_attempt.status="failed"`

Local-only rerun (2026-06-20): local `wrangler dev` with no queue binding
returned the expected `503` for `POST /readings` and
`POST /readings/import-markdown` via `scripts/manual/idempotency-smoke.sh f1`;
local auth/validation also checked (`/health` 200, missing/wrong bearer 401,
invalid URL 400). The reprocess no-queue branch is covered by the integration
suite.

---

## Group G — Contention / damaged / cold-legacy (integration-only)

- [x] **G1** concurrent submits converge on one owner; no duplicate ids
- [x] **G2** claim contention exhausts 4 attempts → `503 "could not claim url ownership under contention"`
- [x] **G3** resolve contention exhausts 8 attempts → `503 "could not resolve url ownership under contention"`
- [x] **G4** damaged pointer on a write path repaired (deep scan memoized, scanned ≤1×) or overwritten via `replaceEtag`
- [x] **G5** cold legacy adopted on submit; no duplicate

---

## Group H — Cross-cutting regression

- [x] **H1 (Cloudflare staging):** `GET /readings` list + `q`/`tag`/`offset`/`limit` work; no duplicate rows after A/B cycles
- [ ] **H2:** SPA smoke (`cd web && npm run dev`) — submit/list/detail render; re-submit surfaces existing reading
- [x] **H3 (cleanup):** `npm run corpus-audit -- --bucket reading-lite-staging` then
      `npm run corpus-drop -- $U --bucket reading-lite-staging --allow-ready --vectorize reading-lite-staging --execute`
      for every throwaway `$U`

Run note (2026-06-20 staging smoke): H1 list/q/tag/offset/limit passed; each
throwaway URL had exactly one list row before cleanup. H3 cleanup removed five
main smoke readings plus the C4 race throwaway; final staging audit totals were
all zero and `GET /readings?limit=20` returned an empty list.

Local-only rerun (2026-06-20): `cd web && npm test` passed and `cd web &&
npm run build` passed. Actual browser smoke remains manual because
local Worker submits cannot complete without `READING_JOBS`.

Run note (2026-06-21): web non-browser checks still pass: `cd web &&
npm test` passed and `cd web && npm run build` passed. A staging SPA
browser smoke was attempted with Vite running locally and `/readings` proxied to
the staging Worker, but Chrome control from Codex was unavailable. Chrome,
the Codex Chrome Extension, and the native host manifest all checked out, but
the bridge repeatedly reported `Browser is not available: extension`, even
after opening Chrome through the plugin helper. H2 remains unchecked.

---

## Order

1. Group 0 gate
2. Local: F1, auth, validation
3. Staging prerequisite: S1-S6
4. Cloudflare staging: A → B → C → D → H1/H2 (interleave lookup + staging corpus-audit)
5. Read-through integration coverage for E, F2/F3, G
6. H3 cleanup in staging

## Manual items remaining

Remaining after the 2026-06-21 staging verification and B4 product decision:

- **H2** SPA browser smoke against the staging Worker once Chrome control is
  available to Codex, or via another approved browser path.
