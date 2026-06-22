# Plan 010 — Extractor: support YouTube watch pages (metadata + transcript)

Implements [issue #17](https://github.com/brian-bell/reading-lite/issues/17).

## Problem

YouTube watch URLs can't be summarized today. The watch page is a JS app with
no server-rendered article body, so Readability returns nothing and the reading
degrades to `raw_only` (or `failed` when the unauthenticated fetch 429s). One
reading is stuck `failed` in the corpus:

- `https://www.youtube.com/watch?v=YtTWNzOtkxU` — flagged by `corpus-audit` as
  "Not an article — YouTube video page" and routed to `skip` by the recover
  policy.

## Goal / Acceptance

- A YouTube watch URL produces non-empty markdown (title + author + description,
  plus transcript when obtainable) and summarizes to `ready`.
- Unit tests for URL detection + a metadata/`ytInitialPlayerResponse` parse
  fixture + a timedtext transcript parse fixture.
- The URL above re-processes to `ready` (verified against staging/prod).
- `RateLimitedError` / retry handling on the primary metadata fetch is preserved.

## Approach decision: in-worker extraction (not a manual-import skill)

The issue proposes in-worker extraction, and that is the right call here
(unlike Reddit, which is unfetchable from datacenter egress and routes to the
`reddit-import` skill). YouTube exposes a **public oEmbed endpoint** that
returns title + author reliably from a Worker, so we can produce useful markdown
without a browser. We layer enrichment on top in tiers so the reading still
lands `ready` even when the flaky bits fail:

- **Tier 1 — required floor (oEmbed):**
  `GET https://www.youtube.com/oembed?url=<watch-url>&format=json` → `title`,
  `author_name`, `author_url`, `thumbnail_url`. This is a stable public API and
  is the guaranteed content floor. A 429 here surfaces `RateLimitedError` so the
  queue retries (issue requirement). A 401/404 here (private/deleted video) is a
  real `BadStatusError` → `failed`.
- **Tier 2 — best-effort (watch page):** fetch
  `https://www.youtube.com/watch?v=<id>` with a desktop UA + `CONSENT` cookie,
  scrape the embedded `ytInitialPlayerResponse` JSON for
  `videoDetails.shortDescription` and `captions...captionTracks[]`. Any error
  here (including 429) is **caught and degraded** — we keep the Tier-1 floor
  rather than fail the whole reading on a flaky enrichment fetch.
- **Tier 3 — best-effort (transcript):** fetch the first caption track
  `baseUrl` (`&fmt=json3`), parse to plain text. Caught/degraded like Tier 2.
  YouTube increasingly gates timedtext behind signature/`pot` params, so treat
  transcript as a bonus, never a requirement.

Rationale for the tiering: the issue explicitly leaves "transcript required vs
best-effort" open and suggests "title + description as a floor." Because the
watch page itself is the part that "frequently 429s," description is also
best-effort; the only hard guarantee is oEmbed (title + author). That is still
non-empty, summarizable markdown — acceptance is met even in the worst case, and
the common case (single reprocess, watch page reachable) yields description +
often a transcript.

### Markdown shape produced

```markdown
# <title>

*By [<author_name>](<author_url>)* · [Watch on YouTube](<watch-url>)

<shortDescription>

## Transcript

<flattened caption text>
```

The author line / description / transcript sections are each omitted when their
source is unavailable, so a Tier-1-only result is just the title + author +
watch link.

## Where this hooks in

`extractFromUrl` ([src/modules/extractor/index.ts:30](../src/modules/extractor/index.ts)) dispatches by
content type after a generic bounded fetch. We add a YouTube branch **before**
the generic fetch (mirroring the Reddit short-circuit at
[index.ts:35](../src/modules/extractor/index.ts)), because the YouTube path
needs its own multi-fetch flow (oEmbed + watch page + timedtext) rather than the
single `fetchBounded` + Readability pipeline.

```ts
assertSafeUrl(url);
if (isRedditThreadUrl(url)) throw new RedditManualImportError(url);
if (isYoutubeWatchUrl(url)) return extractYoutube(url, deps);   // NEW
const { raw, contentType } = await fetchBounded(url, deps);
...
```

`extractYoutube` returns the same `ExtractedContent` contract the rest of the
pipeline already consumes ([process-reading.ts:412](../src/process-reading.ts)),
so no pipeline, manifest, schema, or SPA-type changes are required:

- `raw` / `content_type` / `content_bytes` / `content_sha256`: the watch-page
  HTML bytes when Tier 2 succeeded, otherwise the oEmbed JSON bytes (so the R2
  `raw.{ext}` write stays meaningful and the sha is over real fetched bytes).
- `content_status`: `"captured"` (we always have ≥ title).
- `markdown`: the assembled document above.
- `title`: oEmbed `title`.

`fetchBounded` is currently a private helper. We need bounded fetch + retry +
429→`RateLimitedError` semantics for the YouTube fetches too, so **export an
internal `fetchBounded`** (or a thin `fetchBoundedJson` wrapper) from `index.ts`
and pass `init` (headers for the watch-page request). Keep the 429 behavior:
oEmbed lets it throw; Tier 2/3 wrap in try/catch.

## Files to add / change

### New: `src/modules/extractor/youtube.ts`

Pure, testable helpers (no network; network is injected via `deps.fetch`):

- `isYoutubeWatchUrl(rawUrl: string): boolean` — true for:
  - `youtube.com` / `*.youtube.com` / `youtube-nocookie.com` with `/watch?v=<id>`
  - `youtu.be/<id>` (path is the id)
  - `youtube.com/shorts/<id>` and `/live/<id>` and `/embed/<id>`
  False for homepage, channels, playlists-without-video, search.
- `parseVideoId(rawUrl: string): string | null` — normalize all the above to the
  11-char id.
- `parsePlayerResponse(html: string): { shortDescription?: string; captionTracks: { baseUrl: string; languageCode?: string; kind?: string }[] } | null`
  — locate `ytInitialPlayerResponse = ` in the HTML and brace-match the JSON
  object (string/escape-aware scan, not a greedy regex), zod-parse the slices we
  use, tolerate missing fields.
- `timedtextToText(body: string): string` — parse a caption track. Support both
  `fmt=json3` (`{ events: [{ segs: [{ utf8 }] }] }`) and the legacy XML
  (`<text start=… dur=…>…</text>`, HTML-entity-decoded). Join segments,
  collapse whitespace.
- `buildYoutubeMarkdown(parts: { title; authorName?; authorUrl?; watchUrl; description?; transcript? }): string`
  — assemble the document; omit empty sections; return trimmed.
- zod schemas for the oEmbed response (`title`, `author_name?`, `author_url?`,
  `thumbnail_url?`) and the player-response slices (validate-at-the-seam
  convention).

### New error: `src/modules/extractor/errors.ts`

Add a typed error for the unrecoverable case (video private/deleted/region-locked
where even oEmbed 4xxs and we have nothing). Reuse `BadStatusError` if the oEmbed
status is a plain HTTP status; only add a dedicated `YoutubeUnavailableError` if
we want a distinct corpus reason. **Recommendation:** reuse `BadStatusError`
(simplest, already classified by `reason.ts`/`policy.ts`) and skip a new error
class unless tests show a need.

### Edit: `src/modules/extractor/index.ts`

- Import `isYoutubeWatchUrl` + the YouTube extractor.
- Add the short-circuit branch shown above.
- Export `fetchBounded` (internal) so `extractYoutube` can reuse bounded fetch +
  retry. Either move `extractYoutube` into `index.ts` or keep it in `youtube.ts`
  and pass `fetchBounded` in. **Recommendation:** keep the orchestration
  (`extractYoutube`) in `index.ts` next to `fetchBounded`, keep the pure parsers
  in `youtube.ts`. This keeps `youtube.ts` network-free and trivially unit-tested.

### Edit: `scripts/corpus-lib/reason.ts`

- Remove the `YouTube video page` `FAILURE_OVERRIDES` entry (line 8). Once
  supported, a failed YouTube reading is reprocessable, not "not an article."

### Edit: `scripts/corpus-lib/policy.ts`

- Remove `YouTube` from the skip regex (line 32: `/not an article|PDF|YouTube/i`
  → `/not an article|PDF/i`) so YouTube failures fall through to the normal
  switch and route to `reprocess`. The stuck reading then recovers via a normal
  `corpus-recover --execute` pass (or a manual reprocess).

## Tests (TDD — write red first)

### `test/unit/extractor/youtube.test.ts` (new, pure helpers)

1. `isYoutubeWatchUrl` / `parseVideoId` truth table:
   - ✅ `https://www.youtube.com/watch?v=YtTWNzOtkxU` → `YtTWNzOtkxU`
   - ✅ `https://youtu.be/YtTWNzOtkxU`, `?t=30` variants
   - ✅ `https://www.youtube.com/shorts/<id>`, `/live/<id>`, `youtube-nocookie.com/embed/<id>`
   - ❌ `https://www.youtube.com/`, `/results?search_query=…`, `/@channel`,
     `/playlist?list=…` (no video id)
2. `parsePlayerResponse` against an inline `ytInitialPlayerResponse` fixture
   (a trimmed real shape with nested braces and escaped quotes inside
   `shortDescription`) → extracts description + caption track baseUrls; returns
   `null` / empty on absent script.
3. `timedtextToText`:
   - json3 fixture → flattened text.
   - legacy XML fixture (`<text>` nodes with `&amp;`/`&#39;` entities) →
     decoded, flattened text.
4. `buildYoutubeMarkdown`: full result (title+author+desc+transcript) and
   floor-only result (title+author) — assert sections present/omitted.

### `test/unit/extractor/extractor.test.ts` (extend, integration via injected fetch)

Use the existing `fakeFetch(responses, onRequest)` harness. Register stub
responses keyed by the exact oEmbed / watch / timedtext URLs.

5. **Happy path:** oEmbed JSON + watch HTML (with `ytInitialPlayerResponse`) +
   timedtext json3 all stubbed → `content_status: "captured"`, `title` set,
   markdown contains title, author, a description sentence, and a transcript
   phrase. Assert the generic Readability path was **not** used.
6. **Floor only:** oEmbed 200, watch page 429 (and/or timedtext 429) → still
   `captured`, markdown has title + author, no `## Transcript`. Assert the
   reading does **not** throw (best-effort degrade).
7. **Rate-limited primary:** oEmbed itself 429 → `extractFromUrl` throws
   `RateLimitedError` (queue-retry contract preserved).
8. **Unavailable:** oEmbed 404 → throws `BadStatusError` (lands `failed` with a
   sensible reason).
9. **`youtu.be` short link** routes through the YouTube path (assert via
   `onRequest` that the oEmbed URL was requested, not a generic GET of the
   short link).

### `test/unit/corpus/{reason,policy}.test.ts` (edit)

- `reason.test.ts:29` currently expects "Not an article" for the YouTube URL —
  update to the derived reason now that the override is gone.
- Add a `policy.test.ts` case asserting a failed YouTube row routes to
  `reprocess` (not `skip`).

## Verification

- `npm run test:quiet -- test/unit/extractor` and `… test/unit/corpus`.
- Full gate: `npm test` + `npm run typecheck`.
- SPA unaffected (no type changes), but run `cd web && npm run build` if
  `web/src/types.ts` is touched (it shouldn't be).
- **Live:** reprocess `https://www.youtube.com/watch?v=YtTWNzOtkxU` against
  staging first (`POST /readings/:id/reprocess` or resubmit), confirm `ready`
  with non-empty markdown + a TL;DR; then prod. Record the outcome in a short
  verification note (this plan's "Acceptance" line item).

## Risks / open questions

- **Watch-page 429 frequency:** if datacenter egress 429s the watch page nearly
  always, descriptions/transcripts will rarely populate and readings will be
  title+author-thin. Mitigation already in design: oEmbed floor keeps them
  `ready`; the desktop UA + `CONSENT=YES+cb` cookie reduces consent-wall/bot
  friction. If thinness proves unacceptable in practice, a follow-up could add a
  browser-backed `youtube-import` skill (Reddit model) as a Tier-2 fallback —
  out of scope here.
- **timedtext gating:** signature/`pot` requirements may make Tier 3 fail often.
  Acceptable — transcript is explicitly best-effort.
- **`ytInitialPlayerResponse` shape drift:** guarded by zod-at-the-seam +
  graceful null; a shape change degrades to floor, never throws.
- **SSRF:** all fetched hosts are youtube.com/youtu.be/ytimg domains derived
  from the parsed video id, not arbitrary input; `assertSafeUrl` still runs on
  the original URL. Do not follow `baseUrl`/`thumbnail_url` to non-YouTube hosts
  without a host check.

## Out of scope

- A browser-driven `youtube-import` skill / `scripts/youtube-import.ts`.
- Playlist, channel, or live-stream summarization.
- SPA changes.
```
