// Classifies a tenant's R2 objects against its PostgreSQL rows for
// `ops corpus purge-legacy` (reading-lite-gh351.5).
//
// The manifest-era layout left objects that nothing reads since the
// 2026-09-24 cutover: each reading's manifest.json, attempts/ logs and
// processing/ checkpoints, the index/ list, pointers, tombstones and refresh marker, the legacy-spelled
// raw.{ext} / extracted.md a reprocess superseded, and prefixes with no row at
// all. Everything else is kept, and so is anything this module does not
// recognise: a removal needs a stated legacy reason, never the absence of one.
//
// Pure: keys in, verdicts out. Keys are tenant-relative (the caller strips the
// `u/{tenantId}/` root), and `referenced` is every key a row can still resolve
// (contentKeysFor), which is what protects an imported reading that no attempt
// has touched: its legacy spelling is the row's content.

import {
  ATTEMPTS_PREFIX,
  BY_ID_PREFIX,
  BY_URL_PREFIX,
  DELETED_PREFIX,
  EXTRACTED_FILE,
  LIST_INDEX_KEY,
  MANIFEST_FILE,
  PROCESSING_PREFIX,
  RAW_PREFIX,
  READINGS_PREFIX,
  REFRESH_CURSOR_KEY,
  REFRESH_STATE_KEY,
  REVISIONS_PREFIX,
} from "../../src/modules/stores/layout";
import { parseReadingId } from "../../src/services";

export type RemoveReason =
  | "manifest"
  | "attempt_log"
  | "checkpoint"
  | "superseded_content"
  | "orphan_prefix"
  | "list_index"
  | "refresh_state"
  | "url_pointer"
  | "id_pointer"
  | "tombstone";

export type KeepReason = "referenced" | "revision" | "live_index" | "unrecognized" | "prefix_id_mismatch";

export interface LegacyReading {
  id: string;
  keyPrefix: string;
  /** Every key a row can still resolve for this reading. */
  referenced: ReadonlySet<string>;
}

export interface Removal {
  key: string;
  reason: RemoveReason;
  /** Set for removals under a reading prefix, so execute can re-check that reading. */
  readingId?: string;
  prefix?: string;
}

export interface LegacyPlan {
  remove: Removal[];
  keep: { key: string; reason: KeepReason }[];
}

// buildKeyPrefix's spelling: readings/YYYY/MM/DDTHHMMSSZ-{readingId}.
const READING_PREFIX = new RegExp(`^(${READINGS_PREFIX}\\d{4}/\\d{2}/\\d{2}T\\d{6}Z-(rd_[^/]+))/(.+)$`);

const INDEX_OBJECTS: [match: (key: string) => boolean, reason: RemoveReason][] = [
  [(key) => key === LIST_INDEX_KEY, "list_index"],
  [(key) => key === REFRESH_STATE_KEY, "refresh_state"],
  [(key) => key.startsWith(BY_URL_PREFIX), "url_pointer"],
  [(key) => key.startsWith(BY_ID_PREFIX), "id_pointer"],
  [(key) => key.startsWith(DELETED_PREFIX), "tombstone"],
];

export function classifyLegacyObjects(keys: readonly string[], readings: readonly LegacyReading[]): LegacyPlan {
  const byPrefix = new Map(readings.map((reading) => [reading.keyPrefix, reading]));
  const ids = new Set(readings.map((reading) => reading.id));
  const plan: LegacyPlan = { remove: [], keep: [] };
  const keep = (key: string, reason: KeepReason) => plan.keep.push({ key, reason });

  for (const key of keys) {
    if (key === REFRESH_CURSOR_KEY) {
      keep(key, "live_index");
      continue;
    }
    const index = INDEX_OBJECTS.find(([match]) => match(key));
    if (index) {
      plan.remove.push({ key, reason: index[1] });
      continue;
    }
    const match = READING_PREFIX.exec(key);
    const readingId = match ? parseReadingId(match[2]!) : null;
    if (!match || !readingId) {
      keep(key, "unrecognized");
      continue;
    }
    const prefix = match[1]!;
    const rest = match[3]!;
    const reading = byPrefix.get(prefix);
    if (!reading) {
      if (ids.has(readingId)) keep(key, "prefix_id_mismatch");
      else plan.remove.push({ key, reason: "orphan_prefix", readingId, prefix });
      continue;
    }
    if (reading.referenced.has(key)) keep(key, "referenced");
    else if (rest.startsWith(REVISIONS_PREFIX)) keep(key, "revision");
    else if (rest === MANIFEST_FILE) plan.remove.push({ key, reason: "manifest", readingId, prefix });
    else if (rest.startsWith(ATTEMPTS_PREFIX)) plan.remove.push({ key, reason: "attempt_log", readingId, prefix });
    else if (rest.startsWith(PROCESSING_PREFIX)) plan.remove.push({ key, reason: "checkpoint", readingId, prefix });
    else if (rest === EXTRACTED_FILE || (rest.startsWith(RAW_PREFIX) && !rest.includes("/"))) {
      plan.remove.push({ key, reason: "superseded_content", readingId, prefix });
    } else keep(key, "unrecognized");
  }
  return plan;
}
