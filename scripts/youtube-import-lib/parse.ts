// Glue that turns locally-fetched YouTube inputs into a /readings/import-markdown
// request, reusing the same pure parsers the worker uses. Kept network-free so
// it is trivially unit-tested (the CLI does the fetching / yt-dlp shelling out).
//
// Why this exists: the worker's in-worker YouTube path reliably gets only the
// oEmbed floor (title + author) — datacenter egress is blocked from the watch
// page, so description + transcript almost never populate. Fetching from a
// residential IP (this machine) returns the full watch page, and yt-dlp can
// retrieve the transcript that bare timedtext fetches can't. See issue #17.

import {
  buildYoutubeMarkdown,
  canonicalWatchUrl,
  parseOembed,
  parsePlayerResponse,
  parseVideoId,
} from "../../src/modules/extractor/youtube";

export interface YoutubeImportInputs {
  // oEmbed JSON body (title + author — the required floor).
  oembedJson: string;
  // Watch-page HTML (best-effort: description + caption tracks). Optional.
  watchHtml?: string;
  // Plain-text transcript (best-effort, e.g. from yt-dlp). Optional.
  transcript?: string;
}

export interface YoutubeImportRequest {
  source_url: string;
  markdown: string;
  title?: string;
}

export function buildYoutubeImport(
  url: string,
  inputs: YoutubeImportInputs,
): YoutubeImportRequest | null {
  const videoId = parseVideoId(url);
  if (!videoId) return null;

  const oembed = parseOembed(inputs.oembedJson);
  if (!oembed) return null;

  const player = inputs.watchHtml ? parsePlayerResponse(inputs.watchHtml) : null;
  const watchUrl = canonicalWatchUrl(videoId);

  const markdown = buildYoutubeMarkdown({
    title: oembed.title,
    authorName: oembed.authorName,
    authorUrl: oembed.authorUrl,
    watchUrl,
    description: player?.shortDescription,
    transcript: inputs.transcript,
  });

  return { source_url: watchUrl, markdown, title: oembed.title };
}
