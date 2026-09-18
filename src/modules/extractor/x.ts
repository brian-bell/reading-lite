import { z } from "zod";
import {
  fetchWithRetry,
  parseRateLimitDelayMs,
  RateLimitedError,
  type RetryDeps,
} from "../http-retry";
import type { ExtractedContent } from "./index";
import {
  FetchTimeoutError,
  OversizedResponseError,
  XApiConfigError,
  XApiError,
  XThreadIncompleteError,
  XThreadOutsideRecentWindowError,
} from "./errors";
import { readBoundedBody, sha256Bytes } from "./response-bytes";
import { sourceDateFromPublishedTime } from "./source-date";

const X_WEB_HOSTS = /^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/;
const X_API_BASE = "https://api.x.com/2";
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const TWEET_FIELDS =
  "author_id,conversation_id,created_at,referenced_tweets,entities,note_tweet,article,attachments";
const EXPANSIONS =
  "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys";
const USER_FIELDS = "id,name,username";
const MEDIA_FIELDS = "media_key,type,url,preview_image_url,alt_text";

const UrlEntitySchema = z
  .object({
    url: z.string(),
    expanded_url: z.string().optional(),
    display_url: z.string().optional(),
  })
  .passthrough();
const EntitiesSchema = z.object({ urls: z.array(UrlEntitySchema).optional() }).passthrough();
const ReferenceSchema = z
  .object({
    type: z.enum(["replied_to", "quoted", "retweeted"]),
    id: z.string(),
  })
  .passthrough();
const XPostSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    author_id: z.string(),
    conversation_id: z.string(),
    created_at: z.string(),
    referenced_tweets: z.array(ReferenceSchema).optional(),
    entities: EntitiesSchema.optional(),
    note_tweet: z
      .object({
        text: z.string(),
        entities: EntitiesSchema.optional(),
      })
      .passthrough()
      .optional(),
    article: z
      .object({
        title: z.string().optional(),
        text: z.string().optional(),
        plain_text: z.string().optional(),
        preview_text: z.string().optional(),
      })
      .passthrough()
      .optional(),
    attachments: z
      .object({ media_keys: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const XUserSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    username: z.string(),
  })
  .passthrough();
const XMediaSchema = z
  .object({
    media_key: z.string(),
    type: z.string(),
    url: z.string().optional(),
    preview_image_url: z.string().optional(),
    alt_text: z.string().optional(),
  })
  .passthrough();
const IncludesSchema = z
  .object({
    users: z.array(XUserSchema).optional(),
    tweets: z.array(XPostSchema).optional(),
    media: z.array(XMediaSchema).optional(),
  })
  .passthrough();
const XPartialErrorSchema = z
  .object({
    value: z.union([z.string(), z.array(z.string())]).optional(),
    resource_id: z.union([z.string(), z.array(z.string())]).optional(),
    parameter: z.string().optional(),
  })
  .passthrough();
const LookupSchema = z
  .object({
    data: XPostSchema,
    includes: IncludesSchema.optional(),
    errors: z.array(XPartialErrorSchema).optional(),
  })
  .passthrough();
const SearchSchema = z
  .object({
    data: z.array(XPostSchema).optional().default([]),
    includes: IncludesSchema.optional(),
    meta: z.object({ next_token: z.string().optional() }).passthrough().optional(),
    errors: z.array(XPartialErrorSchema).optional(),
  })
  .passthrough();

type XPost = z.infer<typeof XPostSchema>;
type XUser = z.infer<typeof XUserSchema>;
type XMedia = z.infer<typeof XMediaSchema>;
type XIncludes = z.infer<typeof IncludesSchema>;

export interface XExtractorDeps {
  fetch: typeof fetch;
  bearerToken?: string;
  timeoutMs: number;
  maxBytes: number;
  retry?: RetryDeps;
  now: () => number;
}

export function parseXPostId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!X_WEB_HOSTS.test(host)) return null;

  const match = url.pathname.match(
    /^\/(?:i\/web|[^/]+)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/,
  );
  return match?.[1] ?? null;
}

export function isXPostUrl(rawUrl: string): boolean {
  return parseXPostId(rawUrl) !== null;
}

export function canonicalXPostUrl(username: string, id: string): string {
  return `https://x.com/${encodeURIComponent(username)}/status/${id}`;
}

