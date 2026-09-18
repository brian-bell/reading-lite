// YouTube watch pages are JS shells with no server-rendered article body, so the
// generic Readability path returns nothing. Instead we build summarizable
// markdown from YouTube's public oEmbed endpoint (title + author — the reliable
// floor) plus best-effort enrichment scraped from the watch page
// (`ytInitialPlayerResponse`: description + caption tracks, and
// `datePublished` / `uploadDate` in meta or JSON-LD) and the timedtext
// transcript. See plan 010 / issue #17.

import { z } from "zod";

const YOUTUBE_HOSTS = new Set(["youtube.com", "youtube-nocookie.com"]);
const ID_SEGMENTS = new Set(["shorts", "live", "embed"]);

function isYoutubeHost(host: string): boolean {
  if (host === "youtu.be") return true;
  for (const root of YOUTUBE_HOSTS) {
    if (host === root || host.endsWith(`.${root}`)) return true;
  }
  return false;
}

// 11-char video ids are `[A-Za-z0-9_-]{11}`. We don't pin to exactly 11 (a
// future id-length change shouldn't silently drop URLs), but bound the range so
// obvious junk (a 200-char shorts slug) is rejected before we mint an oEmbed URL.
function sanitizeId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const id = raw.trim();
  return /^[A-Za-z0-9_-]{6,24}$/.test(id) ? id : null;
}

export function parseVideoId(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!isYoutubeHost(host)) return null;

  if (host === "youtu.be") {
    return sanitizeId(u.pathname.split("/").filter(Boolean)[0]);
  }

  if (u.pathname === "/watch") {
    return sanitizeId(u.searchParams.get("v"));
  }

  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && ID_SEGMENTS.has(segments[0]!.toLowerCase())) {
    return sanitizeId(segments[1]);
  }

  return null;
}

export function isYoutubeWatchUrl(rawUrl: string): boolean {
  return parseVideoId(rawUrl) !== null;
}

// Normalize every accepted form (youtu.be, shorts, embed, m.youtube …) to the
// canonical desktop watch URL so the oEmbed lookup and the stored source link
// are stable regardless of how the URL was pasted.
export function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Every canonical-ish URL form a video may have been stored under. by-url
// ownership hashes the exact submitted URL, so a reading saved as youtu.be /
// shorts / live / embed is invisible to a lookup on the canonical watch URL.
// youtube-import uses this to find a pre-existing thin reading under a variant
// before importing canonically (so the operator can drop the duplicate).
export function youtubeWatchUrlVariants(videoId: string): string[] {
  return [
    canonicalWatchUrl(videoId),
    `https://youtube.com/watch?v=${videoId}`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://youtu.be/${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
    `https://www.youtube.com/embed/${videoId}`,
  ];
}

