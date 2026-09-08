// The R2 key layout, single-homed. This module owns the spelling of every
// object key the reading corpus stores — the constants, the id+timestamp key
// prefix, and the per-object builders — so the worker stores (R2 binding
// adapter) and the operator scripts (wrangler-spawn and S3 adapters) construct
// keys from one vocabulary instead of re-spelling the strings by hand.
//
// Like manifest-drafting: the module spells, it does not decide. No I/O, no
// policy — CAS vs sole-writer write discipline, ownership rules, and read
// strictness all stay with the callers.
//
// The tenant root is an explicit parameter (ADR 0001 tenant data plane): the
// empty string is the pre-tenant global layout, and hosted stores pass
// `u/{tenantId}/` when TENANT_DATA_PLANE=1. Stored `key_prefix` values stay
// RELATIVE — the root is applied only when addressing the bucket, so the same
// manifest row is valid under any root. That is what makes the founder-corpus
// cutover (reading-lite-s1k.6) a re-rooting of reads/writes rather than a
// rewrite of stored state.
//
// The exact spellings are a contract with objects already in R2; changing one
// strands the live corpus. test/unit/stores/layout.test.ts pins them.

export const LIST_INDEX_KEY = "index/list.json";
export const MANIFEST_FILE = "manifest.json";
export const READINGS_PREFIX = "readings/";
export const EXTRACTED_FILE = "extracted.md";
export const RAW_PREFIX = "raw.";
export const ATTEMPTS_PREFIX = "attempts/";
// The nightly-refresh run marker. Written only by the operator CLI
// (`corpus refresh-neighbours`), read by nothing in the Worker — but it is a
// corpus object under the tenant root, so its spelling belongs here with the
// rest of them.
export const REFRESH_STATE_KEY = "index/refresh-state.json";
// Hosted scan/dispatch cursor; independent of the operator run marker.
export const REFRESH_CURSOR_KEY = "index/refresh-cursor.json";
export const BY_URL_PREFIX = "index/by-url/";
export const BY_ID_PREFIX = "index/by-id/";
// Per-reading purge tombstone (issue #179). Existence-only; not under the
// reading object prefix, so `deleteReadingObjects` cannot remove it.
export const DELETED_PREFIX = "index/deleted/";

// The relative key prefix one reading's objects live under. Root-independent by
// design (see module header): this exact string is persisted in manifests,
// by-url/by-id pointers, and index/list.json rows.
export function buildKeyPrefix(id: string, createdAtIso: string): string {
  // Compact UTC timestamp: 2026-04-26T20:00:00.000Z → 2026/04/26T200000Z
  const m = createdAtIso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );
  if (!m) throw new Error(`buildKeyPrefix: invalid ISO timestamp: ${createdAtIso}`);
  const [, y, mo, d, h, mi, s] = m;
  return `${READINGS_PREFIX}${y}/${mo}/${d}T${h}${mi}${s}Z-${id}`;
}

// Key builders bound to one tenant root. `keyPrefix` arguments are the stored
// relative prefix (a buildKeyPrefix result); `urlHash` is the lowercase hex
// sha256 of the exact submitted URL (worker: services.sha256Hex; scripts:
// corpus-lib/url-hash.ts — unit-tested to agree).
export interface R2KeyLayout {
  readonly keyRoot: string;
  // index/list.json — the single list-index object.
  listIndexKey(): string;
  // index/refresh-state.json — the nightly-refresh run marker.
  refreshStateKey(): string;
  // Hosted refresh scan and dispatch progress, independent of the ops marker.
  refreshCursorKey(): string;
  // The scan prefix covering every reading's objects (manifest rebuild).
  readingsPrefix(): string;
  // The prefix covering one reading's objects (diagnostics listing).
  readingObjectsPrefix(keyPrefix: string): string;
  manifestKey(keyPrefix: string): string;
  extractedKey(keyPrefix: string): string;
  rawKey(keyPrefix: string, ext: string): string;
  attemptsPrefix(keyPrefix: string): string;
  attemptKey(keyPrefix: string, attemptId: string): string;
  processingCheckpointKey(keyPrefix: string, attemptId: string): string;
  byUrlKey(urlHash: string): string;
  byIdKey(id: string): string;
  // index/deleted/{id} — purge tombstone, existence-only.
  deletedKey(id: string): string;
  // Inverse of the root application: maps an absolute bucket key back to the
  // relative layout (identity when the key does not carry this root).
  relativeKey(objectKey: string): string;
}

export function r2KeyLayout(keyRoot = ""): R2KeyLayout {
  const abs = (relative: string) => `${keyRoot}${relative}`;
  return {
    keyRoot,
    listIndexKey: () => abs(LIST_INDEX_KEY),
    refreshStateKey: () => abs(REFRESH_STATE_KEY),
    refreshCursorKey: () => abs(REFRESH_CURSOR_KEY),
    readingsPrefix: () => abs(READINGS_PREFIX),
    readingObjectsPrefix: (keyPrefix) => abs(`${keyPrefix}/`),
    manifestKey: (keyPrefix) => abs(`${keyPrefix}/${MANIFEST_FILE}`),
    extractedKey: (keyPrefix) => abs(`${keyPrefix}/${EXTRACTED_FILE}`),
    rawKey: (keyPrefix, ext) => abs(`${keyPrefix}/${RAW_PREFIX}${ext}`),
    attemptsPrefix: (keyPrefix) => abs(`${keyPrefix}/${ATTEMPTS_PREFIX}`),
    attemptKey: (keyPrefix, attemptId) =>
      abs(`${keyPrefix}/${ATTEMPTS_PREFIX}${attemptId}.json`),
    processingCheckpointKey: (keyPrefix, attemptId) =>
      abs(`${keyPrefix}/processing/${attemptId}.json`),
    byUrlKey: (urlHash) => abs(`${BY_URL_PREFIX}${urlHash}`),
    byIdKey: (id) => abs(`${BY_ID_PREFIX}${id}`),
    deletedKey: (id) => abs(`${DELETED_PREFIX}${id}`),
    relativeKey: (objectKey) =>
      keyRoot !== "" && objectKey.startsWith(keyRoot)
        ? objectKey.slice(keyRoot.length)
        : objectKey,
  };
}
