import { createHash } from "node:crypto";
import type { Manifest } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import {
  isFreshMissingManifestPointer,
  ownedManifestMatches,
} from "../../../src/modules/reading-claim";
import { urlHash as hashUrl } from "../url-hash";
import type { MarkdownArticle } from "../../import-markdown-lib/parse";
import type { ExtractedTarget } from "./types";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export interface ByUrlPointer {
  id: string;
  key_prefix: string;
}

// A by-url read can be: a usable pointer, `null` (object absent → unclaimed), or
// "damaged" (object present but non-JSON or missing id/key_prefix). "damaged" is
// kept distinct from null so the caller can route it to the forced-scan repair
// path instead of silently treating a corrupt claim as an unclaimed URL — the
// Worker's strict ByUrlPointerSchema.parse throws rather than read it as absent.
export type ByUrlLookup = ByUrlPointer | "damaged";

// The bulk fresh-markdown front-end's view of the corpus: it replaces the
// worker's eager ReadingClaim (which we can't run offline) with client-side
// by-url ownership reads.
export interface FreshMarkdownDeps {
  // index/by-url/{sha256(url)} read: a pointer, null when absent, or "damaged".
  getByUrl(urlHash: string): Promise<ByUrlLookup | null>;
  // The manifest behind a pointer, or null if absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  // The cold-legacy lookup: resolve a URL's owner through index/list.json when
  // no live by-url pointer exists, mirroring the Worker's findManifestByUrl.
  // Returns the ranked owner (ready > pending > failed, then recency) or null.
  // Load-bearing for retry-after-failure: a failed fresh ingest leaves a by-id
  // pointer + list row but NO by-url pointer, so a rerun finds the failed
  // reading here and re-ingests it in place instead of minting a duplicate.
  // `forceScan` mirrors the Worker's `deepScan: true` damaged-pointer repair:
  // scan the bucket even when the index parses, so a stale index can't hide the
  // real owner. Left off for plain cold lookups to avoid a per-submit scan.
  findByUrlInList(
    url: string,
    urlHash: string,
    opts?: { forceScan?: boolean },
  ): Promise<{ id: string; key_prefix: string; manifest: Manifest } | null>;
  // Mint a fresh reading id (rd_...) for an unclaimed URL.
  newId(): string;
  now(): string;
}

// Per-article verdict, retained so the CLI can print a complete plan.
export type FreshDisposition =
  | { kind: "ingest-new"; url: string; id: string; article: MarkdownArticle; target: ExtractedTarget }
  | { kind: "ingest-failed"; url: string; id: string; article: MarkdownArticle; target: ExtractedTarget }
  | { kind: "skip-ready"; url: string; id: string; article: MarkdownArticle }
  | { kind: "skip-pending"; url: string; id: string; article: MarkdownArticle }
  // A by-url pointer whose manifest hasn't landed yet, inside the grace window —
  // a realtime submit/import is in flight; do not touch it (mirrors ReadingClaim's
  // `initializing`).
  | { kind: "skip-initializing"; url: string; id: string; article: MarkdownArticle }
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
    // A structurally "damaged" pointer (present but non-JSON or missing fields)
    // has no usable key_prefix, so it skips the owner checks and falls straight
    // through to the forced-scan repair below — exactly like a mismatched/
    // stale-missing pointer, never like an absent one.
    if (owner && owner !== "damaged") {
      const manifest = await deps.readManifest(owner.key_prefix);
      // Only a manifest that genuinely owns this URL (id + url + url_hash all
      // match the pointer) counts as the owner — exactly ReadingClaim's rule.
      // A pointer cross-wired to an unrelated manifest must NOT make this URL
      // skip, nor re-ingest atop that other reading.
      if (manifest && ownedManifestMatches(owner, manifest, url, urlHash)) {
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
        const target = buildExtractedTarget(
          article,
          url,
          urlHash,
          owner.id,
          owner.key_prefix,
          manifest.created_at,
          deps.now(),
        );
        toIngest.push(target);
        dispositions.push({ kind: "ingest-failed", url, id: owner.id, article, target });
        continue;
      }
      // A fresh pointer whose manifest hasn't landed is a still-initializing
      // owner (a realtime submit wrote by-url before its pending manifest) — skip
      // it so the backfill never clobbers an in-flight claim.
      if (!manifest && isFreshMissingManifestPointer(owner, deps.now())) {
        dispositions.push({ kind: "skip-initializing", url, id: owner.id, article });
        continue;
      }
      // Otherwise the by-url pointer is damaged (mismatched manifest, or
      // stale-missing). Do NOT mint blindly — fall through to the cold-legacy
      // lookup below, exactly as the no-pointer path does. index/list.json may
      // still hold the real owner for this URL (the same row the Worker repairs
      // through findManifestByUrl); minting here would duplicate an
      // already-owned URL and then overwrite the by-url pointer on success.
    }

    // No usable live by-url owner (absent, or damaged and falling through).
    // Run the cold-legacy lookup before minting (mirrors the Worker's
    // resolveOwner cold path): a prior failed fresh ingest writes a by-id
    // pointer + list row but deliberately no by-url pointer, so a retry must
    // re-ingest THAT failed reading in place rather than mint a second one.
    // Resolve through index/list.json by the same ready>pending>failed
    // ownership rank the Worker uses. A damaged pointer (owner present but
    // unmatched, or structurally "damaged") forces a deep scan — the Worker's
    // `deepScan: existing ? true` repair policy — so a stale index that lost the
    // owner's row can't make us mint a duplicate and overwrite by-url onto it.
    const cold = await deps.findByUrlInList(url, urlHash, { forceScan: owner !== null });
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
      const target = buildExtractedTarget(
        article,
        url,
        urlHash,
        cold.id,
        cold.key_prefix,
        cold.manifest.created_at,
        deps.now(),
      );
      toIngest.push(target);
      dispositions.push({ kind: "ingest-failed", url, id: cold.id, article, target });
      continue;
    }

    const id = deps.newId();
    const createdAt = deps.now();
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const target = buildExtractedTarget(article, url, urlHash, id, keyPrefix, createdAt, createdAt);
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
    skipNoSource: 0,
    toIngest: 0,
  };
  for (const d of dispositions) {
    if (d.kind === "ingest-new") t.ingestNew++;
    else if (d.kind === "ingest-failed") t.ingestFailed++;
    else if (d.kind === "skip-ready") t.skipReady++;
    else if (d.kind === "skip-pending") t.skipPending++;
    else if (d.kind === "skip-initializing") t.skipInitializing++;
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
    target: { readingId: id, url, urlHash, keyPrefix, createdAt, manifest },
    markdown,
    ...(article.title === undefined ? {} : { title: article.title }),
    fresh,
  };
}
