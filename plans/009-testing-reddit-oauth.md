# Testing Plan — Reddit OAuth Extraction (PR #45 / issue #16)

Branch: `worktree-handle-reddit-urls`

Covers the Reddit OAuth extraction path in the Worker plus the corpus-recover
routing/fetch changes that let the bulk recovery path use it.

## Scope of the change

- **Worker extractor** (`src/modules/extractor/{reddit,reddit-auth,index}.ts`):
  thread/comment URLs are rewritten to `oauth.reddit.com/*.json`, fetched with an
  app-only OAuth token (`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`) and a
  descriptive `REDDIT_USER_AGENT`. Missing credentials fail visibly instead of
  silently degrading to the HTML Readability path.
- **corpus-recover** (`scripts/corpus-recover.ts`, `scripts/corpus-lib/{policy,reason,browser-fetch}.ts`):
  Reddit failures now route to `local-extract` (not `skip`), and the local browser
  `fetch` wrapper preserves the extractor's OAuth headers instead of clobbering them.

## Can this be tested via `wrangler dev`?

**No.** The default (dev) environment binds only a local Miniflare R2 bucket —
it has **no queue and no Vectorize binding**. All three write routes
(`POST /readings`, `/readings/:id/reprocess`, `/readings/import-markdown`)
enqueue via `READING_JOBS.send()` and return a 503 "queue binding not
configured" without it, and Vectorize has no local emulator, so a reading can
never reach `ready` locally. `wrangler dev` is therefore not part of the
meaningful test path for this PR (only read-only list/detail routes work there).

Test in three layers instead:

| Layer | Proves | Where | Network / creds |
|---|---|---|---|
| 1. Automated | Logic + Worker request wiring | `npm test` (local) | none |
| 2. Reddit OAuth round-trip | Real token + `oauth.reddit.com` fetch works | Node harness | real Reddit creds, real net — **no staging** |
| 3. Full end-to-end | submit→queue→summarize→embed→`ready`; `corpus-recover --execute` | **staging** | real CF + all API keys |

---

## Layer 1 — Automated (no network)

**Run:** `npm test` and `npx tsc --noEmit`.

Covers:

- `test/unit/extractor/{reddit,reddit-auth,extractor}.test.ts` — thread-URL
  detection, `www→oauth` rewrite, token fetch, OAuth headers, missing-creds throw,
  listing→markdown.
- `test/unit/corpus/{policy,reason}.test.ts` — Reddit reasons route to
  `local-extract`; reason override beats status.
- `test/unit/corpus/browser-fetch.test.ts` — OAuth headers preserved; browser
  defaults filled only when absent.
- `test/integration/readings.test.ts` — Worker submit/queue behavior (injected
  queue + Vectorize stubs).

**Not covered here:** real Reddit network behavior (token endpoint, UA throttling,
live JSON shape) — these tests use a fake `fetch`. That's Layer 2.

---

## Layer 2 — Reddit OAuth round-trip (Node, no staging) — *manual*

Highest-value manual check; needs no deploy. The extractor is plain TS that runs
in Node, so the harness drives the real token + `oauth.reddit.com` round-trip.

**Prereq:** `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` in
`.dev.vars` (or the environment).

**Harness:** `scripts/manual/reddit-probe.ts`

```sh
# happy path
npx tsx scripts/manual/reddit-probe.ts "https://www.reddit.com/r/programming/comments/<id>/<slug>/"

# short link + old.reddit host variants
npx tsx scripts/manual/reddit-probe.ts "https://redd.it/<id>"
npx tsx scripts/manual/reddit-probe.ts "https://old.reddit.com/r/<sub>/comments/<id>/"

# failure mode: credentials must fail visibly, not degrade to HTML
npx tsx scripts/manual/reddit-probe.ts "https://www.reddit.com/r/x/comments/<id>/" --no-creds
```

**Assertions:**

- [ ] Happy path prints `content_status: "captured"`, a `title`, and a markdown
      preview containing the post body and/or top comments.
- [ ] The probe reports the rewritten `oauth.reddit.com/...json` URL.
- [ ] `--no-creds` throws `reddit credentials not configured` (exits 0 — that's
      the expected visible failure), confirming no silent HTML fallback.
- [ ] `redd.it` and `old.reddit.com` URLs both resolve and capture.

---

## Layer 3 — Full end-to-end (staging)

Required because the queue + Vectorize bindings exist only in deployed staging.

### Prereq — staging Reddit config (committed in this PR)

`wrangler.toml` now sets `REDDIT_USER_AGENT` under `[env.staging.vars]` and the
staging one-time-setup comment includes the Reddit secrets. Before testing:

```sh
wrangler secret put REDDIT_CLIENT_ID --env staging
wrangler secret put REDDIT_CLIENT_SECRET --env staging
npm run deploy -- --env staging --execute
```

### 3a. Worker path (manual)

- [ ] `POST /readings` with a Reddit thread URL → poll `GET /readings/:id` until
      `ready`. Confirm manifest `content_status: captured` and markdown contains
      the thread.
- [ ] Search/list returns the new reading (embedding indexed in Vectorize).
- [ ] Submit with credentials misconfigured (or a non-existent thread) → reading
      lands `failed` with a structured error, not a degraded HTML capture, and the
      URL stays re-submittable.

### 3b. corpus-recover routing (manual — the part this PR changed)

- [ ] Run `corpus-audit` over a corpus containing a previously-failed Reddit row.
- [ ] `corpus-recover` (dry-run): the Reddit row is planned as **`local-extract`**
      (not `skip`).
- [ ] `corpus-recover --execute`: the local fetch uses the OAuth path with the
      preserved Reddit UA/accept headers, and the re-imported reading reaches
      `ready`. (Exercises `fddc7b6` policy routing + `c654207` header preservation.)

---

## Recommended sequence

1. Layer 1 (`npm test` + `tsc`) — gate before anything else.
2. Layer 2 Node probe — fastest real-network confidence, no infra.
3. Layer 3 (staging) — only when the full pipeline / corpus-recover needs
   validation against real R2 + Vectorize.