export function oembedUrl(videoId: string): string {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(
    canonicalWatchUrl(videoId),
  )}&format=json`;
}

// Caption track baseUrls already carry their own query string; request the json3
// format which is far easier to parse than the legacy XML.
export function timedtextJson3Url(baseUrl: string): string {
  return baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
}

// Best-effort transcript fetches follow a baseUrl that came from page JSON; keep
// the fetch on YouTube hosts so a tampered player response can't point egress
// at an arbitrary origin. Redirects from that host are still revalidated by
// safeFetch (private/DNS/scheme) before the next hop connects.
export function isYoutubeFetchableHost(rawUrl: string): boolean {
  try {
    return isYoutubeHost(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

export interface PlayerResponse {
  shortDescription?: string;
  captionTracks: CaptionTrack[];
}

const PlayerResponseSchema = z
  .object({
    videoDetails: z.object({ shortDescription: z.string().optional() }).partial().optional(),
    captions: z
      .object({
        playerCaptionsTracklistRenderer: z
          .object({
            captionTracks: z
              .array(
                z
                  .object({
                    baseUrl: z.string(),
                    languageCode: z.string().optional(),
                    kind: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Anchor on the ASSIGNMENT (`ytInitialPlayerResponse = {`), not a bare mention:
// real watch HTML references the string `"ytInitialPlayerResponse"` inside
// earlier config blobs, and a substring match would slice that wrong object —
// which still parses, leaving us silently on the title-only floor.
const PLAYER_RESPONSE_ASSIGNMENT = /ytInitialPlayerResponse\s*=\s*\{/g;

// Brace-match a JSON object literal starting at `start` (the opening `{`),
// skipping over string contents (and their escapes) where stray braces/quotes
// are data, not structure. A greedy regex would over-match into a trailing
// `;var meta = {...}`.
function sliceBalancedObject(html: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

export function parsePlayerResponse(html: string): PlayerResponse | null {
  // Try each `ytInitialPlayerResponse = {` assignment in order; a page may carry
  // a decoy/empty one, so accept the first that parses and carries real video
  // fields, falling back to the first that parses at all.
  let fallback: PlayerResponse | null = null;
  for (const match of html.matchAll(PLAYER_RESPONSE_ASSIGNMENT)) {
    const braceStart = match.index! + match[0].length - 1;
    const json = sliceBalancedObject(html, braceStart);
    if (!json) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      continue;
    }
    const parsed = PlayerResponseSchema.safeParse(raw);
    if (!parsed.success) continue;

    const shortDescription = parsed.data.videoDetails?.shortDescription?.trim() || undefined;
    const captionTracks =
      parsed.data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const result = { shortDescription, captionTracks };
    // Accept the first assignment that carries substantive content; an empty
    // `videoDetails:{}` decoy doesn't count. A real video with neither a
    // description nor captions still lands via the parse-only fallback (there's
    // only one such assignment on a genuine page).
    if (shortDescription !== undefined || captionTracks.length > 0) return result;
    fallback ??= result;
  }
  return fallback;
}

export interface Oembed {
  title: string;
  authorName?: string;
  authorUrl?: string;
}

const OembedSchema = z
  .object({
    title: z.string().min(1),
    author_name: z.string().optional(),
    author_url: z.string().optional(),
  })
  .passthrough();

export function parseOembed(jsonText: string): Oembed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const parsed = OembedSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    title: parsed.data.title,
    authorName: parsed.data.author_name,
    authorUrl: parsed.data.author_url,
  };
}

export interface YoutubeMarkdownParts {
  title: string;
  authorName?: string;
  authorUrl?: string;
  watchUrl: string;
  description?: string;
  transcript?: string;
}

export function buildYoutubeMarkdown(parts: YoutubeMarkdownParts): string {
  const author = parts.authorName?.trim();
  const authorMd = author
    ? parts.authorUrl
      ? `[${author}](${parts.authorUrl})`
      : author
    : undefined;
  const byline = [authorMd ? `By ${authorMd}` : undefined, `[Watch on YouTube](${parts.watchUrl})`]
    .filter(Boolean)
    .join(" · ");

  const sections: string[] = [`# ${parts.title.trim()}`, `*${byline}*`];

  const description = parts.description?.trim();
  if (description) sections.push(description);

  const transcript = parts.transcript?.trim();
  if (transcript) sections.push("## Transcript", transcript);

  return sections.join("\n\n").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Caption tracks come back either as fmt=json3 (`{ events: [{ segs: [{ utf8 }] }] }`)
// or the legacy XML transcript (`<text start=… dur=…>…</text>`). Parse either to
// flat, whitespace-collapsed plain text. Best-effort: returns "" on anything it
// can't read.
export function timedtextToText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { events?: { segs?: { utf8?: string }[] }[] };
      // json3 `segs` are sub-word fragments of a single caption line (their own
      // spacing is in the utf8), so join with "" — a separator would inject
      // spaces mid-word. (XML `<text>` nodes below are whole lines → join " ".)
      const text = (parsed.events ?? [])
        .flatMap((e) => e.segs ?? [])
        .map((seg) => seg.utf8 ?? "")
        .join("");
      return collapse(text);
    } catch {
      return "";
    }
  }

  if (/<text\b/i.test(trimmed)) {
    // Legacy XML: each `<text>` is a full caption line → join with a space.
    const segments = [...trimmed.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((m) =>
      decodeEntities(m[1]!),
    );
    return collapse(segments.join(" "));
  }

  return "";
}

function parseHtmlTagAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = tag.replace(/^<\/?[a-zA-Z][\w:-]*/i, "").replace(/\/?>$/, "");
  const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of body.matchAll(attrRe)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function metaPublishedTimes(html: string): string[] {
  const datePublished: string[] = [];
  const uploadDate: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseHtmlTagAttrs(match[0]!);
    const key = (attrs.itemprop ?? attrs.property ?? attrs.name ?? "").trim().toLowerCase();
    const content = attrs.content?.trim();
    if (!content) continue;
    if (key === "datepublished") datePublished.push(content);
    else if (key === "uploaddate") uploadDate.push(content);
  }
  return [...datePublished, ...uploadDate];
}

function collectJsonLdPublishedTimes(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdPublishedTimes(item, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const key of ["datePublished", "uploadDate"] as const) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.trim()) out.push(candidate.trim());
  }
  for (const nested of Object.values(obj)) {
    if (nested && typeof nested === "object") collectJsonLdPublishedTimes(nested, out, depth + 1);
  }
}

function jsonLdPublishedTimes(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const openTag = match[0]!;
    if (!/\btype\s*=\s*(["']?)application\/ld\+json\b/i.test(openTag)) continue;
    const start = match.index! + openTag.length;
    const rest = html.slice(start);
    const close = rest.search(/<\/script>/i);
    if (close < 0) continue;
    const body = rest.slice(0, close).trim();
    if (!body) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      continue;
    }
    collectJsonLdPublishedTimes(raw, out);
  }
  return out;
}

// Best-effort watch-page scrape: `datePublished` / `uploadDate` from meta tags
// (itemprop, property, or name) then JSON-LD. oEmbed has no upload date, so
// this is the only hosted source. Callers run each candidate through
// sourceDateFromPublishedTime and omit the field when none survive.
export function parseWatchPagePublishedTimes(html: string): string[] {
  return [...metaPublishedTimes(html), ...jsonLdPublishedTimes(html)];
}
