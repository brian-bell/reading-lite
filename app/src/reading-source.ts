import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf, type Reading } from "./reading";
import { hostnameOf } from "./reading-presentation";

// The Source view's data (#372; design spec, Source content): the extracted
// Markdown from GET /api/readings/:id/content, fetched in the browser only
// when the view is selected. It is never read during a server render, so SSR
// payloads stay bounded and a captured page's size never delays the reading.
//
// The endpoint answers 200 with text/markdown, or 404 when the reading has no
// extracted.md — `content_status` is not "captured" or the object is missing
// (src/router.ts). Those are values here, like the reading's own states, and
// so are the 403 and the 412 expected-tenant mismatch, which mean what they
// mean for the reading itself (readingFromResponse) and which no Retry can
// change. A 401 throws into the shell's expired-session page and anything
// else is the retryable failure shown inside the view.

export type SourceResult =
  | { state: "ready"; markdown: string }
  | { state: "unavailable" }
  | { state: "forbidden" }
  | { state: "account-changed"; acting_tenant?: string };

export function sourceQueryKey(id: string): readonly unknown[] {
  return ["reading-source", id];
}

export function sourceFromResponse(status: number, body: string): SourceResult {
  if (status === 200) return { state: "ready", markdown: body };
  if (status === 404) return { state: "unavailable" };
  const envelope = parseJson(body);
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(envelope) };
  throw new ApiError(status, messageOf(envelope) ?? `source returned ${status}`);
}

/**
 * Acceptance matrix, Source unavailable: "`content_status` not `captured`, or
 * `/content` 404". When the manifest already says the source was not
 * captured, the view says so without a request. An old manifest with no
 * `content_status` asks, and the 404 decides.
 */
export function sourceKnownUnavailable(reading: Reading): boolean {
  return reading.content_status !== undefined && reading.content_status !== "captured";
}

/**
 * What a source image renders as before anyone asks for it (design spec,
 * Source content): its alt text and host, and a "Load image" button only for
 * an `https:` URL. The spec allows `http(s):`, but the page's content-security
 * policy admits remote images over `https:` alone, so an `http:` image would
 * only ever be a blocked request; it keeps its placeholder. A relative URL
 * has no host the reader could recognise and nothing to load.
 */
export interface ImagePlaceholder {
  host?: string;
  loadable: boolean;
}

export function imagePlaceholder(src: string | undefined): ImagePlaceholder {
  if (!src) return { loadable: false };
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return { loadable: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { loadable: false };
  return { host: hostnameOf(url.href), loadable: url.protocol === "https:" };
}

/**
 * Source headings sit one level below the reading title, which is the page's
 * only h1 (design spec, Source content: "Demote source headings one level").
 */
export type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export function demotedHeading(tag: HeadingTag): Exclude<HeadingTag, "h1"> {
  switch (tag) {
    case "h1":
      return "h2";
    case "h2":
      return "h3";
    case "h3":
      return "h4";
    case "h4":
      return "h5";
    default:
      return "h6";
  }
}

/** The error envelope, when the body is one; the reading's helpers read it. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
