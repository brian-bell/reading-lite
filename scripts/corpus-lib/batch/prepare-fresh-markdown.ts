import type { ByUrlPointer, Manifest } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import type { DroppedTarget, ExtractedTarget } from "./types";

// A planned, deduped, non-oversized markdown file with its source URL resolved.
export interface FreshMarkdownArticle {
  sourceUrl: string;
  markdown: string;
  title?: string;
}

// A source URL that already has an owner we must not re-summarize: a ready copy
// (would double-spend + duplicate) or a pending copy (a realtime submit may be
// mid-flight).
export interface SkippedArticle {
  url: string;
  reason: "already-ready" | "pending-in-flight";
}

export interface PrepareFreshDeps {
  // Reads the by-url ownership pointer for a URL hash, or null when unclaimed.
  readByUrlPointer(urlHash: string): Promise<ByUrlPointer | null>;
  // Reads the manifest at a key prefix (R2 via S3), or null if absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  // Mints a fresh reading id (mirrors services.newId).
  mintId(): string;
  now(): string;
  sha256(input: string): Promise<string>;
}

export interface PrepareFreshResult {
  targets: ExtractedTarget[];
  skipped: SkippedArticle[];
  dropped: DroppedTarget[];
}

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

// Build SummarizeTarget inputs straight from markdown in hand, doing the
// client-side idempotency check the worker's eager ReadingClaim would otherwise
// do online:
//   ready owner    -> skip (don't re-summarize, don't double-spend)
//   pending owner  -> skip (a realtime submit may be in flight)
//   failed owner   -> re-ingest in place (reuse id / key_prefix / created_at)
//   unclaimed      -> mint a fresh id / key_prefix
// Because write-phase only writes the by-url pointer on success, the slot stays
// unclaimed during the in-flight batch window — a concurrent realtime submit of
// the same URL could create a duplicate. Acceptable for an operator backfill
// where this script is the sole writer.
export async function prepareFreshMarkdown(
  articles: FreshMarkdownArticle[],
  deps: PrepareFreshDeps,
): Promise<PrepareFreshResult> {
  const targets: ExtractedTarget[] = [];
  const skipped: SkippedArticle[] = [];
  const dropped: DroppedTarget[] = [];

  for (const article of articles) {
    const urlHash = await deps.sha256(article.sourceUrl);
    const pointer = await deps.readByUrlPointer(urlHash);

    let id: string;
    let keyPrefix: string;
    let createdAt: string;
    let effectiveUrlHash = urlHash;

    if (pointer) {
      const existing = await deps.readManifest(pointer.key_prefix);
      if (existing?.status === "ready") {
        skipped.push({ url: article.sourceUrl, reason: "already-ready" });
        continue;
      }
      if (existing?.status === "pending") {
        skipped.push({ url: article.sourceUrl, reason: "pending-in-flight" });
        continue;
      }
      // A failed owner (or a dangling pointer with no manifest) is re-ingested in
      // place: reuse its slot so we don't strand the old key prefix.
      id = existing?.id ?? pointer.id;
      keyPrefix = pointer.key_prefix;
      createdAt = existing?.created_at ?? deps.now();
      effectiveUrlHash = existing?.url_hash ?? urlHash;
    } else {
      id = deps.mintId();
      createdAt = deps.now();
      keyPrefix = buildKeyPrefix(id, createdAt);
    }

    const markdownBytes = new TextEncoder().encode(article.markdown);
    const contentSha256 = await deps.sha256(article.markdown);
    const fresh: ExtractedContent = {
      raw: markdownBytes,
      content_type: MARKDOWN_CONTENT_TYPE,
      content_status: "captured",
      content_bytes: markdownBytes.byteLength,
      content_sha256: contentSha256,
      markdown: article.markdown,
      ...(article.title === undefined ? {} : { title: article.title }),
    };

    // A non-ready carrier manifest: it only feeds source_type ("markdown", so the
    // ready manifest mirrors the realtime import contract even over a prior url
    // failure) and the ready-snapshot check (never ready here, so nothing is
    // preserved). The terminal manifest is built fresh in write-phase.
    const carrier: Manifest = {
      id,
      url: article.sourceUrl,
      url_hash: effectiveUrlHash,
      source_type: "markdown",
      status: "pending",
      ...(article.title === undefined ? {} : { title: article.title }),
      content_type: MARKDOWN_CONTENT_TYPE,
      content_status: "captured",
      content_bytes: markdownBytes.byteLength,
      content_sha256: contentSha256,
      created_at: createdAt,
      updated_at: deps.now(),
    };

    targets.push({
      target: {
        readingId: id,
        url: article.sourceUrl,
        urlHash: effectiveUrlHash,
        keyPrefix,
        createdAt,
        manifest: carrier,
      },
      markdown: article.markdown,
      ...(article.title === undefined ? {} : { title: article.title }),
      fresh,
    });
  }

  return { targets, skipped, dropped };
}
