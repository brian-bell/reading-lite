---
name: youtube-import
description: Import a YouTube video into the reading-lite corpus with a full local extraction — title + author (oEmbed), description (watch-page metadata), and the transcript (via yt-dlp). The worker only reliably gets the oEmbed floor because datacenter egress is blocked from the watch page and timedtext is token-gated; this fetches from a residential IP and does the yt-dlp handshake. Use when the user wants to add, submit, save, or richly (re-)process a youtube.com / youtu.be video, or to upgrade a thin worker-made YouTube reading to one with description + transcript.
---

# youtube-import

Add a YouTube video to reading-lite with the **full** text the in-worker path
can't get. Submitting a YouTube URL to the worker (`POST /api/readings`) works and
lands `ready`, but only on the **oEmbed floor** (title + author): Cloudflare
datacenter egress is blocked from the watch page (so no description) and YouTube
gates the transcript (`timedtext`) behind a proof-of-origin token (so a bare
fetch returns empty — even locally). This skill runs locally, where the watch
page loads and **yt-dlp** performs the player handshake that retrieves captions.

## Prerequisites

- **`yt-dlp` installed** (`brew install yt-dlp`), for the transcript. Without it
  the skill still imports title + author + description; pass `--no-transcript` to
  skip it deliberately.
- A reading-API bearer token for the import target (default **production**):
  `READER_API_TOKEN` in the environment or `.prd.vars`. Pass `--token` /
  `--api-url` to override (e.g. point at staging).

## Workflow

Given a YouTube watch / `youtu.be` / `shorts` / `live` / `embed` URL:

1. **Dry-run first** to see the rendered markdown (fetches oEmbed + watch page
   and runs yt-dlp, but does not POST):

   ```sh
   npm run ops -- import youtube "<youtubeUrl>"
   ```

   The header line reports the resolved `source_url`, title, transcript length,
   and markdown size. If transcript shows `(none)`, the video has no captions or
   yt-dlp couldn't fetch them — the import still proceeds with description.

2. **Import** by adding `--execute`. Add `--api-url <base>` / `--token <tok>`
   to target staging or pass a token explicitly:

   ```sh
   npm run ops -- import youtube "<youtubeUrl>" --execute
   ```

   The tool prints the reading id and a poll URL. The reading processes through
   the normal queue → poll `GET /api/readings/:id` until `ready`.

3. **Upgrading a thin worker reading.** If the URL already has a worker-made
   floor-only reading, the import returns `existing` and does **not** replace it
   (ready/pending owners are returned as-is). To replace it with the richer
   import, drop the old one first, then re-import.

   `--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is the pre-tenant layout: local only and the leftover global objects production and staging both retain. Staging pins the gate too, so staging corpus commands take its founder tenant id, not `global`. A `usr_…` id addresses that tenant's `u/{tenantId}/` namespace.

   ```sh
   npm run ops -- corpus drop --tenant "$TENANT" "<canonicalWatchUrl>" --execute
   npm run ops -- import youtube "<youtubeUrl>" --execute
   ```

   The import always claims the **canonical** watch URL, but a thin reading may
   have been submitted under a noncanonical form (`youtu.be`, `/shorts`, `/live`,
   `/embed`). Before importing, the tool looks those variants up and prints a
   `corpus-drop` line for each pre-existing one — drop the variant it names (not
   necessarily the canonical URL) to avoid leaving a duplicate behind.

## Notes / gotchas

- **Canonical key.** The import is keyed by the canonical
  `https://www.youtube.com/watch?v=<id>` URL (derived from any accepted form), so
  `youtu.be/<id>`, `/shorts/<id>`, and `?t=` variants this tool imports dedupe to
  one reading. A reading **already** stored under a noncanonical form (from a
  prior `/api/readings` submission) is a separate by-url owner — the tool detects and
  warns about those (see step 3) rather than silently duplicating.
- **Transcript size cap.** Import markdown rides a Cloudflare queue message
  (128 KB). A very long transcript is truncated to fit (with a visible notice)
  so the import can't 503 server-side after a reading is already claimed.
- **Transcript is best-effort.** Manually-captioned and many auto-captioned
  videos work via yt-dlp; some return nothing. Description (from the watch page)
  is the reliable win over the worker; transcript is the bonus.
- **Imported as markdown.** The reading is created via `/api/readings/import-markdown`
  (`source_type: "markdown"`), so it summarizes the supplied text directly — no
  re-fetch — which is why the rich local markdown is what gets summarized.
- **Local + manual by design.** It can't run inside the worker or the frontend submit
  flow (it needs a residential IP and the yt-dlp binary).

## Implementation

- CLI: `scripts/ops-lib/commands/import-youtube.ts` (fetches oEmbed + watch page, shells out to
  yt-dlp for the transcript). Parser glue:
  `scripts/youtube-import-lib/parse.ts` (`buildYoutubeImport`).
- Markdown rendering + URL parsing: `src/modules/extractor/youtube.ts`
  (`parseVideoId`, `parseOembed`, `parsePlayerResponse`, `timedtextToText`,
  `buildYoutubeMarkdown`) — shared with the worker.
- Import client: `scripts/corpus-lib/api.ts` (`importMarkdown`); target/token
  resolution: `scripts/corpus-lib/config.ts` (`resolveApiTarget`).
