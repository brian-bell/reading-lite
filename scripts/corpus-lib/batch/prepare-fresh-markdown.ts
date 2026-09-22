import { createHash } from "node:crypto";
import type { Manifest } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import { urlHash as hashUrl } from "../url-hash";
import type { MarkdownArticle } from "../../import-markdown-lib/parse";
import type { BatchActivationPolicy, ExtractedTarget, ExpectedExistingFailed } from "./types";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export interface ByUrlPointer {
  id: string;
  key_prefix: string;
}

// The URL owner and its parsed reading come from PostgreSQL. A malformed
// owner is reported conservatively; planning never repairs ownership.
export type ByUrlLookup = ByUrlPointer | "damaged";

export interface FreshMarkdownDeps {
  getByUrl(urlHash: string): Promise<ByUrlLookup | null>;
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  // A failed ingest may release its URL row. Find that reading for in-place retry.
  findReadingByUrl(url: string, urlHash: string): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null>;
  // Mint a fresh reading id (rd_...) for an unclaimed URL.
  newId(): string;
  newAttemptId(): string;
  now(): string;
}

// Per-article verdict, retained so the CLI can print a complete plan.
export type FreshDisposition =
  | { kind: "ingest-new"; url: string; id: string; article: MarkdownArticle; target: ExtractedTarget }
  | { kind: "ingest-failed"; url: string; id: string; article: MarkdownArticle; target: ExtractedTarget }
  | { kind: "skip-ready"; url: string; id: string; article: MarkdownArticle }
  | { kind: "skip-pending"; url: string; id: string; article: MarkdownArticle }
  | { kind: "skip-occupied-needs-repair"; url: string; id: string | null; article: MarkdownArticle; reason: string }
  | { kind: "skip-no-source"; url: null; id: null; article: MarkdownArticle };

export interface FreshMarkdownPlan {
  dispositions: FreshDisposition[];
  // new + reingest-failed targets, ready to feed similar → submit → write.
  toIngest: ExtractedTarget[];
}

// Resolve a directory of fresh markdown articles into bulk-summarize targets,
// honoring by-url ownership: ready owners are skipped (don't re-summarize),
// pending owners are skipped (a realtime submit may be in flight), failed owners
// re-ingest in place (same id/key_prefix), and unclaimed URLs mint a new id.
export async function prepareFreshMarkdown(
  articles: MarkdownArticle[],
  deps: FreshMarkdownDeps,
): Promise<FreshMarkdownPlan> {
  const dispositions: FreshDisposition[] = [];
  const toIngest: ExtractedTarget[] = [];

  for (const article of articles) {
    const url = article.sourceUrl;
    if (!url) {
      dispositions.push({ kind: "skip-no-source", url: null, id: null, article });
      continue;
    }

    const urlHash = hashUrl(url);
    const owner = await deps.getByUrl(urlHash);
    if (owner && owner !== "damaged") {
      const manifest = await deps.readManifest(owner.key_prefix);
      // Only a manifest that genuinely owns this URL (id + url + url_hash all
      // match the pointer) counts as the owner — exactly ReadingClaim's rule.
      // A pointer cross-wired to an unrelated manifest must NOT make this URL
      // skip, nor re-ingest atop that other reading.
      if (manifest && (manifest.id === owner.id && manifest.url === url && manifest.url_hash === urlHash)) {
        if (manifest.status === "ready") {
          dispositions.push({ kind: "skip-ready", url, id: owner.id, article });
          continue;
        }
        // A pending owner means a realtime submit/import may be in flight — skip
        // it. We deliberately do NOT re-ingest even a past-TTL ("stale") pending:
        // the TTL is a read-time heuristic, the original queue worker may still be
        // running/redelivering, and this offline path can't claim/supersede that
        // attempt the way the Worker does. Re-ingesting could race the worker and
        // (on a batch failure, which carries no preserved-ready snapshot) clobber
        // a just-ready manifest down to failed. A stranded pending is benign and
        // recoverable — heal it via the realtime API or `corpus-recover`.
        if (manifest.status === "pending") {
          dispositions.push({ kind: "skip-pending", url, id: owner.id, article });
          continue;
        }
        // failed owner → re-ingest in place: reuse the claimed id, its key_prefix,
        // and its original created_at (the key_prefix encodes that timestamp).
        const expected = expectedExisting(owner.id, owner.key_prefix, url, urlHash, manifest.created_at);
        const target = buildExtractedTarget(
          article,
          url,
          urlHash,
          owner.id,
          owner.key_prefix,
          manifest.created_at,
          deps.now(),
          deps.newAttemptId(),
          { kind: "verify-existing-failed", expected },
        );
        toIngest.push(target);
        dispositions.push({ kind: "ingest-failed", url, id: owner.id, article, target });
        continue;
      }
      dispositions.push({
        kind: "skip-occupied-needs-repair",
        url,
        id: owner.id,
        article,
        reason: "by-url slot is occupied but does not match a retryable failed owner",
      });
      continue;
    }

    if (owner === "damaged") {
      dispositions.push({
        kind: "skip-occupied-needs-repair",
        url,
        id: null,
        article,
        reason: "by-url slot contains a damaged pointer",
      });
      continue;
    }

    // Reuse a prior failed reading whose URL was released on failure.
    const cold = await deps.findReadingByUrl(url, urlHash);
    if (cold) {
      if (cold.manifest.status === "ready") {
        dispositions.push({ kind: "skip-ready", url, id: cold.id, article });
        continue;
      }
      // A pending owner found this way is left alone for the same reason a
      // pending by-url owner is (can't safely supersede an in-flight worker).
      if (cold.manifest.status === "pending") {
        dispositions.push({ kind: "skip-pending", url, id: cold.id, article });
        continue;
      }
      // failed owner → re-ingest in place: reuse its id, key_prefix, and
      // original created_at exactly as the by-url failed-owner branch does.
      const expected = expectedExisting(cold.id, cold.key_prefix, url, urlHash, cold.manifest.created_at);
      const target = buildExtractedTarget(
        article,
        url,
        urlHash,
        cold.id,
        cold.key_prefix,
        cold.manifest.created_at,
        deps.now(),
        deps.newAttemptId(),
        { kind: "create-existing-failed", expected },
      );
      toIngest.push(target);
      dispositions.push({ kind: "ingest-failed", url, id: cold.id, article, target });
      continue;
    }

    const id = deps.newId();
    const createdAt = deps.now();
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const target = buildExtractedTarget(
      article,
      url,
      urlHash,
      id,
      keyPrefix,
      createdAt,
      createdAt,
      deps.newAttemptId(),
      { kind: "create-new" },
    );
    toIngest.push(target);
    dispositions.push({ kind: "ingest-new", url, id, article, target });
  }

  return { dispositions, toIngest };
}

