# Testing Handoff — Idempotent URL Submits Staging

Branch: `codex/issue-33-idempotent-url-submits`

## Current State

Local branch contains the idempotent-submit verification work plus staging
infrastructure/documentation updates. Use `git log --oneline` for the exact
current commit stack before pushing.

Untracked and intentionally untouched:

- `.claude/autobuild-reports/handle-reddit-urls`

Primary checklist:

- `plans/007-manual-test-idempotent-submits.md`

## Staging Infrastructure

Staging Worker:

- `https://reading-lite-staging.bellbm.workers.dev`

Cloudflare staging resources:

- R2 bucket: `reading-lite-staging`
- Vectorize index: `reading-lite-staging`
- Queue: `reading-lite-staging`
- DLQ: `reading-lite-staging-dlq`

Staging secrets were set with:

```sh
wrangler secret put READER_API_TOKEN --env staging
wrangler secret put ANTHROPIC_API_KEY --env staging
wrangler secret put OPENAI_API_KEY --env staging
wrangler secret put RESEND_API_KEY --env staging
```

Repo support added:

- `[env.staging]` in `wrangler.toml`
- staging deploy support in `scripts/deploy.ts`, `scripts/deploy-web.ts`, and `Makefile`
- staging setup/teardown support in `scripts/staging-setup.ts`,
  `scripts/staging-teardown.ts`, `scripts/staging-env.ts`, `package.json`, and
  `Makefile`
- `.stg.vars.example`
- `scripts/manual/idempotency-smoke.sh` supports `VARS_FILE=.stg.vars`
- staging cleanup support in `corpus-drop --allow-ready --vectorize reading-lite-staging`

## Completed Verification

Local verification:

- `npm test`: 558 passed
- `npm run typecheck`: passed
- `npm run deploy -- --env staging`: dry-run passed
- `npm run deploy -- --env staging --execute`: deployed
- `npm run deploy:web -- --branch staging --skip-build`: dry-run passed
- `npm run corpus-drop -- --help`: passed
- `npm run staging:setup`: dry-run passed
- `npm run staging:teardown`: dry-run passed
- `npx vitest run test/unit/deploy/staging-env.test.ts`: passed
- `cd web && npm test`: 22 passed
- `cd web && npm run build`: passed
- `make help`: shows staging commands

Staging read-only lookup for an unknown URL returned:

- `404 { "error": "not found" }`

## Staging Smoke Results

### Group A

A1/A2/A5 passed:

- URL: `https://example.com/?reading-lite-staging-a=20260620T180006Z`
- ID: `rd_FS1FQZA06G`
- New submit returned `202 pending`
- Poll reached `ready`
- Re-submit ready returned `200` with the same id
- `email:true` and `email:false` were accepted
- Lookup returned the same id

A3 visible-pending path passed:

- URL: `https://example.com/?reading-lite-staging-a3b=20260620T180006Z`
- ID: `rd_SSW82MJRJ0`
- First POST returned `202 pending`
- Second POST while manifest was visible `pending` returned `200`, same id, status `pending`

A3 true concurrent variant:

- URL: `https://example.com/?reading-lite-staging-a3=20260620T180006Z`
- ID: `rd_ZPGHRGPKDM`
- First POST returned `202`
- Second concurrent POST hit initializing guard `409` with the same id/poll

A4 passed:

- URL: `https://example.com/reading-lite-staging-fail-20260620T180006Z`
- ID: `rd_435XVHP05S`
- Initial submit reached `failed`
- Lookup returned `200 { id }`
- Re-submit returned `202 pending`, same id, new attempt

### Group B

B1/B2 passed:

- `source_url`: `https://example.com/reading-lite-staging-b-20260620T180006Z`
- ID: `rd_RY5XATQWYN`
- New import returned `202`
- Poll reached `ready`
- Re-import ready returned `200`, same id

B3/B5 passed:

- URL: `https://example.com/reading-lite-staging-b3-fail-20260621T001259Z`
- ID: `rd_49KY4EX13H`
- Initial URL submit reached `failed` with `BadStatusError`
- Markdown import returned `202 pending` with the same id
- Poll reached `ready`
- Manifest changed to `source_type:"markdown"`, title
  `B3 Replacement 20260621T001259Z`, no `error`, no `active_attempt`
- `/content` and `/content/raw` matched the replacement markdown
- Diagnostics showed zero `send_email` events for default import email behavior

B4 exposed a checklist/implementation mismatch:

- URL: `https://example.com/reading-lite-staging-b4-20260621T001259Z`
- ID: `rd_7CNWDH302Q`
- First import returned `202`
- `GET /readings/:id` showed visible `pending` with `active_attempt`
- Second import returned `200`, same id, status `pending`, no error
- This matches current router behavior and the integration test
  `deduplicates Markdown imports for the same source URL while pending`
- PR #38 has a top-level comment noting that B4 should either expect `200` or
  the implementation/tests should change to enforce `409`

### Group C

C1/C2/C3/C5 passed on staging.

C4 initial public race attempt did not prove the grace-window path:

- URL: `https://example.com/?reading-lite-staging-c4=20260620T180006Z`
- ID: `rd_DSZ4X2PEEN`
- POST returned `202`
- Immediate lookup returned `404` before the pointer was visible, so the intended `409` grace-window result was not proven
- Throwaway was cleaned up

C4 deterministic fixture passed:

- URL: `https://example.com/reading-lite-staging-c4-fixture-20260621T001259Z`
- ID: `rd_C420260621001259`
- Wrote a fresh staging-only `index/by-url/{hash}` pointer with no manifest
- Lookup returned `409 "reading owner is still initializing"` with the same
  id and poll `/readings/rd_C420260621001259`
- Fixture pointer was deleted immediately

