// Glue that turns locally-fetched YouTube inputs into a /api/readings/import-markdown
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
  type YoutubeMarkdownParts,
} from "../../src/modules/extractor/youtube";
import { MARKDOWN_IMPORT_MAX_BYTES } from "../import-markdown-lib/parse";

const TRUNCATION_NOTICE = "\n\n_[transcript truncated to fit the import size limit]_";

// /api/readings/import-markdown enqueues a ProcessReadingArgs message whose body is
// the markdown plus an envelope (id, url, urlHash, keyPrefix, attempt metadata,
// source.kind/title, JSON framing) and ~100 bytes of Cloudflare-internal queue
// metadata. The 128 KB queue limit applies to that serialized message, not the
// markdown alone, so capping the markdown at exactly MARKDOWN_IMPORT_MAX_BYTES
// can still push the send over the limit *after* the reading is claimed/written.
// Unlike hand-authored markdown, this cap fills the transcript right up to the
// ceiling, so reserve generous headroom (the real envelope is well under 1 KB).
const QUEUE_ENVELOPE_RESERVE = 1024;
const MARKDOWN_MESSAGE_BUDGET = MARKDOWN_IMPORT_MAX_BYTES - QUEUE_ENVELOPE_RESERVE;

// Slice `text` to at most `maxBytes` UTF-8 bytes without leaving a split
// multibyte character (Buffer.toString renders a dangling sequence as U+FFFD).
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  let out = buf.subarray(0, maxBytes).toString("utf8");
  if (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

// The Worker forwards import markdown inside a Cloudflare queue message, capped
// at 128 KB (MARKDOWN_IMPORT_MAX_BYTES). A long transcript can blow past that
// and 503 the import *after* a reading has already been claimed/written failed,
// so trim the transcript to the remaining byte budget here instead.
function capTranscript(
  parts: YoutubeMarkdownParts,
  transcript: string | undefined,
): string | undefined {
  const trimmed = transcript?.trim();
  if (!trimmed) return undefined;
  const full = buildYoutubeMarkdown({ ...parts, transcript: trimmed });
  if (Buffer.byteLength(full, "utf8") <= MARKDOWN_MESSAGE_BUDGET) return trimmed;

  const withoutTranscript = buildYoutubeMarkdown({ ...parts, transcript: undefined });
  const overhead =
    Buffer.byteLength(withoutTranscript, "utf8") +
    Buffer.byteLength("\n\n## Transcript\n\n", "utf8") +
    Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  const budget = MARKDOWN_MESSAGE_BUDGET - overhead;
  return truncateUtf8(trimmed, budget) + TRUNCATION_NOTICE;
}

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

  const parts: YoutubeMarkdownParts = {
    title: oembed.title,
    authorName: oembed.authorName,
    authorUrl: oembed.authorUrl,
    watchUrl,
    description: player?.shortDescription,
  };

  const markdown = buildYoutubeMarkdown({
    ...parts,
    transcript: capTranscript(parts, inputs.transcript),
  });

  return { source_url: watchUrl, markdown, title: oembed.title };
}