export interface DispositionTally {
  ingestNew: number;
  ingestFailed: number;
  skipReady: number;
  skipPending: number;
  skipInitializing: number;
  skipOccupiedNeedsRepair: number;
  skipNoSource: number;
  // ingestNew + ingestFailed — the readings that would actually be submitted.
  toIngest: number;
}

// Count dispositions by kind for the CLI plan summary.
export function tallyDispositions(dispositions: FreshDisposition[]): DispositionTally {
  const t: DispositionTally = {
    ingestNew: 0,
    ingestFailed: 0,
    skipReady: 0,
    skipPending: 0,
    skipInitializing: 0,
    skipOccupiedNeedsRepair: 0,
    skipNoSource: 0,
    toIngest: 0,
  };
  for (const d of dispositions) {
    if (d.kind === "ingest-new") t.ingestNew++;
    else if (d.kind === "ingest-failed") t.ingestFailed++;
    else if (d.kind === "skip-ready") t.skipReady++;
    else if (d.kind === "skip-pending") t.skipPending++;
    else if (d.kind === "skip-occupied-needs-repair") t.skipOccupiedNeedsRepair++;
    else if (d.kind === "skip-no-source") t.skipNoSource++;
  }
  t.toIngest = t.ingestNew + t.ingestFailed;
  return t;
}

function buildExtractedTarget(
  article: MarkdownArticle,
  url: string,
  urlHash: string,
  id: string,
  keyPrefix: string,
  createdAt: string,
  now: string,
  attemptId: string,
  freshActivation: BatchActivationPolicy,
): ExtractedTarget {
  const markdown = article.markdown;
  const bytes = article.bytes;
  const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");

  // The synthetic pending manifest only needs to carry source_type (read by the
  // submit phase) and a non-ready status (so no ready-snapshot is preserved); the
  // content_* descriptors below come from `fresh`.
  const manifest: Manifest = {
    id,
    url,
    url_hash: urlHash,
    source_type: "markdown",
    status: "pending",
    ...(article.title === undefined ? {} : { title: article.title }),
    content_type: MARKDOWN_CONTENT_TYPE,
    content_status: "captured",
    content_bytes: bytes,
    content_sha256: sha256,
    created_at: createdAt,
    updated_at: now,
  };

  // The markdown is both the article text and the raw object to persist, mirroring
  // the realtime import endpoint (raw.md + extracted.md are the same bytes).
  const fresh: ExtractedContent = {
    raw: new TextEncoder().encode(markdown),
    content_type: MARKDOWN_CONTENT_TYPE,
    content_status: "captured",
    content_bytes: bytes,
    content_sha256: sha256,
    markdown,
    ...(article.title === undefined ? {} : { title: article.title }),
  };

  return {
    target: {
      readingId: id,
      url,
      urlHash,
      keyPrefix,
      createdAt,
      attemptId,
      attemptStartedAt: now,
      trigger: "import",
      manifest,
    },
    markdown,
    ...(article.title === undefined ? {} : { title: article.title }),
    fresh,
    freshActivation,
  };
}

function expectedExisting(
  id: string,
  keyPrefix: string,
  url: string,
  urlHash: string,
  createdAt: string,
): ExpectedExistingFailed {
  return { id, keyPrefix, url, urlHash, createdAt };
}
