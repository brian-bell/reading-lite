# Testing Handoff — Idempotent URL Submits Staging

Branch: `codex/issue-33-idempotent-url-submits`

## Current State

Local branch is ahead of origin by five commits:

- `3bc32b0 Record staging idempotency smoke results`
- `aece12b Add Cloudflare staging infrastructure`
- `07f948c Add staging prerequisite to idempotency plan`
- `66e2a2d Record local-only idempotency rerun`
- `b07ba2e Record idempotent submit test pass`

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

### Group C

C1/C2/C3/C5 passed on staging.

C4 attempted but remains open:

- URL: `https://example.com/?reading-lite-staging-c4=20260620T180006Z`
- ID: `rd_DSZ4X2PEEN`
- POST returned `202`
- Immediate lookup returned `404` before the pointer was visible, so the intended `409` grace-window result was not proven
- Throwaway was cleaned up

### Group D

D3/D4 passed:

- Tested against ready id `rd_FS1FQZA06G`
- Reprocess start returned `202`
- Second reprocess while running returned `409 "reading already has an active attempt"`
- Force reprocess returned `202`
- Forced attempt finished and cleared `active_attempt`

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

- **B3** re-import failed Markdown owner and verify raw/extracted replacement.
- **B4** import over visible pending non-failed owner and verify `409`.
- **B5** verify import default email is false using staging email instrumentation or logs.
- **C4** deterministically verify lookup inside the missing-manifest grace window returns `409`.
- **D1** reprocess a retryable/transient failed reading through to `ready`.
- **D2** make a ready reading's reprocess attempt fail and verify prior ready manifest is preserved.
- **D5** reprocess a Markdown reading with missing stored extracted content.
- **H2** SPA browser smoke against the staging Worker.

## Suggested Verification Approaches

B3:

1. Create a failed URL reading using a 404 URL.
2. `POST /readings/import-markdown` for the same `source_url` with new markdown and title.
3. Verify same id returns `202`.
4. Poll to `ready`.
5. Verify raw/extracted content and title changed, and `error` / `active_attempt` are cleared.

B4:

1. `POST /readings/import-markdown` for a fresh source URL.
2. Wait until `GET /readings/:id` shows visible `pending`.
3. Immediately re-import the same source URL.
4. Expect `409 "reading already has an active attempt"`.

B5:

- Staging has `EMAIL_FROM` / `EMAIL_TO` empty, so direct email side effects may be disabled.
- Best options are staging logs/attempt-event inspection, or temporarily enabling staging email settings with a safe test recipient/provider behavior.

C4:

- The public race is hard to hit because the pointer-before-manifest window is very small.
- The previous staging attempt returned `404` before the pointer was visible.
- Prefer a deterministic staging-only/admin fixture or rely on existing integration coverage unless a better manual hook is added.

D1:

- Needs a failed reading whose next reprocess succeeds.
- Use a controllable URL that can flip from transient failure to success, or add a deterministic staging fixture.

D2:

- Needs a ready reading whose reprocess attempt then fails.
- Use a controllable URL that returns success first, then failure on reprocess, or add a deterministic staging fixture.

D5:

1. Create a Markdown reading.
2. Delete its stored `extracted.md` from staging R2.
3. `POST /readings/:id/reprocess`.
4. Expect `409 "markdown content not available"`.

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
