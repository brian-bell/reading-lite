import type { ByUrlPointer, Manifest, ManifestStatus } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import { stalenessOf, type StaleInput } from "../../../src/modules/staleness";
import type { DroppedTarget, ExtractedTarget } from "./types";

// Mirror the worker's PENDING_TTL_SECONDS (wrangler.toml, all envs). A pending
// owner older than this is stale — the worker's read path treats it as failed,
// so we re-ingest it in place rather than skip it forever.
export const PENDING_TTL_SECONDS_DEFAULT = 900;

// Mirror reading-claim.ts's MISSING_MANIFEST_OWNER_GRACE_MS: a by-url pointer
// written just before its pending manifest is a legitimately-initializing owner,
// not a damaged pointer, for this window.
const MISSING_MANIFEST_OWNER_GRACE_MS = 5 * 60 * 1000;

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

// A cold-legacy owner resolved from index/list.json — the master list that still
// includes readings written before the by-url pointer scheme (no pointer). Only
// the staleness-relevant fields are needed to decide skip vs. re-ingest.
export interface ListOwner extends StaleInput {
  status: ManifestStatus;
}

export interface PrepareFreshDeps {
  // Reads the by-url ownership pointer for a URL hash, or null when unclaimed.
  readByUrlPointer(urlHash: string): Promise<ByUrlPointer | null>;
  // Reads the manifest at a key prefix (R2 via S3), or null if absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  // Resolves the best (ready>pending>failed, then recency) index/list.json owner
  // of a URL — the cold-legacy adoption the worker's ReadingClaim does before
  // minting, so a pointerless legacy ready/pending reading is not duplicated.
  // Optional: when omitted, only the by-url pointer is consulted.
  findListOwner?(url: string): Promise<ListOwner | null>;
  // Mints a fresh reading id (mirrors services.newId).
  mintId(): string;
  now(): string;
  sha256(input: string): Promise<string>;
  // Pending-owner staleness threshold (mirrors the worker's PENDING_TTL_SECONDS).
  // Defaults to PENDING_TTL_SECONDS_DEFAULT when omitted.
  pendingTtlSeconds?: number;
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
  const ttlSeconds = deps.pendingTtlSeconds ?? PENDING_TTL_SECONDS_DEFAULT;

  for (const article of articles) {
    const urlHash = await deps.sha256(article.sourceUrl);
    const pointer = await deps.readByUrlPointer(urlHash);
    const existing = pointer ? await deps.readManifest(pointer.key_prefix) : null;
    // Only trust the pointer when its manifest GENUINELY owns this URL — the same
    // id/url/url_hash match the worker's ReadingClaim (ownedManifestMatches)
    // requires. A damaged or stale pointer (missing manifest, or one that resolves
    // to a different URL's reading) is NOT trusted: reusing it would overwrite
    // that other reading, and skipping on it would silently drop this URL. We mint
    // a fresh slot instead and let write-phase repair the by-url pointer on
    // success.
    const owner =
      pointer &&
      existing &&
      existing.id === pointer.id &&
      existing.url === article.sourceUrl &&
      existing.url_hash === urlHash
        ? existing
        : null;

    let id: string;
    let keyPrefix: string;
    let createdAt: string;

    if (owner) {
      if (owner.status === "ready") {
        skipped.push({ url: article.sourceUrl, reason: "already-ready" });
        continue;
      }
      // A pending owner is in-flight only while inside the TTL window. Past it,
      // the worker's read path (annotateStale/stalenessOf) treats it as failed —
      // so a stranded pending from an expired queue attempt must re-ingest here,
      // not skip forever.
      if (owner.status === "pending" && !isStalePending(owner, ttlSeconds, deps.now())) {
        skipped.push({ url: article.sourceUrl, reason: "pending-in-flight" });
        continue;
      }
      // A failed or stale-pending owner is re-ingested in place: reuse its slot so
      // we don't strand the old key prefix.
      id = owner.id;
      keyPrefix = pointer!.key_prefix;
      createdAt = owner.created_at;
    } else if (pointer && !existing && isFreshMissingManifestPointer(pointer, deps.now())) {
      // A pointer written just before its pending manifest (the worker claims
      // by-url first) is a legitimately-initializing owner inside the grace window,
      // NOT a damaged pointer — skip it as in-flight rather than mint a fresh slot
      // that would clobber the activation.
      skipped.push({ url: article.sourceUrl, reason: "pending-in-flight" });
      continue;
    } else {
      // No trusted by-url owner. Before minting, adopt a pointerless legacy owner
      // from index/list.json (the worker's cold-legacy step) so an existing ready
      // or fresh-pending reading for this URL is not duplicated.
      const legacy = deps.findListOwner ? await deps.findListOwner(article.sourceUrl) : null;
      if (legacy?.status === "ready") {
        skipped.push({ url: article.sourceUrl, reason: "already-ready" });
        continue;
      }
      if (legacy?.status === "pending" && !isStalePending(legacy, ttlSeconds, deps.now())) {
        skipped.push({ url: article.sourceUrl, reason: "pending-in-flight" });
        continue;
      }
      id = deps.mintId();
      createdAt = deps.now();
      keyPrefix = buildKeyPrefix(id, createdAt);
    }
    // The by-url slot is always this URL's own hash — a trusted owner matches it,
    // and a fresh/repaired slot claims it.
    const effectiveUrlHash = urlHash;

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

// A pending record counts as stale (treat as failed → re-ingest) when its active
// attempt or the pending record itself has exceeded TTL — the same verdict the
// worker applies at read time. Accepts any StaleInput (a manifest or a list item).
function isStalePending(record: StaleInput, ttlSeconds: number, nowIso: string): boolean {
  const verdict = stalenessOf(record, ttlSeconds, nowIso);
  return verdict.expiredActiveAttempt !== null || verdict.pendingError !== null;
}

// Mirror reading-claim.ts: a by-url pointer with no manifest is an initializing
// owner (not damaged) while its key-prefix timestamp is younger than the grace
// window. The key prefix encodes created_at as readings/YYYY/MM/DDTHHMMSSZ-<id>.
function isFreshMissingManifestPointer(pointer: ByUrlPointer, nowIso: string): boolean {
  const createdAtMs = keyPrefixCreatedAtMs(pointer.key_prefix);
  if (createdAtMs === null) return false;
  const ageMs = Date.parse(nowIso) - createdAtMs;
  return ageMs >= 0 && ageMs < MISSING_MANIFEST_OWNER_GRACE_MS;
}

function keyPrefixCreatedAtMs(keyPrefix: string): number | null {
  const m = keyPrefix.match(/^readings\/(\d{4})\/(\d{2})\/(\d{2})T(\d{2})(\d{2})(\d{2})Z-/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
