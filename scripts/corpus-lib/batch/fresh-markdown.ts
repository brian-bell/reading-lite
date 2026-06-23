import { createHash } from "node:crypto";
import type { Manifest } from "../../../src/schemas/manifest";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import type { MarkdownArticle } from "../../import-markdown-lib/parse";
import { urlHash } from "../url-hash";
import type { ExtractedTarget } from "./types";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export interface FreshMarkdownDeps {
  // Reads the by-url ownership pointer for a url hash, or null when unclaimed.
  readPointer(urlHash: string): Promise<{ id: string; key_prefix: string } | null>;
  // Reads the manifest a pointer references, or null when absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  now(): string;
  newId(): string;
}

export interface SkippedTarget {
  url: string;
  reason: "already-ready" | "pending-in-flight";
  readingId?: string;
}

export interface FreshMarkdownPlan {
  targets: ExtractedTarget[];
  skipped: SkippedTarget[];
}

// Resolve a directory of fresh markdown articles into batch-summarize targets,
// applying the client-side idempotency check the worker's eager ReadingClaim
// can't run offline:
//   ready owner    -> skip (don't re-summarize / double-spend)
//   pending owner  -> skip (a realtime submit may be in flight)
//   failed owner   -> re-ingest in place (reuse the existing id / key_prefix)
//   unclaimed      -> mint a new id / key_prefix
// Each ingested target carries the markdown as its `fresh` ExtractedContent so
// submit-phase persists raw.md + extracted.md and reads correct content
// descriptors — byte-compatible with the realtime markdown-import contract.
//
// Callers are expected to have already deduped (buildImportPlan), dropped
// missing-source files, and filtered oversized ones; articles here must have a
// sourceUrl.
export async function prepareFreshMarkdown(
  articles: MarkdownArticle[],
  deps: FreshMarkdownDeps,
): Promise<FreshMarkdownPlan> {
  const targets: ExtractedTarget[] = [];
  const skipped: SkippedTarget[] = [];

  for (const article of articles) {
    const url = article.sourceUrl;
    if (!url) continue;
    const hash = urlHash(url);

    const pointer = await deps.readPointer(hash);
    let id: string;
    let keyPrefix: string;
    let createdAt: string;

    if (pointer) {
      const existing = await deps.readManifest(pointer.key_prefix);
      if (existing?.status === "ready") {
        skipped.push({ url, reason: "already-ready", readingId: pointer.id });
        continue;
      }
      if (existing?.status === "pending") {
        skipped.push({ url, reason: "pending-in-flight", readingId: pointer.id });
        continue;
      }
      // failed owner (or a dangling pointer whose manifest is gone): re-ingest
      // in place, reusing the slot so we don't strand the old id. When the
      // manifest is gone we keep the old key_prefix (don't orphan any objects
      // under it) but stamp created_at = now(); the prefix's embedded date may
      // then disagree with created_at — harmless, the prefix is opaque storage.
      id = pointer.id;
      keyPrefix = pointer.key_prefix;
      createdAt = existing?.created_at ?? deps.now();
    } else {
      id = deps.newId();
      createdAt = deps.now();
      keyPrefix = buildKeyPrefix(id, createdAt);
    }

    targets.push(buildTarget(article, { id, url, urlHash: hash, keyPrefix, createdAt }));
  }

  return { targets, skipped };
}

function buildTarget(
  article: MarkdownArticle,
  ids: { id: string; url: string; urlHash: string; keyPrefix: string; createdAt: string },
): ExtractedTarget {
  const markdown = article.markdown;
  const bytes = new TextEncoder().encode(markdown);
  const contentSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");

  // Synthetic pending markdown manifest: submit-phase reads source_type from it
  // (-> "markdown") and treats a non-ready status as "no ready snapshot to
  // preserve". Content descriptors come from `fresh`, so they need not be real.
  const manifest: Manifest = {
    id: ids.id,
    url: ids.url,
    url_hash: ids.urlHash,
    source_type: "markdown",
    status: "pending",
    ...(article.title === undefined ? {} : { title: article.title }),
    content_type: MARKDOWN_CONTENT_TYPE,
    content_status: "captured",
    content_bytes: bytes.byteLength,
    content_sha256: contentSha256,
    created_at: ids.createdAt,
    updated_at: ids.createdAt,
  };

  return {
    target: {
      readingId: ids.id,
      url: ids.url,
      urlHash: ids.urlHash,
      keyPrefix: ids.keyPrefix,
      createdAt: ids.createdAt,
      manifest,
    },
    markdown,
    ...(article.title === undefined ? {} : { title: article.title }),
    fresh: {
      raw: bytes,
      content_type: MARKDOWN_CONTENT_TYPE,
      content_status: "captured",
      content_bytes: bytes.byteLength,
      content_sha256: contentSha256,
      markdown,
      ...(article.title === undefined ? {} : { title: article.title }),
    },
  };
}