export async function extractXThread(
  rawUrl: string,
  deps: XExtractorDeps,
): Promise<ExtractedContent> {
  const sourcePostId = parseXPostId(rawUrl);
  if (!sourcePostId) {
    throw new XThreadIncompleteError("the shared URL is not an X post permalink");
  }
  if (!deps.bearerToken?.trim()) throw new XApiConfigError();

  const budget = { remaining: deps.maxBytes };
  const sharedUrl = lookupUrl(sourcePostId);
  const sharedPayload = parseXPayload(
    LookupSchema,
    await requestXJson(sharedUrl, deps, budget),
    endpointName(sharedUrl),
  );
  const shared = sharedPayload.data;
  assertNoFatalPartialErrors(sharedPayload);
  const conversationId = shared.conversation_id;

  let rootPayload: z.infer<typeof LookupSchema> | undefined;
  let root = shared;
  if (conversationId !== shared.id) {
    const rootUrl = lookupUrl(conversationId);
    rootPayload = parseXPayload(
      LookupSchema,
      await requestXJson(rootUrl, deps, budget),
      endpointName(rootUrl),
    );
    root = rootPayload.data;
    assertNoFatalPartialErrors(rootPayload);
  }
  const rootCreatedAt = Date.parse(root.created_at);
  if (!Number.isFinite(rootCreatedAt)) {
    throw new XThreadIncompleteError("the conversation root has an invalid creation time");
  }
  if (rootCreatedAt < deps.now() - RECENT_WINDOW_MS) {
    throw new XThreadOutsideRecentWindowError();
  }

  const users = new Map<string, XUser>();
  const referencedPosts = new Map<string, XPost>();
  const media = new Map<string, XMedia>();
  collectIncludes(sharedPayload.includes, users, referencedPosts, media);
  collectIncludes(rootPayload?.includes, users, referencedPosts, media);
  const author = users.get(shared.author_id);
  if (!author) throw new XThreadIncompleteError("the shared post author was not returned");

  const pages: unknown[] = [];
  const primaryPosts: XPost[] = [shared];
  if (root.author_id === shared.author_id) primaryPosts.push(root);
  let paginationToken: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const url = searchUrl(conversationId, author.username, paginationToken);
    const rawPage = await requestXJson(url, deps, budget);
    const page = parseXPayload(SearchSchema, rawPage, endpointName(url));
    assertNoFatalPartialErrors(page);
    pages.push(rawPage);
    primaryPosts.push(...page.data);
    collectIncludes(page.includes, users, referencedPosts, media);
    paginationToken = page.meta?.next_token;
    if (paginationToken) {
      if (seenTokens.has(paginationToken)) {
        throw new XThreadIncompleteError("X returned a repeated pagination token");
      }
      seenTokens.add(paginationToken);
    }
  } while (paginationToken);

  const ordered = authorComponent(
    shared.id,
    shared.author_id,
    conversationId,
    primaryPosts,
    referencedPosts,
  );
  const title =
    ordered.length === 1
      ? `X post by ${author.name} (@${author.username})`
      : `X thread by ${author.name} (@${author.username})`;
  const markdown = renderMarkdown(title, ordered, author, referencedPosts, users, media);
  const aggregate = {
    schema_version: 1,
    source_post_id: sourcePostId,
    conversation_id: conversationId,
    author,
    lookup: sharedPayload,
    root: rootPayload,
    search_pages: pages,
  };
  const raw = new TextEncoder().encode(JSON.stringify(aggregate));
  if (raw.byteLength > deps.maxBytes) {
    throw new OversizedResponseError(endpointName(sharedUrl), deps.maxBytes);
  }
  const source_date = sourceDateFromPublishedTime(ordered[0]!.created_at, deps.now());
  return {
    raw,
    content_type: "application/json; charset=utf-8",
    content_status: "captured",
    content_bytes: raw.byteLength,
    content_sha256: await sha256Bytes(raw),
    markdown,
    title,
    ...(source_date === undefined ? {} : { source_date }),
  };
}

function parseXPayload<Schema extends z.ZodTypeAny>(
  schema: Schema,
  payload: unknown,
  endpoint: string,
): z.output<Schema> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new XThreadIncompleteError(`X returned an invalid response for ${endpoint}`);
  }
  return parsed.data;
}

const NON_FATAL_EXPANSION_PARAMETERS = new Set([
  "referenced_tweets.id.author_id",
  "attachments.media_keys",
]);

function errorResourceIds(error: {
  value?: string | string[];
  resource_id?: string | string[];
}): string[] {
  const raw = error.value ?? error.resource_id;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return typeof raw === "string" && raw.length > 0 ? [raw] : [];
}

