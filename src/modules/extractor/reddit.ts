import { z } from "zod";
import { sourceDateFromPublishedTime } from "./source-date";

// Match any reddit.com web subdomain (www, old, np, m, i, sh, new, amp, ...)
// plus the redd.it shortlink host. Reddit keeps adding share/desktop hosts
// (sh.reddit.com, new.reddit.com), so an exact allow-list silently drops
// pasted thread URLs into the generic HTML path instead of the JSON path.
function isRedditHost(host: string): boolean {
  return host === "reddit.com" || host.endsWith(".reddit.com");
}

export function isRedditThreadUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host === "redd.it") return /^\/[a-z0-9]+\/?$/i.test(u.pathname);
  if (!isRedditHost(host)) return false;
  // `/comments/<id>` and `/comment/<id>` are direct thread/comment permalinks;
  // `/s/<token>` is the app share-button redirect (e.g. /r/<sub>/s/<token>),
  // which has no /comments/ segment but resolves to a thread — include it so it
  // routes to RedditManualImportError instead of the generic fetch path.
  return (
    /\/comments\/[a-z0-9]+/i.test(u.pathname) ||
    /\/comment\/[a-z0-9]+/i.test(u.pathname) ||
    /\/s\/[a-z0-9]+/i.test(u.pathname)
  );
}

const Post = z
  .object({
    title: z.string(),
    selftext: z.string().default(""),
    author: z.string().optional(),
    subreddit_name_prefixed: z.string().optional(),
    url: z.string().optional(),
    is_self: z.boolean().optional(),
    permalink: z.string().optional(),
    score: z.number().optional(),
    num_comments: z.number().optional(),
    // Seconds since epoch on the t3 post. Unknown so a string/null cannot fail
    // the extract — missing or implausible values omit source_date instead.
    created_utc: z.unknown().optional(),
  })
  .passthrough();

const Comment = z
  .object({
    body: z.string().optional(),
    author: z.string().optional(),
    score: z.number().optional(),
  })
  .passthrough();

const Listing = z
  .object({
    data: z
      .object({
        children: z.array(
          z
            .object({
              kind: z.string(),
              data: z.unknown(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const RedditThread = z.array(Listing);

export interface RedditMarkdown {
  markdown: string;
  title: string;
  source_date?: string;
}

export function redditListingToMarkdown(
  jsonText: string,
  opts?: { maxComments?: number; nowMs?: number },
): RedditMarkdown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const res = RedditThread.safeParse(parsed);
  if (!res.success || res.data.length === 0) return null;

  const postChild = res.data[0]?.data.children.find((c) => c.kind === "t3");
  if (!postChild) return null;
  const post = Post.safeParse(postChild.data);
  if (!post.success) return null;
  const p = post.data;

  const parts: string[] = [`# ${p.title}`];
  const meta = [p.author && `Posted by u/${p.author}`, p.subreddit_name_prefixed]
    .filter(Boolean)
    .join(" in ");
  if (meta) parts.push(`*${meta}*`);
  if (p.selftext.trim()) {
    parts.push(p.selftext.trim());
  } else if (p.is_self === false && p.url) {
    parts.push(`Link: ${p.url}`);
  }

  const maxComments = opts?.maxComments ?? 10;
  const commentsListing = res.data[1];
  if (commentsListing) {
    const comments = commentsListing.data.children
      .filter((c) => c.kind === "t1")
      .map((c) => Comment.safeParse(c.data))
      .filter((r): r is z.ZodSafeParseSuccess<z.infer<typeof Comment>> => r.success)
      .map((r) => r.data)
      .filter((c) => c.body && c.body.trim() && c.body !== "[deleted]" && c.body !== "[removed]")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, maxComments);

    if (comments.length) {
      parts.push("## Top comments");
      for (const c of comments) {
        const who = c.author ? `**u/${c.author}**` : "**comment**";
        const score = c.score != null ? ` (${c.score} pts)` : "";
        parts.push(`${who}${score}: ${c.body!.trim()}`);
      }
    }
  }

  const markdown = parts.join("\n\n").trim();
  if (!markdown) return null;
  // Same drop rules as HTML/X/YouTube. created_utc is seconds since epoch on
  // the t3 post; missing or implausible omits the field rather than failing.
  const source_date = sourceDateFromCreatedUtc(p.created_utc, opts?.nowMs ?? Date.now());
  return {
    markdown,
    title: p.title,
    ...(source_date === undefined ? {} : { source_date }),
  };
}

function sourceDateFromCreatedUtc(createdUtc: unknown, nowMs: number): string | undefined {
  if (typeof createdUtc !== "number" || !Number.isFinite(createdUtc) || createdUtc <= 0) {
    return undefined;
  }
  try {
    return sourceDateFromPublishedTime(new Date(createdUtc * 1000).toISOString(), nowMs);
  } catch {
    return undefined;
  }
}
