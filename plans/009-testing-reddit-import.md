# Testing Plan — Reddit local import (PR #45 / issue #16)

Branch: `worktree-handle-reddit-urls`

Covers the Reddit handling in reading-lite: the Worker degrades Reddit URLs to a
clear failure, and a local **`reddit-import`** skill ingests them through a
logged-in Chrome session instead of OAuth.

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

| Layer | Proves | Where | Network |
|---|---|---|---|
| 1. Automated | Detection, degrade-to-failure, parser, import-request build, corpus routing | `npm test` (local) | none |
| 2. Tool, offline | CLI renders real Reddit JSON → markdown | `reddit-import.ts --dry-run` | none (uses a saved `.json`) |
| 3. Skill end-to-end | Chrome fetch → parse → import → `ready` | local Chrome + prod | logged-in Reddit + prod API |

---

## Layer 1 — Automated (no network)

**Run:** `npm test` and `npm run typecheck`.

Covers:

- `test/unit/extractor/extractor.test.ts` — Reddit thread + `redd.it` URLs throw
  `RedditManualImportError` and make **no** fetch.
- `test/unit/extractor/reddit.test.ts` — `isRedditThreadUrl` detection
  (`*.reddit.com` + host-spoof guard) and `redditJsonUrl` → **public**
  `www.reddit.com/<path>.json`.
- `test/unit/reddit-import/parse.test.ts` — `buildRedditImport` renders a thread
  listing keyed by the original URL; returns null on non-thread JSON.
- `test/unit/corpus/{policy,reason}.test.ts` — Reddit failures classify as
  "import via local skill" and route to **`skip`** (not OAuth local-extract).
- `test/unit/deploy/staging-env.test.ts` — staging setup no longer prompts for
  Reddit secrets.
- `test/integration/readings.test.ts` — Worker submit/queue behavior.

---

## Layer 2 — Tool, offline (no network) — *manual*

Render a real saved Reddit `.json` through the CLI without importing:

```sh
npx tsx scripts/reddit-import.ts \
  "https://www.reddit.com/r/<sub>/comments/<id>/<slug>/" \
  --json <saved-thread.json> --dry-run
```

**Assertions:**

- [ ] Prints `source_url` = the original URL, a `title`, and Markdown containing
      the post body/link and `## Top comments`.
- [ ] A non-thread file (HTML challenge page, `{}`) exits non-zero with a clear
      "not a Reddit thread" message rather than importing garbage.

(To produce `<saved-thread.json>`, run step 2 of the skill below.)

---

## Layer 3 — Skill end-to-end (local Chrome + prod) — *manual*

**Prereq:** Chrome running and logged in to Reddit; `READER_API_TOKEN` in
`.prd.vars` (or env). The skill is agent-driven via `chrome-devtools-mcp`.

1. Navigate Chrome to the thread (clears the JS challenge, resolves `redd.it`).
2. `evaluate_script` to `fetch` the public `<thread>.json` from the resolved
   `location` (`credentials:"include"`), **returning the parsed object** so the
   `filePath`-saved file is valid JSON.
3. `npx tsx scripts/reddit-import.ts "<originalUrl>" --json <tmp>` → import to prod.
4. Poll `GET /readings/:id` until `ready`; clean up the temp file.

**Assertions:**

- [ ] Happy path imports (`new`/`existing`) and the reading reaches `ready` with
      `content_status: captured` and the thread Markdown.
- [ ] `redd.it` shortlinks and `old.reddit.com` hosts both work (navigation
      resolves them before the in-page `.json` fetch).
- [ ] A Reddit URL submitted via the Worker (`POST /readings`) lands `failed`
      with the `RedditManualImportError` guidance and stays re-submittable.
- [ ] `corpus-audit` over a corpus with a failed Reddit row → `corpus-recover`
      (dry-run) plans it as **`skip`** ("import via local reddit-import skill"),
      not local-extract.

---

## Recommended sequence

1. Layer 1 (`npm test` + `tsc`) — gate before anything else.
2. Layer 2 dry-run — fastest confidence in the render/import wiring.
3. Layer 3 — full Chrome → prod path when validating the skill itself.
