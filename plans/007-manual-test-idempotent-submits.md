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

Companion script: `scripts/manual/idempotency-smoke.sh` (concrete curls for A–D).

---

## Group 0 — Automated gate (do first)

- [x] `npm test` — full vitest suite passes
- [x] `npm run typecheck` — clean
- [x] Confirm new suites ran: `test/unit/modules/reading-claim.test.ts`,
      `test/unit/process-reading/attempt-ownership.test.ts`,
      `test/unit/process-reading/commit-terminal.test.ts`, expanded
      `test/integration/readings.test.ts`

Local-only rerun (2026-06-20): `npm test` passed 551 tests across 53 files,
including the four idempotency-focused suites above. `npm run typecheck`
passed. No deployed endpoints or remote corpus tooling were used.

---

## Group A — Submit idempotency matrix (deployed)

Use a fresh throwaway `$U` per row.

- [ ] **A1** new URL → `POST /readings {url}` returns `202 {id,status:"pending",poll}`; poll → `ready`
- [ ] **A2** re-submit the now-`ready` URL → **`200`** with existing manifest, **same id**, no duplicate list row
- [ ] **A3** re-submit while `pending` (two quick POSTs) → both resolve to the **same id**, never a second reading
- [ ] **A4** re-submit a `failed` URL → **`202` reprocessing the same id** (new `attempt_id`); `GET /readings/:id` flips back to `pending`
- [ ] **A5** `email:true` / `email:false` both accepted; default `true` for submit
- [ ] **Across A2–A4**: `GET /readings/lookup?url=$U` returns the same id throughout; `npm run corpus-audit` shows no orphan-duplicate

---

## Group B — Markdown-import idempotency (deployed)

`POST /readings/import-markdown {source_url, markdown, title?}`

- [ ] **B1** new `source_url` → `202`, processes markdown → `ready`
- [ ] **B2** re-import a `ready` `source_url` → **`200`** existing manifest, no duplicate
- [ ] **B3** re-import a `failed` `source_url` → **`202`** same id; new markdown/title **replaces** raw + extracted; `active_attempt`/`error` cleared
- [ ] **B4** import over a `pending` non-failed owner → `409 "reading already has an active attempt"`
- [ ] **B5** default `email` for import is **false** (no email unless `email:true`)

---

## Group C — Lookup is read-only (deployed + integration)

- [ ] **C1** `ready` URL → `200 {id}`
- [ ] **C2** `pending` URL → `200 {id}`
- [ ] **C3** `failed` URL → `200 {id}`
- [ ] **C4** owner inside missing-manifest grace window → `409 "reading owner is still initializing"` `{id,poll}`
- [ ] **C5** unknown URL → `404 {error:"not found"}`
- [x] **C6 (integration):** damaged pointer → lookup returns `404` and does **no** deep scan / **no** R2 write

---

## Group D — Reprocess regression (deployed)

`POST /readings/:id/reprocess`

- [ ] **D1** reprocess `failed` → `202`, `pending` → `ready`
- [ ] **D2** reprocess `ready` whose attempt then fails → prior ready manifest **preserved** with `last_attempt.status="failed"`
- [ ] **D3** reprocess while `running`, no force → `409 "reading already has an active attempt"`
- [ ] **D4** same with `{force:true}` → `202`
- [ ] **D5** reprocess a `markdown` reading with no stored extracted → `409 "markdown content not available"`

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

- [ ] **H1 (deployed):** `GET /readings` list + `q`/`tag`/`offset`/`limit` work; no duplicate rows after A/B cycles
- [ ] **H2:** SPA smoke (`cd web && npm run dev`) — submit/list/detail render; re-submit surfaces existing reading
- [ ] **H3 (cleanup):** `npm run corpus-audit` then `npm run corpus-drop` every throwaway `$U`

Local-only rerun (2026-06-20): `cd web && npm test` passed 22 tests and
`cd web && npm run build` passed. Actual browser smoke remains manual because
local Worker submits cannot complete without `READING_JOBS`.

---

## Order

1. Group 0 gate
2. Local: F1, auth, validation
3. Deployed: A → B → C → D → H1/H2 (interleave lookup + corpus-audit)
4. Read-through integration coverage for E, F2/F3, G
5. H3 cleanup

## Manual items remaining

These were intentionally not run on 2026-06-20 during the local-only rerun
because local `wrangler dev` has no queue/Vectorize binding and cannot complete
submit/import/reprocess flows to `ready`.

- Deployed Group A: A1-A5 and the A2-A4 lookup/audit checks.
- Deployed Group B: B1-B5.
- Deployed Group C spot-checks: C1-C5, even though C6 and the lookup states are covered by integration tests.
- Deployed Group D: D1-D5.
- Deployed Group H: H1, H2 browser smoke against a real completing backend, and H3 cleanup after any deployed throwaway URLs.