function assertNoFatalPartialErrors(payload: {
  data: XPost | XPost[];
  includes?: XIncludes;
  errors?: Array<{
    value?: string | string[];
    resource_id?: string | string[];
    parameter?: string;
  }>;
}): void {
  if (!payload.errors || payload.errors.length === 0) return;
  const posts = Array.isArray(payload.data) ? payload.data : [payload.data];
  const quoteIds = new Set(
    posts.flatMap((post) =>
      (post.referenced_tweets ?? [])
        .filter((reference) => reference.type === "quoted")
        .map((reference) => reference.id),
    ),
  );
  const quotedAuthorIds = new Set(
    (payload.includes?.tweets ?? [])
      .filter((tweet) => quoteIds.has(tweet.id))
      .map((tweet) => tweet.author_id),
  );
  const mediaKeys = new Set(posts.flatMap((post) => post.attachments?.media_keys ?? []));
  const ignorable = new Set<string>([...quoteIds, ...quotedAuthorIds, ...mediaKeys]);
  const nonFatal = payload.errors.every((error) => {
    if (error.parameter && NON_FATAL_EXPANSION_PARAMETERS.has(error.parameter)) return true;
    const ids = errorResourceIds(error);
    return ids.length > 0 && ids.every((id) => ignorable.has(id));
  });
  if (!nonFatal) throw new XThreadIncompleteError("X returned a partial API response");
}

function lookupUrl(id: string): URL {
  const url = new URL(`${X_API_BASE}/tweets/${id}`);
  addFields(url);
  return url;
}

function searchUrl(
  conversationId: string,
  username: string,
  paginationToken?: string,
): URL {
  const url = new URL(`${X_API_BASE}/tweets/search/recent`);
  url.searchParams.set("query", `conversation_id:${conversationId} from:${username} -is:retweet`);
  url.searchParams.set("max_results", "100");
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
  addFields(url);
  return url;
}

function addFields(url: URL): void {
  url.searchParams.set("tweet.fields", TWEET_FIELDS);
  url.searchParams.set("expansions", EXPANSIONS);
  url.searchParams.set("user.fields", USER_FIELDS);
  url.searchParams.set("media.fields", MEDIA_FIELDS);
}