### Group D

D3/D4 passed:

- Tested against ready id `rd_FS1FQZA06G`
- Reprocess start returned `202`
- Second reprocess while running returned `409 "reading already has an active attempt"`
- Force reprocess returned `202`
- Forced attempt finished and cleared `active_attempt`

D1 passed:

- Seeded staging-only retryable failed manifest for
  `https://example.com/?reading-lite-staging-d1=20260621T001259Z`
- ID: `rd_D120260621001259`
- `POST /readings/:id/reprocess` returned `202`
- Real queue processing reached `ready`
- `last_attempt.trigger:"reprocess"` and `last_attempt.status:"succeeded"`

D2 passed:

- Seeded ready manifest for failing URL
  `https://example.com/reading-lite-staging-d2-fail-20260621T001741Z`
- ID: `rd_D2R20260621001741`
- `POST /readings/:id/reprocess` returned `202`
- While active, the manifest remained `ready`
- After the attempt finished, manifest still had status `ready`, title
  `D2 Preserved Title`, no `active_attempt`, and
  `last_attempt.trigger:"reprocess"`, `last_attempt.status:"failed"`,
  `last_attempt.error.stage:"fetch_source"`

D5 passed:

- Markdown ID: `rd_RGXT9G8FRM`
- Deleted its staging `extracted.md`
- `POST /readings/:id/reprocess` returned `409 "markdown content not available"`

### Group H

H1 passed:

- `GET /readings?limit=20`: count 5 before cleanup
- `q=Example`: count 5
- `tag=web`: count 2
- `offset=1&limit=2`: count 2, offset 1, limit 2
- Each throwaway URL had exactly one list row

H3/S6 cleanup passed:

- Before cleanup audit: 4 ready, 1 failed
- Cleanup removed ready vectors, R2 objects, `index/by-id`, `index/by-url/{hash}`, and list entries
- C4 race throwaway was also cleaned separately
- Final staging audit: ready 0, pending 0, failed 0
- Final `GET /readings?limit=20`: empty list

H2 remains blocked:

- Vite dev server and local proxy to the staging Worker were started
- Chrome, the Codex Chrome Extension, and the native host manifest all checked
  out locally
- Codex browser control still reported `Browser is not available: extension`,
  including after opening Chrome through the plugin helper and retrying
- Web non-browser checks passed (`cd web && npm test`, `cd web && npm run build`)

Additional cleanup passed after the 2026-06-21 focused runs:

- Audit `/tmp/reading-lite-staging-audit-20260621T001259Z`: ready 0, pending 0, failed 0
- Audit `/tmp/reading-lite-staging-audit-d2-20260621T001741Z`: ready 0, pending 0, failed 0

## Staging Commands

Set common shell vars:

```sh
BASE=https://reading-lite-staging.bellbm.workers.dev
TOKEN=$(grep -E '^READER_API_TOKEN=' .dev.vars | head -1 | cut -d= -f2- | tr -d '"')
```

Run helper groups:

```sh
BASE=$BASE VARS_FILE=.dev.vars ./scripts/manual/idempotency-smoke.sh a "https://example.com/?reading-lite-staging-a-$(date -u +%Y%m%dT%H%M%SZ)"
BASE=$BASE VARS_FILE=.dev.vars ./scripts/manual/idempotency-smoke.sh b "https://example.com/reading-lite-staging-b-$(date -u +%Y%m%dT%H%M%SZ)"
BASE=$BASE VARS_FILE=.dev.vars ./scripts/manual/idempotency-smoke.sh c "https://example.com/known-url"
```

Set up or tear down the isolated staging resources:

```sh
npm run staging:setup
npm run staging:setup -- --execute
npm run staging:teardown
npm run staging:teardown -- --execute
```

Audit staging:

```sh
npm run corpus-audit -- --bucket reading-lite-staging --out /tmp/reading-lite-staging-audit
```

Clean staging throwaways:

```sh
npm run corpus-drop -- "$URL" \
  --bucket reading-lite-staging \
  --allow-ready \
  --vectorize reading-lite-staging \
  --execute
```

Verify staging is clean:

```sh
curl -sS "$BASE/readings?limit=20" -H "Authorization: Bearer $TOKEN" | jq .
npm run corpus-audit -- --bucket reading-lite-staging --out /tmp/reading-lite-staging-audit-final
```

## Manual Items Remaining

These remain open in `plans/007-manual-test-idempotent-submits.md`:

- **B4** resolve the checklist/implementation mismatch: staging returned `200`
  same-owner `pending` for visible-pending markdown re-import, not the
  checklist's expected `409`.
- **H2** SPA browser smoke against the staging Worker once browser control is
  available to Codex, or via another approved browser path.

## Suggested Verification Approaches

B4:

- Decide whether the intended contract is same-owner `200 pending` or active
  attempt `409`.
- If `200` is intended, update the B4 checkbox text and keep the existing
  router/integration behavior.
- If `409` is intended, change `markdownImportResultForOwnedReading` and the
  integration test that currently expects `200`.

H2:

- The Vite dev proxy currently points to local Worker.
- Easiest options:
  - temporarily point the dev proxy at `https://reading-lite-staging.bellbm.workers.dev`, or
  - deploy/use a Pages staging preview and smoke in browser with the staging token in localStorage.

## Important Guardrails

- Do not target production for these tests.
- Use staging base URL: `https://reading-lite-staging.bellbm.workers.dev`.
- Use staging bucket/index for cleanup:
  - `--bucket reading-lite-staging`
  - `--vectorize reading-lite-staging`
- `corpus-drop --allow-ready` refuses the production bucket name `reading-lite`, but command review is still required.
- Do not touch `.claude/autobuild-reports/handle-reddit-urls` unless explicitly asked.
