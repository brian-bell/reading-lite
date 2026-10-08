// The R2 key layout, single-homed. This module owns the spelling of every
// object key the reading corpus stores in R2 — the constants, the id+timestamp
// key prefix, and the per-object builders — so the Worker's content store and
// the operator scripts construct keys from one vocabulary instead of
// re-spelling the strings by hand. Reading state lives in PostgreSQL (ADR 0005);
// R2 holds only captured content and the hosted refresh cursor.
//
// The module spells, it does not decide: no I/O and no policy.
//
// The tenant root is an explicit parameter (ADR 0001 tenant data plane): the
// empty string is the pre-tenant global layout, and hosted stores pass
// `u/{tenantId}/` when TENANT_DATA_PLANE=1. Stored `key_prefix` and content
// keys stay RELATIVE — the root is applied only when addressing the bucket.
//
// The exact spellings are a contract with objects already in R2; changing one
// strands the live corpus. test/unit/pipeline-guards.test.ts pins them.

export const READINGS_PREFIX = "readings/";
// Immutable per-attempt content (ADR 0005). Each attempt writes its raw and
// extracted objects under its own id and never overwrites another's, so a
// failed reprocess leaves the published revision's content in place.
export const REVISIONS_PREFIX = "revisions/";
export const EXTRACTED_FILE = "extracted.md";
export const RAW_PREFIX = "raw.";
// Hosted refresh scan and dispatch cursor (src/relationship-refresh.ts).
export const REFRESH_CURSOR_KEY = "index/refresh-cursor.json";

// The relative key prefix one reading's objects live under, persisted as
// `readings.key_prefix`. Root-independent by design (see module header).
export function buildKeyPrefix(id: string, createdAtIso: string): string {
  // Compact UTC timestamp: 2026-04-26T20:00:00.000Z → 2026/04/26T200000Z
  const m = createdAtIso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );
  if (!m) throw new Error(`buildKeyPrefix: invalid ISO timestamp: ${createdAtIso}`);
  const [, y, mo, d, h, mi, s] = m;
  return `${READINGS_PREFIX}${y}/${mo}/${d}T${h}${mi}${s}Z-${id}`;
}

// The raw object's extension token. The consumer's write_raw stage and the
// legacy content-key fallback both spell the raw key through this one rule, so
// the writer and every reader agree on it.
export function rawExtFromContentType(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}

// Key builders bound to one tenant root. `keyPrefix` arguments are the stored
// relative prefix (a buildKeyPrefix result).
export interface R2KeyLayout {
  readonly keyRoot: string;
  // index/refresh-cursor.json — hosted refresh scan and dispatch progress.
  refreshCursorKey(): string;
  // The prefix covering one reading's objects.
  readingObjectsPrefix(keyPrefix: string): string;
  // The legacy spelling directly under key_prefix: an imported reading that no
  // attempt has touched still serves its content from here.
  extractedKey(keyPrefix: string): string;
  rawKey(keyPrefix: string, ext: string): string;
  // The prefix covering every attempt's content under one reading.
  revisionsPrefix(keyPrefix: string): string;
  revisionRawKey(keyPrefix: string, attemptId: string, ext: string): string;
  revisionExtractedKey(keyPrefix: string, attemptId: string): string;
}

export function r2KeyLayout(keyRoot = ""): R2KeyLayout {
  const abs = (relative: string) => `${keyRoot}${relative}`;
  return {
    keyRoot,
    refreshCursorKey: () => abs(REFRESH_CURSOR_KEY),
    readingObjectsPrefix: (keyPrefix) => abs(`${keyPrefix}/`),
    extractedKey: (keyPrefix) => abs(`${keyPrefix}/${EXTRACTED_FILE}`),
    rawKey: (keyPrefix, ext) => abs(`${keyPrefix}/${RAW_PREFIX}${ext}`),
    revisionsPrefix: (keyPrefix) => abs(`${keyPrefix}/${REVISIONS_PREFIX}`),
    revisionRawKey: (keyPrefix, attemptId, ext) =>
      abs(`${keyPrefix}/${REVISIONS_PREFIX}${attemptId}/${RAW_PREFIX}${ext}`),
    revisionExtractedKey: (keyPrefix, attemptId) =>
      abs(`${keyPrefix}/${REVISIONS_PREFIX}${attemptId}/${EXTRACTED_FILE}`),
  };
}