async function requestXJson(
  url: URL,
  deps: XExtractorDeps,
  budget: { remaining: number },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const init: RequestInit = {
      headers: { Authorization: `Bearer ${deps.bearerToken!.trim()}` },
      signal: controller.signal,
    };
    const response = deps.retry
      ? await fetchWithRetry(deps.fetch, url, init, deps.retry)
      : await deps.fetch(url, init);
    if (response.status === 429) {
      const delay = parseRateLimitDelayMs(response.headers, deps.now);
      response.body?.cancel().catch(() => {});
      throw new RateLimitedError(429, delay, endpointName(url));
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw new XApiError(endpointName(url), response.status);
    }
    const raw = await readBoundedBody(response, budget.remaining, endpointName(url));
    budget.remaining -= raw.byteLength;
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new XThreadIncompleteError(`X returned invalid JSON for ${endpointName(url)}`);
    }
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new FetchTimeoutError(endpointName(url), deps.timeoutMs);
    }
    if (error instanceof z.ZodError) {
      throw new XThreadIncompleteError(`X returned an invalid response for ${endpointName(url)}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function endpointName(url: URL): string {
  return url.pathname;
}

function collectIncludes(
  includes: XIncludes | undefined,
  users: Map<string, XUser>,
  tweets: Map<string, XPost>,
  media: Map<string, XMedia>,
): void {
  for (const user of includes?.users ?? []) users.set(user.id, user);
  for (const tweet of includes?.tweets ?? []) {
    const existing = tweets.get(tweet.id);
    if (existing && postsConflict(existing, tweet)) {
      throw new XThreadIncompleteError(`X returned conflicting data for post ${tweet.id}`);
    }
    tweets.set(tweet.id, existing ? mergePosts(existing, tweet) : tweet);
  }
  for (const item of includes?.media ?? []) {
    const existing = media.get(item.media_key);
    media.set(item.media_key, existing ? richerMedia(existing, item) : item);
  }
}

function authorComponent(
  sharedId: string,
  authorId: string,
  conversationId: string,
  posts: XPost[],
  referencedPosts: Map<string, XPost>,
): XPost[] {
  const byId = new Map<string, XPost>();
  for (const post of posts) {
    if (post.author_id !== authorId || post.conversation_id !== conversationId) continue;
    if (!Number.isFinite(Date.parse(post.created_at))) {
      throw new XThreadIncompleteError(`post ${post.id} has an invalid creation time`);
    }
    const existing = byId.get(post.id);
    if (existing && postsConflict(existing, post)) {
      throw new XThreadIncompleteError(`X returned conflicting data for post ${post.id}`);
    }
    byId.set(post.id, existing ? mergePosts(existing, post) : post);
  }
  if (!byId.has(sharedId)) throw new XThreadIncompleteError("the shared post was missing");

  const neighbors = new Map<string, Set<string>>();
  const parentById = new Map<string, string>();
  for (const id of byId.keys()) neighbors.set(id, new Set());
  for (const post of byId.values()) {
    const parent = post.referenced_tweets?.find(
      (reference) => reference.type === "replied_to",
    )?.id;
    if (!parent || !byId.has(parent)) continue;
    parentById.set(post.id, parent);
    neighbors.get(post.id)!.add(parent);
    neighbors.get(parent)!.add(post.id);
  }

  const component = new Set<string>([sharedId]);
  const queue = [sharedId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of neighbors.get(current) ?? []) {
      if (component.has(neighbor)) continue;
      component.add(neighbor);
      queue.push(neighbor);
    }
  }

  for (const id of component) {
    const parentId = referenceId(byId.get(id)!, "replied_to");
    if (!parentId || component.has(parentId)) continue;
    const expandedParent = referencedPosts.get(parentId);
    if (
      expandedParent?.author_id === authorId &&
      expandedParent.conversation_id === conversationId
    ) {
      throw new XThreadIncompleteError(`same-author parent ${parentId} was missing`);
    }
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of component) {
    indegree.set(id, 0);
    children.set(id, []);
  }
  for (const [child, parent] of parentById) {
    if (!component.has(child) || !component.has(parent)) continue;
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
    children.get(parent)!.push(child);
  }

  const ready = [...component].filter((id) => indegree.get(id) === 0);
  const result: XPost[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => comparePosts(byId.get(a)!, byId.get(b)!));
    const id = ready.shift()!;
    result.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  if (result.length !== component.size) {
    throw new XThreadIncompleteError("the author reply graph contains a cycle");
  }
  return result;
}

function referenceId(post: XPost, type: "replied_to" | "quoted"): string | undefined {
  return post.referenced_tweets?.find((reference) => reference.type === type)?.id;
}

function attachmentMediaKeys(post: XPost): readonly string[] {
  return post.attachments?.media_keys ?? [];
}

function postsConflict(a: XPost, b: XPost): boolean {
  if (
    a.author_id !== b.author_id ||
    a.conversation_id !== b.conversation_id ||
    a.created_at !== b.created_at ||
    a.text !== b.text ||
    referenceId(a, "replied_to") !== referenceId(b, "replied_to") ||
    referenceId(a, "quoted") !== referenceId(b, "quoted")
  ) {
    return true;
  }
  const aKeys = attachmentMediaKeys(a);
  const bKeys = attachmentMediaKeys(b);
  return aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index]);
}

type XNoteTweet = NonNullable<XPost["note_tweet"]>;
type XArticle = NonNullable<XPost["article"]>;
type XEntities = z.infer<typeof EntitiesSchema>;
type XUrlEntity = z.infer<typeof UrlEntitySchema>;

function mergePosts(existing: XPost, incoming: XPost): XPost {
  const merged: XPost = { ...existing, ...incoming };
  const note_tweet = richerNoteTweet(existing.note_tweet, incoming.note_tweet);
  const article = richerArticle(existing.article, incoming.article);
  const entities = richerEntities(existing.entities, incoming.entities);
  if (note_tweet) merged.note_tweet = note_tweet;
  else delete merged.note_tweet;
  if (article) merged.article = article;
  else delete merged.article;
  if (entities) merged.entities = entities;
  else delete merged.entities;
  return merged;
}

function richerNoteTweet(
  existing: XNoteTweet | undefined,
  incoming: XNoteTweet | undefined,
): XNoteTweet | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const base = existing.text.length >= incoming.text.length ? existing : incoming;
  const entities = richerEntities(existing.entities, incoming.entities);
  return {
    ...base,
    text: base.text,
    ...(entities ? { entities } : {}),
  };
}

function articleRank(article: XArticle | undefined): number {
  if (!article) return 0;
  let rank = 1;
  if (article.title) rank += 1;
  if (article.text) rank += 8;
  else if (article.plain_text) rank += 4;
  else if (article.preview_text) rank += 2;
  return rank;
}

function richerArticle(
  existing: XArticle | undefined,
  incoming: XArticle | undefined,
): XArticle | undefined {
  return articleRank(existing) >= articleRank(incoming) ? existing : incoming;
}

function richerEntities(
  existing: XEntities | undefined,
  incoming: XEntities | undefined,
): XEntities | undefined {
  const urls = mergeUrlEntities(existing?.urls, incoming?.urls);
  if (!urls) return existing ?? incoming;
  const base =
    (existing?.urls?.length ?? 0) >= (incoming?.urls?.length ?? 0) ? existing : incoming;
  return { ...base, urls };
}

function mergeUrlEntities(
  existing: XUrlEntity[] | undefined,
  incoming: XUrlEntity[] | undefined,
): XUrlEntity[] | undefined {
  if (!existing?.length && !incoming?.length) return undefined;
  const byUrl = new Map<string, XUrlEntity>();
  for (const entity of [...(existing ?? []), ...(incoming ?? [])]) {
    const prev = byUrl.get(entity.url);
    if (!prev || (!prev.expanded_url && entity.expanded_url)) {
      byUrl.set(entity.url, entity);
    }
  }
  return [...byUrl.values()];
}

function richerMedia(existing: XMedia, incoming: XMedia): XMedia {
  const existingRank = (existing.url ? 2 : 0) + (existing.preview_image_url ? 1 : 0);
  const incomingRank = (incoming.url ? 2 : 0) + (incoming.preview_image_url ? 1 : 0);
  return existingRank >= incomingRank ? existing : incoming;
}

function comparePosts(a: XPost, b: XPost): number {
  const time = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (time !== 0) return time;
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id.localeCompare(b.id);
}

function renderMarkdown(
  title: string,
  posts: XPost[],
  author: XUser,
  referencedPosts: Map<string, XPost>,
  users: Map<string, XUser>,
  media: Map<string, XMedia>,
): string {
  const sections = posts.map((post, index) => {
    const body = expandUrls(postText(post), post.note_tweet?.entities ?? post.entities);
    const lines = [
      `## ${index + 1}. @${author.username}`,
      "",
      `[${post.created_at}](${canonicalXPostUrl(author.username, post.id)})`,
      "",
      body,
    ];
    const quotedId = post.referenced_tweets?.find(
      (reference) => reference.type === "quoted",
    )?.id;
    if (quotedId) {
      lines.push("", "### Quoted post", "");
      const quoted = referencedPosts.get(quotedId);
      const quotedAuthor = quoted ? users.get(quoted.author_id) : undefined;
      if (quoted && quotedAuthor) {
        lines.push(
          `> **${quotedAuthor.name} (@${quotedAuthor.username})**`,
          ">",
          ...expandUrls(postText(quoted), quoted.note_tweet?.entities ?? quoted.entities)
            .split("\n")
            .map((line) => `> ${line}`),
          ">",
          `> [View quoted post](${canonicalXPostUrl(quotedAuthor.username, quoted.id)})`,
        );
      } else {
        lines.push(`Quoted post unavailable: https://x.com/i/status/${quotedId}`);
      }
    }
    const mediaLines = (post.attachments?.media_keys ?? [])
      .map((key) => media.get(key))
      .filter((item): item is XMedia => item !== undefined)
      .map((item) => {
        const link = item.url ?? item.preview_image_url;
        if (!link) return item.alt_text ? `Media: ${item.alt_text}` : `Media: ${item.type}`;
        return `![${item.alt_text ?? item.type}](${link})`;
      });
    if (mediaLines.length > 0) lines.push("", ...mediaLines);
    return lines.join("\n");
  });
  return [`# ${title}`, "", ...sections].join("\n\n").trim();
}

function postText(post: XPost): string {
  const articleText =
    post.article?.text ?? post.article?.plain_text ?? post.article?.preview_text;
  if (articleText) {
    return post.article?.title ? `## ${post.article.title}\n\n${articleText}` : articleText;
  }
  return post.note_tweet?.text ?? post.text;
}

function expandUrls(text: string, entities: z.infer<typeof EntitiesSchema> | undefined): string {
  let expanded = text;
  for (const entity of entities?.urls ?? []) {
    if (entity.expanded_url) expanded = expanded.split(entity.url).join(entity.expanded_url);
  }
  return expanded;
}
