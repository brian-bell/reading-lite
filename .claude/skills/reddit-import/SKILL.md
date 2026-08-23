---
name: reddit-import
description: Import a Reddit thread (post + top comments) into the reading-lite corpus. Reddit serves a bot-challenge to the worker, so this drives a logged-in Chrome session via chrome-devtools-mcp to fetch the public thread `.json`, renders it to markdown with the shared parser, and imports it through POST /api/readings/import-markdown. Use when the user wants to add, submit, save, or process a reddit.com / redd.it thread or comment URL, or to recover a Reddit reading that corpus-audit marked failed.
---

# reddit-import

Add a Reddit thread to reading-lite. The Cloudflare Worker can't fetch Reddit
directly — datacenter egress gets an HTML bot-challenge instead of JSON — so a
plain `POST /api/readings` with a Reddit URL lands `failed` on purpose. This skill is
the supported path: it uses a **logged-in Chrome session** (which clears the
challenge) to fetch the public `<thread>.json`, renders it to markdown with the
same `redditListingToMarkdown` parser the worker uses, and imports the markdown.

## Prerequisites

- **Chrome running and logged in to Reddit**, reachable by the
  `chrome-devtools-mcp` tools (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`).
- A reading-API bearer token for the import target (default **production**):
  `READER_API_TOKEN` in the environment or `.prd.vars`. Pass `--token` / `--api-url`
  to override.

## Workflow

Given a Reddit thread or comment URL (`reddit.com/...` or `redd.it/<id>`):

1. **Navigate** Chrome to the thread so the JS bot-challenge resolves and the URL
   settles (this also follows `redd.it` / share-link redirects):
   `navigate_page({ url: <redditUrl>, type: "url", timeout: 30000 })`.

2. **Capture the canonical URL.** After navigation, read Chrome's resolved
   location (this is what dedupes `redd.it` shortlinks and tracking-param variants
   to one reading) — use it as the import key in step 3:

   ```js
   // function (inline result, no filePath):
   () => location.origin + location.pathname.replace(/\/$/, "")
   ```

3. **Fetch the public JSON** from the resolved page, *returning the parsed object*
   so the saved file is clean Reddit listing JSON (not a double-encoded string).
   Save it under the repo with `evaluate_script`'s `filePath`:

   ```js
   // function:
   async () => {
     const jsonUrl = location.origin + location.pathname.replace(/\/$/, "") +
       ".json?raw_json=1&limit=20&sort=top";
     const res = await fetch(jsonUrl, { headers: { accept: "application/json" }, credentials: "include" });
     if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) {
       return { error: res.status };   // not logged in / hit a challenge
     }
     return await res.json();   // return the OBJECT; filePath then writes valid JSON
   }
   // filePath: ".reddit-thread.tmp.json" (gitignored)
   ```

   If the result is `{ error: ... }`, the session likely isn't logged in or hit a
   challenge — stop and tell the user to open the thread in Chrome first.

4. **Import** with the helper, keyed by the **canonical URL** from step 2 — that
   becomes the reading's `source_url` / ownership key:

   ```sh
   npm run ops -- import reddit "<canonicalRedditUrl>" --json .reddit-thread.tmp.json --execute
   ```

   Omit `--execute` first to show the rendered markdown without writing. Add
   `--api-url <base>` / `--token <tok>` to target staging or pass a token
   explicitly. The tool prints the new reading id and a poll URL.

5. **Clean up** the temp file (`rm .reddit-thread.tmp.json`; it's gitignored, but
   it can hold content from your logged-in session so don't leave it around) and
   report the id / poll URL. The reading processes through the normal queue → poll
   `GET /api/readings/:id` until `ready`.

## Notes / gotchas

- **Use the resolved canonical URL as the import key**, not the raw string the
  user pasted. It becomes the reading's `source_url`, so keying on the resolved
  `origin + pathname` (step 2) dedupes `redd.it/<id>`, `old.reddit.com`, and
  tracking-param variants of the same thread to a single reading.
- **No Reddit app / OAuth needed.** This path deliberately avoids API credentials;
  it relies only on your normal logged-in Reddit browser session.
- **`redd.it` shortlinks and `/r/<sub>/s/<token>` share links** work — step 1's
  navigation resolves the redirect to the full thread URL before the in-page
  `.json` fetch (and step 2 captures that resolved URL as the canonical key).
- This is **local + manual** by design; it can't run inside the worker or the SPA
  submit flow.

## Implementation

- CLI: `scripts/ops-lib/commands/import-reddit.ts`; parser glue (tested):
  `scripts/reddit-import-lib/parse.ts` (`buildRedditImport`).
- Markdown rendering: `redditListingToMarkdown` + `isRedditThreadUrl` in
  `src/modules/extractor/reddit.ts` (shared with the worker).
- Import client: `scripts/corpus-lib/api.ts` (`importMarkdown`); target/token
  resolution: `scripts/corpus-lib/config.ts` (`resolveApiTarget`).
- Tests: `test/unit/reddit-import/parse.test.ts` (node project).
