# Testing Plan — Reddit local import (PR #45 / issue #16)

Branch: `worktree-handle-reddit-urls`

Covers the Reddit handling in reading-lite: the Worker degrades Reddit URLs to a
clear failure, and a local **`reddit-import`** skill ingests them through a
logged-in Chrome session instead of OAuth.

## Verification status (as of commit `fcedd7b`)

- ✅ **Layer 1 — Automated:** `npm test` (610 passing) + `npm run typecheck` clean.
- ✅ **Layer 2 — Offline tool:** `reddit-import.ts --dry-run` against a real saved
  thread `.json` renders correct markdown.
- ✅ **Layer 3 — Live import path (prod):** Chrome → public `.json` → import →
  `ready`, verified against production (reading `rd_9VTDEM3PMQ`).
- ⏳ **Deferred to post-deployment:** the Worker-rejection path and the
  corpus-recover Reddit routing can only be checked *live* once this branch is
  deployed (prod currently runs the pre-PR Worker). Both are covered by automated
  tests; see [Post-deployment manual verification](#post-deployment-manual-verification).

## Why not OAuth / `wrangler dev`?

Reddit serves an HTML **bot-challenge** to datacenter egress, so the Cloudflare
Worker can't fetch thread JSON at all — not via the public `.json` path and not
worth maintaining an OAuth app for a personal service. A spike confirmed a real
**logged-in Chrome session** clears the challenge and an in-page `fetch` of the
public `<thread>.json` returns clean listing JSON (HTTP 200), which the existing
`redditListingToMarkdown` parser renders perfectly.

So the design is: the Worker **fails Reddit URLs visibly** (`RedditManualImportError`
→ `failed` manifest with guidance), and the local `reddit-import` skill does the
fetch-in-Chrome → parse → `POST /readings/import-markdown`.

`wrangler dev` still can't process imports (no Queue/Vectorize binding locally),
so end-to-end import is tested against deployed **production** (the skill's
default target).

| Layer | Proves | Where | Network | Status |
|---|---|---|---|---|
| 1. Automated | Detection, degrade-to-failure, parser, import-request build, corpus routing | `npm test` (local) | none | ✅ verified |
| 2. Tool, offline | CLI renders real Reddit JSON → markdown | `reddit-import.ts --dry-run` | none (saved `.json`) | ✅ verified |
| 3. Skill end-to-end | Chrome fetch → parse → import → `ready` | local Chrome + prod | logged-in Reddit + prod API | ✅ verified (prod) |

---

## Layer 1 — Automated (no network) — ✅ verified

**Run:** `npm test` (610 passing) and `npm run typecheck` (clean).

Covers:

- ✅ `test/unit/extractor/extractor.test.ts` — Reddit thread, `redd.it`, and
  `/s/` share-link URLs throw `RedditManualImportError` and make **no** fetch.
- ✅ `test/unit/extractor/reddit.test.ts` — `isRedditThreadUrl` detection across
  `*.reddit.com` subdomains, `redd.it`, and `/r/<sub>/s/<token>` share links,
  plus the host-spoof guard (`reddit.com.evil.com` rejected).
- ✅ `test/unit/reddit-import/parse.test.ts` — `buildRedditImport` renders a thread
  listing into an import request; returns null on non-thread JSON.
- ✅ `test/unit/corpus/{policy,reason}.test.ts` — Reddit failures classify as
  "import via local skill" and route to **`skip`** (not OAuth local-extract).
- ✅ `test/unit/corpus/batch/**` (10 files, 60 tests) — bulk batch path still
  green; Reddit rows are `skip`, so they never enter the batch (`reprocess` +
  `local-extract` only).
- ✅ `test/unit/deploy/staging-env.test.ts` — staging setup no longer prompts for
  Reddit secrets.
- ✅ `test/integration/readings.test.ts` — a Reddit `POST /readings` lands
  `failed` with `error.code === "RedditManualImportError"` (throw-before-fetch),
  plus general submit/queue behavior.

---

## Layer 2 — Tool, offline (no network) — ✅ verified

Render a real saved Reddit `.json` through the CLI without importing:

```sh
npx tsx scripts/reddit-import.ts \
  "https://www.reddit.com/r/<sub>/comments/<id>/<slug>/" \
  --json <saved-thread.json> --dry-run
```

**Assertions:**

- [x] Prints `source_url`, a `title`, and Markdown containing the post body/link
      and `## Top comments`. *(Verified: r/programming "Old Software Was Fast"
      thread → 3.7 KB markdown, post link + top comments.)*
- [x] A non-thread file (HTML challenge page, `{}`) returns null → the CLI exits
      non-zero with a "not a Reddit thread" message. *(Covered by
      `reddit-import/parse.test.ts`; CLI surfaces it.)*

(To produce `<saved-thread.json>`, run steps 1–3 of the skill below.)

---

## Layer 3 — Skill end-to-end — ✅ import path verified (prod)

**Prereq:** Chrome running and logged in to Reddit; `READER_API_TOKEN` in
`.prd.vars` (or env). The skill is agent-driven via `chrome-devtools-mcp`.

1. Navigate Chrome to the thread (clears the JS challenge, resolves `redd.it` /
   `/s/` share links).
2. `evaluate_script` to read the resolved canonical URL (`location.origin +
   pathname`) — used as the import key so shortlink/param variants dedupe.
3. `evaluate_script` to `fetch` the public `<thread>.json`, **returning the
   parsed object** so the `filePath`-saved file is valid JSON.
4. `npx tsx scripts/reddit-import.ts "<canonicalUrl>" --json <tmp>` → import to prod.
5. Poll `GET /readings/:id` until `ready`; clean up the temp file.

**Assertions:**

- [x] Happy path imports (`new`) and the reading reaches `ready` with
      `content_status: captured` and the thread Markdown. *(Verified: imported
      `rd_9VTDEM3PMQ`, ready, captured, real TLDR/tags, `novelty_verdict: novel`.)*
- [x] The reading appears in search/list. *(Verified: `?q=old software` returns
      `rd_9VTDEM3PMQ`.)*
- [ ] `redd.it` shortlinks and `old.reddit.com` hosts resolve before the `.json`
      fetch. *(Detection covered by Layer 1; not re-run live for every host —
      the navigation-then-canonical step handles redirects uniformly.)*

---

## Post-deployment manual verification

These need the **deployed Worker running this branch** (staging or prod). They
can't be checked against current prod, which still runs the pre-PR Worker. All
are covered by automated tests; this is the live confirmation after `npm run
deploy -- --env <env> --execute`.

- [ ] **Worker rejects Reddit URLs.** `POST /readings` with a `reddit.com` /
      `redd.it` / `/r/<sub>/s/<token>` URL → reading lands `failed` with
      `error.code === "RedditManualImportError"` (not a captured bot-challenge,
      not `raw_only`), and the URL stays re-submittable.
      *(Automated: `test/integration/readings.test.ts`.)*
- [ ] **corpus-recover routes Reddit to skip.** Run `corpus-audit` over a corpus
      containing a failed Reddit row, then `corpus-recover` (dry-run): the row is
      planned as **`skip`** ("import via local reddit-import skill"), not
      `local-extract`. *(Automated: `test/unit/corpus/{reason,policy}.test.ts`.)*
- [ ] **(Optional) Live `--batch`.** `corpus-recover --batch` was not run live
      (needs R2 + Vectorize + Anthropic batch creds and a real backlog). It is
      unchanged by this PR and covered by `test/unit/corpus/batch/**`; Reddit rows
      are excluded from it (they `skip`). Run only if exercising a real backfill.

---

## Recommended sequence

1. Layer 1 (`npm test` + `tsc`) — gate before anything else.
2. Layer 2 dry-run — fastest confidence in the render/import wiring.
3. Layer 3 — full Chrome → prod path when validating the skill itself.
4. Post-deploy — confirm the Worker-rejection + corpus-recover routing live once
   the branch is deployed.
