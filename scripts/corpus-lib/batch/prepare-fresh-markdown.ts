import type { ByUrlPointer, Manifest } from "../../../src/schemas/manifest";
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

export interface PrepareFreshDeps {
  // Reads the by-url ownership pointer for a URL hash, or null when unclaimed.
  readByUrlPointer(urlHash: string): Promise<ByUrlPointer | null>;
  // Reads the manifest at a key prefix (R2 via S3), or null if absent.
  readManifest(keyPrefix: string): Promise<Manifest | null>;
  // Resolves the index/list.json candidate pointers for a URL, ranked best-first
  // (ready>pending>failed, then recency) — the worker's cold-legacy adoption, so a
  // pointerless legacy reading is not duplicated. Candidates are NOT trusted
  // blindly; prepareFreshMarkdown re-reads and verifies the manifest behind each
  // until one matches (the index rows can be stale). Optional: when omitted, only
  // the real by-url pointer is consulted.
  findListCandidates?(url: string): Promise<ByUrlPointer[]>;
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
    // The real by-url pointer is authoritative and is verified first. The ranked
    // index/list.json candidates follow as a fallback — consulted both when there
    // is no pointer at all (cold-legacy adoption) AND when the pointer is present
    // but damaged (its manifest missing or mismatched). The worker's write-path
    // repair deep-scans for a valid legacy owner before minting, so a damaged
    // by-url pointer must not mask a still-valid ready/failed owner and duplicate
    // it. findListCandidates is cached (one list.json read across all articles), so
    // appending it on the happy path is just a Map lookup — and the verify loop
    // breaks on the by-url pointer before reading any list candidate's manifest.
    const byUrlPointer = await deps.readByUrlPointer(urlHash);
    const listCandidates = deps.findListCandidates
      ? await deps.findListCandidates(article.sourceUrl)
      : [];
    const candidates: ByUrlPointer[] = byUrlPointer
      ? [byUrlPointer, ...listCandidates]
      : listCandidates;

    // Verify the manifest behind each candidate and trust the FIRST that genuinely
    // owns this URL — the same id/url/url_hash match the worker's ReadingClaim
    // (ownedManifestMatches) requires. Iterating (not just the top candidate)
    // mirrors ListIndexStore.findManifestByUrl, so a stale/deleted/mismatched best
    // row can't mask a valid lower-ranked owner. A damaged by-url pointer (its
    // manifest missing) is remembered for the grace-window check below.
    let owner: Manifest | null = null;
    let ownerPointer: ByUrlPointer | null = null;
    let byUrlManifestMissing = false;
    for (const cand of candidates) {
      const m = await deps.readManifest(cand.key_prefix);
      if (cand === byUrlPointer && m === null) byUrlManifestMissing = true;
      if (m && m.id === cand.id && m.url === article.sourceUrl && m.url_hash === urlHash) {
        owner = m;
        ownerPointer = cand;
        break;
      }
    }

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
      keyPrefix = ownerPointer!.key_prefix;
      createdAt = owner.created_at;
    } else if (byUrlPointer && byUrlManifestMissing && isFreshMissingManifestPointer(byUrlPointer, deps.now())) {
      // A real by-url pointer written just before its pending manifest (the worker
      // claims by-url first) is a legitimately-initializing owner inside the grace
      // window, NOT a damaged pointer — skip it as in-flight rather than mint a
      // fresh slot that would clobber the activation. Only the real pointer gets
      // this grace; a list.json row is written after the manifest, not before.
      skipped.push({ url: article.sourceUrl, reason: "pending-in-flight" });
      continue;
    } else {
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
