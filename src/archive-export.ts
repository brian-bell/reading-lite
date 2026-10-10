// Archive export consumer (reading-lite-mxwx). The zip — the format note, one
// manifest per reading, captured extracted.md and raw.<ext>, export.json,
// index.json, report.json, and checksums.sha256 — is built across deliveries,
// one segment each (reading-lite-mxwx.3), on the account-wipe model:
//
// - A delivery claims the row by bumping `lease_seq` and commits only if the
//   sequence is still the one it claimed; a delivery that lost it acks as
//   `lease_held`, because the winner is doing the work. When what took the
//   lease was a cancel or a failure rather than another delivery, it deletes
//   the prefix first: its R2 writes may have landed after the canceller's.
// - It packs readings from the stored cursor until the segment holds
//   ARCHIVE_EXPORT_SEGMENT_READINGS readings or ARCHIVE_EXPORT_SEGMENT_BYTES,
//   writes the segment and its state object to R2, then commits the cursor.
//   R2 first, then the row; no transaction is held across R2. A delivery
//   killed between the two is redelivered from the old cursor and rewrites
//   the same keys, so the zip never holds a reading twice.
// - Then it sends itself the envelope and acks. ARCHIVE_EXPORT_MAX_CONTINUATIONS
//   bounds the self-sends, so a build that cannot finish dead-letters.
// - Once the library is packed, a last delivery writes the closing files, the
//   joined central directory, and the EOCD, and marks the row ready.
//
// The */15 cron re-enqueues a queued or building export whose row has not
// changed in ARCHIVE_EXPORT_LEASE_MS, and expires ready exports seven days
// after they finished, deleting their parts. The DLQ marks the export failed
// so the active slot frees, then deletes any parts the build wrote.
//
// Account deletion (reading-lite-mxwx.4): beginAccountDeletion cancels the
// active export. A delivery re-reads users.status when it claims the row and
// again before writing a segment, and publishes ready only under users FOR SHARE
// with the account active; otherwise it cancels and deletes its parts. The
// parts live under the tenant root, so the wipe sweeps whatever a racing
// write leaves. Content keys come from contentKeys; this module does not
// spell reading object paths.

import { z } from "zod";
import type { ArchiveExportError } from "./schemas/api";
import { ListIndexItemSchema, ListIndexSchema, type ListIndexItem } from "./schemas/api";
import {
  ArchiveContentWarningSchema,
  ArchiveDanglingRelationshipSchema,
  ArchiveMissingArtifactSchema,
  ArchiveReportSchema,
  type ArchiveContentWarning,
  type ArchiveDanglingRelationship,
  type ArchiveMissingArtifact,
} from "./schemas/archive-report";
import { tenantIsActive } from "./control-plane/account-delete";
import {
  ARCHIVE_EXPORT_RETENTION_MS,
  ArchiveExportCursorSchema,
  EMPTY_ARCHIVE_EXPORT_CURSOR,
  archiveDocument,
  cancelActiveArchiveExports,
  exportObjectPrefix,
  markArchiveExportFailed,
  type ArchiveExportCursor,
} from "./control-plane/archive-exports";
import { fromSql } from "./control-plane/db";
import {
  archiveExportEnvelopeV1,
  logArchiveExportEnvelopeRejected,
  parseArchiveExportEnvelope,
  type ArchiveExportEnvelopeV1,
} from "./control-plane/export-envelope";
import { parseTenantId, type TenantId } from "./control-plane/ids";
import { fromTimestamp, toTimestamp } from "./control-plane/pg-time";
import {
  ZIP32_MAX_ENTRIES,
  ZipLimitError,
  concat,
  writeZipEocd,
  writeZipSegment,
  type ZipEntry,
} from "./modules/archive-zip";
import { sqlSessionFor, withSqlSession, type Sql } from "./modules/db/sql";
import { sha256Bytes } from "./modules/extractor/response-bytes";
import { isEmptyContent } from "./modules/manifest-drafting";
import { contentStoreFor, type ContentStore } from "./modules/stores/content-store";
import { rawExtFromContentType } from "./modules/stores/layout";
import {
  PgReadingStore,
  pgReadingStoreFor,
  pgTenantId,
  type ContentKeys,
  type ReadingSnapshot,
} from "./modules/stores/postgres/reading-store";

export const ARCHIVE_EXPORT_QUEUE_NAMES = ["reading-lite-export", "reading-lite-staging-export"] as const;
export const ARCHIVE_EXPORT_DLQ_NAMES = ["reading-lite-export-dlq", "reading-lite-staging-export-dlq"] as const;
export const ARCHIVE_EXPORT_PAGE_SIZE = 100;
// A delivery's segment ends at whichever bound it reaches first. Bytes are
// uncompressed, and a segment can overrun them by one reading's files
// (fetches are capped by FETCH_MAX_BYTES, 10 MB by default), so memory stays
// near one segment whatever the library's size.
export const ARCHIVE_EXPORT_SEGMENT_READINGS = 200;
export const ARCHIVE_EXPORT_SEGMENT_BYTES = 16 * 1024 * 1024;
/**
 * How long cron leaves a queued or building export alone after its row last
 * changed. Every delivery writes the row, and one delivery builds one
 * bounded segment, so a live build changes it far more often than this. It is
 * two cron intervals rather than one because every tenant shares one export
 * queue at concurrency 1, so a continuation can wait behind other builds.
 * Advisory only: a duplicate that cron sends early loses the lease or finds
 * the work done.
 */
export const ARCHIVE_EXPORT_LEASE_MS = 30 * 60_000;
// Files the last delivery adds: export.json, index.json, report.json, and
// checksums.sha256. Reading segments leave room for them in ZIP32's entries.
const CLOSING_ENTRIES = 4;
/**
 * Self-sends one export may make. A continuation acks the current message and
 * sends a fresh one with a fresh retry budget, so without a bound a build that
 * commits a segment and then fails would never dead-letter.
 *
 * Every continuing delivery moves the cursor past at least one reading, apart
 * from the one hand-off to finalize. ZIP32 holds 65,535 entries; README.md and
 * the closing files take five, and every reading ships at least its manifest,
 * so an archive that fits holds at most 65,530 readings. The segment bounds do
 * not give a tighter figure: the byte bound counts uncompressed bytes, so
 * compressible readings can end a segment each while the zip stays small.
 */
const ARCHIVE_MAX_READINGS = ZIP32_MAX_ENTRIES - CLOSING_ENTRIES - 1;
export const ARCHIVE_EXPORT_MAX_CONTINUATIONS = ARCHIVE_MAX_READINGS + 1;
const ARCHIVE_EXPORT_RESUME_BATCH = 100;
export const ARCHIVE_EXPORT_EXPIRE_BATCH = 100;
/**
 * How long an expired export keeps its parts. The download refuses from
 * `expires_at` on, but one authorized just before it opens parts lazily as the
 * client reads, so deleting at the mark could cut it off mid-stream. Six hours
 * covers a 4 GiB archive at about 200 KB/s.
 */
export const ARCHIVE_EXPORT_DOWNLOAD_GRACE_MS = 6 * 60 * 60_000;
const CHECKSUMS_FILE = "checksums.sha256";

// In the zip, so the package stays readable without the repo. The longer
// contract for restore lives in docs/archive-export.md. Keep them in agreement.
const ARCHIVE_README = `# Reading Lite archive

format_version: 1

A restore-oriented export of one account's library. Any unzip tool opens it.
It does not include processing logs or account secrets.

## Files

- \`export.json\` — \`format_version\`, \`generated_at\`, and reading counts by status (\`readings\`, \`pending\`, \`ready\`, \`failed\`).
- \`index.json\` — every reading, every status, in library order (\`version\` 1, \`items\`). Items use the library list shape, so each one includes \`key_prefix\`. That is the row's historical storage location, not a path in this zip. Bytes live under \`readings/<id>/\`.
- \`readings/<id>/manifest.json\` — the reading record (summary, metadata, relationships). Same fields as the reading detail. No storage keys.
- \`readings/<id>/extracted.md\` — captured Markdown, when \`content_status\` is \`captured\` and the object was in storage.
- \`readings/<id>/raw.<ext>\` — the original bytes. \`<ext>\` comes from the reading's \`content_type\` (for a reading that never published, the type its bytes were stored with): \`html\`, \`md\`, \`pdf\`, \`json\`, \`txt\`, or \`bin\`.
- \`report.json\` — gaps. \`missing_artifacts\` (an expected object was absent), \`dangling_relationships\` (a connection or tension whose target is not in this export), and \`warnings\` (the stored bytes disagree with \`content_bytes\`, \`content_sha256\`, or \`extracted_bytes\`; not checked while a reading that never published still has the placeholder \`content_bytes\` 0). Warnings are not failures: the file in the zip is what was stored. All three arrays are always present. Nothing is left out.
- \`checksums.sha256\` — SHA-256 of every other file, GNU \`sha256sum\` text mode (\`<64 hex>  <path>\`), sorted by path. This file is not listed in itself.

## Not in this zip

Attempt events and logs, processing checkpoints, embeddings, internal object keys, provider credentials, sessions, tokens, and spend or quota records.
`;

export function isExportQueue(name: string): boolean {
  return (ARCHIVE_EXPORT_QUEUE_NAMES as readonly string[]).includes(name);
}

export function isExportDlq(name: string): boolean {
  return (ARCHIVE_EXPORT_DLQ_NAMES as readonly string[]).includes(name);
}

export interface ArchiveExportEnv {
  HYPERDRIVE: Hyperdrive;
  READINGS_BUCKET: R2Bucket;
  TENANT_DATA_PLANE?: string;
  ARCHIVE_EXPORT_JOBS?: Queue<ArchiveExportEnvelopeV1>;
}

export interface ArchiveExportJobDeps {
  nowMs: number;
  pageSize?: number;
  segmentReadings?: number;
  segmentBytes?: number;
}

type BuildOutcome = "ready" | "continue" | "lease_held" | "skipped" | "cancelled" | "failed";

export class ArchiveExportContinuationBudgetError extends Error {
  constructor(
    public readonly exportId: string,
    public readonly continuations: number,
  ) {
    super(
      `archive_export continuation_budget_exhausted for ${exportId}: ` +
        `${continuations}/${ARCHIVE_EXPORT_MAX_CONTINUATIONS} self-sends`,
    );
    this.name = "ArchiveExportContinuationBudgetError";
  }
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function jsonBytes(value: unknown): Uint8Array {
  return textBytes(JSON.stringify(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedBy<T>(items: readonly T[], key: (item: T) => readonly string[]): T[] {
  return [...items].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    for (let index = 0; index < leftKey.length; index++) {
      const compared = compareText(leftKey[index] ?? "", rightKey[index] ?? "");
      if (compared !== 0) return compared;
    }
    return 0;
  });
}

async function readObject(
  content: ContentStore,
  key: string | null,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (key === null) return null;
  const object = await content.get(key);
  if (!object) return null;
  return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.contentType };
}

interface ArchivePart {
  key: string;
  bytes: number;
}

// A zip entry with its SHA-256, taken once and reused by checksums.sha256.
interface HashedEntry extends ZipEntry {
  sha256: string;
}

async function hashed(name: string, data: Uint8Array): Promise<HashedEntry> {
  return { name, data, sha256: await sha256Bytes(data) };
}

interface PackedReading {
  item: ListIndexItem;
  entries: HashedEntry[];
  missing: ArchiveMissingArtifact[];
  warnings: ArchiveContentWarning[];
  // Every connection and tension; the dangling ones are known once the whole
  // library has been read.
  relationships: ArchiveDanglingRelationship[];
}

interface ReadingState {
  loaded: ReadingSnapshot;
  keys: ContentKeys | null;
}

// The manifest and its content keys from one snapshot, so both describe the
// same revision even when a publish lands between the two reads.
function readReadingState(sql: Sql, tenantId: string, id: string): Promise<ReadingState | null> {
  return sql.transaction(
    async (tx) => {
      const store = new PgReadingStore(tx, tenantId);
      const loaded = await store.loadReadingById(id);
      return loaded ? { loaded, keys: await store.contentKeys(id) } : null;
    },
    { repeatableRead: true },
  );
}

// A publish after the snapshot deletes the content it superseded
// (AttemptIo.discardSupersededContent), so a missing object is resolved once
// more, as router.ts readContent does: a row that changed is packed from its
// new snapshot, and an unchanged one really is missing the object. A reading
// purged in between is left out, as one purged before its load is.
async function packCurrentReading(
  sql: Sql,
  tenantId: string,
  content: ContentStore,
  id: string,
): Promise<PackedReading | null> {
  const first = await readReadingState(sql, tenantId, id);
  if (!first) return null;
  const packed = await packReading(content, first);
  if (packed.missing.length === 0) return packed;
  const again = await readReadingState(sql, tenantId, id);
  if (!again) return null;
  return again.loaded.version === first.loaded.version ? packed : packReading(content, again);
}

// One reading's files. extracted.md only when the row says the content was
// captured; raw.<ext> for every reading. An expected object that is not in
// the bucket is a missing artifact. A present object whose size or sha256
// disagrees with the row is a warning, and the bytes still ship. A row that
// still carries the empty-content placeholder describes no bytes, so raw
// bytes an unpublished attempt stored ship without that comparison, named by
// the type they were stored with rather than the placeholder's.
async function packReading(content: ContentStore, state: ReadingState): Promise<PackedReading> {
  const { loaded, keys } = state;
  const manifest = loaded.manifest;
  const desk = loaded.deskPosition === undefined ? {} : { desk_position: loaded.deskPosition };
  const id = manifest.id;
  const dir = `readings/${id}`;
  const described = !isEmptyContent(manifest);
  const rowType = keys?.contentType ?? manifest.content_type;
  const extractedPath = `${dir}/extracted.md`;
  const entries: HashedEntry[] = [await hashed(`${dir}/manifest.json`, jsonBytes({ ...manifest, ...desk }))];
  const missing: ArchiveMissingArtifact[] = [];
  const warnings: ArchiveContentWarning[] = [];

  if (manifest.content_status === "captured") {
    const extracted = (await readObject(content, keys?.extractedKey ?? null))?.bytes;
    if (!extracted) {
      missing.push({ reading_id: id, kind: "extracted", path: extractedPath });
    } else {
      entries.push(await hashed(extractedPath, extracted));
      if (manifest.extracted_bytes !== undefined && extracted.byteLength !== manifest.extracted_bytes) {
        warnings.push({
          reading_id: id,
          code: "extracted_size_mismatch",
          path: extractedPath,
          expected: manifest.extracted_bytes,
          actual: extracted.byteLength,
        });
      }
    }
  }

  const stored = await readObject(content, keys?.rawKey ?? null);
  const rawType = stored && !described ? stored.contentType : rowType;
  const rawPath = `${dir}/raw.${rawExtFromContentType(rawType)}`;
  if (!stored) {
    missing.push({ reading_id: id, kind: "raw", path: rawPath });
  } else {
    const raw = stored.bytes;
    const entry = await hashed(rawPath, raw);
    entries.push(entry);
    if (described && raw.byteLength !== manifest.content_bytes) {
      warnings.push({
        reading_id: id,
        code: "content_size_mismatch",
        path: rawPath,
        expected: manifest.content_bytes,
        actual: raw.byteLength,
      });
    }
    if (described && entry.sha256 !== manifest.content_sha256) {
      warnings.push({
        reading_id: id,
        code: "content_hash_mismatch",
        path: rawPath,
        expected: manifest.content_sha256,
        actual: entry.sha256,
      });
    }
  }

  const relationships: ArchiveDanglingRelationship[] = [
    ...(manifest.connections ?? []).map((connection) => ({
      reading_id: id,
      kind: "connection" as const,
      target_id: connection.id,
    })),
    ...(manifest.tensions ?? []).map((tension) => ({ reading_id: id, kind: "tension" as const, target_id: tension.id })),
  ];
  return {
    // The listed item can be stale by now (a publish or reprocess landed
    // between pages), so index.json and counts come from the manifest that
    // ships beside it.
    item: ListIndexItemSchema.parse({ ...manifest, ...desk, key_prefix: loaded.keyPrefix }),
    entries,
    missing,
    warnings,
    relationships,
  };
}

interface ChecksumLine {
  name: string;
  sha256: string;
}

// What a segment carries beyond its zip bytes, kept in R2 beside it: the index
// items, report entries, and checksum lines its readings contributed, and its
// central-directory fragment. The last delivery joins them, so no delivery
// holds more than one segment's worth and the row stays small.
const SegmentStateSchema = z
  .object({
    version: z.literal(1),
    items: z.array(ListIndexItemSchema),
    missing: z.array(ArchiveMissingArtifactSchema),
    warnings: z.array(ArchiveContentWarningSchema),
    relationships: z.array(ArchiveDanglingRelationshipSchema),
    checksums: z.array(z.object({ name: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
    // Base64, so the fragment rides in the same object.
    central: z.string(),
  })
  .strict();
type SegmentState = z.infer<typeof SegmentStateSchema>;

function countStatuses(items: readonly ListIndexItem[]): {
  readings: number;
  pending: number;
  ready: number;
  failed: number;
} {
  const counts = { readings: items.length, pending: 0, ready: 0, failed: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

// Fixed per sequence number, so a redelivery rewrites what the delivery it
// replaces may already have written. That relies on the export consumer's
// max_concurrency = 1: no two deliveries of one export overlap.
function segmentKeys(prefix: string, number: number): { segment: string; state: string } {
  const padded = String(number).padStart(4, "0");
  return { segment: `${prefix}/segments/segment-${padded}`, state: `${prefix}/segments/state-${padded}.json` };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function putPart(content: ContentStore, key: string, body: Uint8Array): Promise<ArchivePart> {
  await content.put(key, body, "application/octet-stream");
  return { key, bytes: body.byteLength };
}

interface Lease {
  // The lease_seq this delivery holds; every commit is conditional on it.
  seq: number;
  cursor: ArchiveExportCursor;
  continuations: number;
  // The first claim's time. Every segment's DOS timestamps and export.json's
  // generated_at come from it, so a resumed build writes what one delivery would.
  startedAtMs: number;
}

async function claim(
  sql: Sql,
  envelope: ArchiveExportEnvelopeV1,
  nowMs: number,
): Promise<Lease | "skipped" | "ended" | "cancelled"> {
  const now = toTimestamp(nowMs);
  return fromSql(sql).transaction(async (tx) => {
    const user = await tx.first<{ status: string }>(
      "SELECT status FROM users WHERE id = ? FOR SHARE",
      envelope.tenantId,
    );
    const row = await tx.first<{
      status: string;
      lease_seq: number;
      cursor: unknown;
      continuations: number;
      started_at: string | null;
    }>(
      `SELECT status, lease_seq, cursor, continuations, started_at FROM archive_exports
       WHERE id = ? AND tenant_id = ? FOR UPDATE`,
      envelope.exportId,
      envelope.tenantId,
    );
    if (row?.status === "cancelled" || row?.status === "failed") return "ended";
    if (!row || (row.status !== "queued" && row.status !== "building")) return "skipped";
    if (!user || user.status !== "active") {
      await cancelActiveArchiveExports(tx, { tenantId: envelope.tenantId, exportId: envelope.exportId, nowMs });
      return "cancelled";
    }
    await tx.run(
      `UPDATE archive_exports
       SET status = 'building', started_at = COALESCE(started_at, ?), updated_at = ?,
           lease_seq = lease_seq + 1
       WHERE id = ? AND tenant_id = ?`,
      now,
      now,
      envelope.exportId,
      envelope.tenantId,
    );
    return {
      seq: row.lease_seq + 1,
      cursor: row.cursor === null ? EMPTY_ARCHIVE_EXPORT_CURSOR : ArchiveExportCursorSchema.parse(row.cursor),
      continuations: row.continuations,
      startedAtMs: row.started_at === null ? nowMs : fromTimestamp(row.started_at),
    };
  });
}

interface ClaimedBuild {
  sql: Sql;
  envelope: ArchiveExportEnvelopeV1;
  content: ContentStore;
  prefix: string;
  lease: Lease;
  nowMs: number;
}

interface SegmentBounds {
  pageSize: number;
  segmentReadings: number;
  segmentBytes: number;
}

// The cursor, one more continuation, and the lease bump, only if no delivery
// has claimed the export since this one did.
async function commitCursor(build: ClaimedBuild, cursor: ArchiveExportCursor): Promise<boolean> {
  const now = toTimestamp(build.nowMs);
  const result = await fromSql(build.sql).run(
    `UPDATE archive_exports
     SET cursor = ?::jsonb, continuations = continuations + 1, lease_seq = lease_seq + 1, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'building' AND lease_seq = ?`,
    JSON.stringify(ArchiveExportCursorSchema.parse(cursor)),
    now,
    build.envelope.exportId,
    build.envelope.tenantId,
    build.lease.seq,
  );
  return result.changes === 1;
}

// A commit that changed no rows. Either another delivery holds the lease and
// is doing the work, or the export ended under this one: an operator cancel
// (`ops export cancel`), account deletion, or the DLQ. Whoever ended it
// deleted the prefix, possibly before this delivery's R2 writes, and this
// delivery acks, so no redelivery follows to sweep them. By now those writes
// are done, so it deletes the prefix itself; if that throws, the retry claims
// an ended export and sweeps it. A live build keeps its parts.
async function standDown(build: ClaimedBuild): Promise<"lease_held" | "cancelled" | "failed"> {
  const row = await fromSql(build.sql).first<{ status: string }>(
    "SELECT status FROM archive_exports WHERE id = ? AND tenant_id = ?",
    build.envelope.exportId,
    build.envelope.tenantId,
  );
  if (row?.status !== "cancelled" && row?.status !== "failed") return "lease_held";
  await build.content.deletePrefix(build.prefix);
  return row.status;
}

// Re-read right before a readings segment's R2 writes (reading-lite-mxwx.4):
// packing takes a while, and account deletion can start meanwhile. Parts
// first, then the row, so a failed delete retries into a claim that still
// finds the build unfinished and deletes them. A write that races past this
// check lands after the fence; the wipe lists the whole tenant prefix and
// reopens for it. Finalize needs no such check: it publishes under users FOR
// SHARE and deletes its parts when the account has left active.
async function cancelIfInactive(build: ClaimedBuild): Promise<boolean> {
  const db = fromSql(build.sql);
  if (await tenantIsActive(db, build.envelope.tenantId)) return false;
  await build.content.deletePrefix(build.prefix);
  await cancelActiveArchiveExports(db, {
    tenantId: build.envelope.tenantId,
    exportId: build.envelope.exportId,
    nowMs: build.nowMs,
  });
  return true;
}

// One delivery's segment: readings from the cursor until a bound, written to
// R2 with its state object before the cursor moves past them. The delivery
// that packs the last reading hands the build to finalize.
async function buildReadingsSegment(
  build: ClaimedBuild,
  bounds: SegmentBounds,
): Promise<"continue" | "lease_held" | "cancelled" | "failed"> {
  const { sql, envelope, content, prefix, lease } = build;
  // Bound the self-send before doing the work it would follow. Persisted, so
  // the count is the export's and not one delivery's.
  if (lease.continuations >= ARCHIVE_EXPORT_MAX_CONTINUATIONS) {
    throw new ArchiveExportContinuationBudgetError(envelope.exportId, lease.continuations);
  }
  const cursor = lease.cursor;
  const tenant = { tenantId: envelope.tenantId as TenantId };
  const tenantId = pgTenantId(tenant);
  const store = pgReadingStoreFor(sql, tenant);
  const entries: HashedEntry[] = [];
  const items: ListIndexItem[] = [];
  const missing: ArchiveMissingArtifact[] = [];
  const warnings: ArchiveContentWarning[] = [];
  const relationships: ArchiveDanglingRelationship[] = [];
  let bytes = 0;
  const add = (entry: HashedEntry) => {
    entries.push(entry);
    bytes += entry.data.byteLength;
  };
  if (cursor.segments.length === 0) add(await hashed("README.md", textBytes(ARCHIVE_README)));

  let after = cursor.after;
  let readings = 0;
  let exhausted = false;
  while (!exhausted && readings < bounds.segmentReadings && bytes < bounds.segmentBytes) {
    const limit = Math.min(bounds.pageSize, bounds.segmentReadings - readings);
    // One row past the page says whether the library ends with it.
    const page = await store.listItemsKeyset(after && { createdAt: after.created_at, id: after.id }, limit + 1);
    let taken = 0;
    for (const listed of page.slice(0, limit)) {
      const packed = await packCurrentReading(sql, tenantId, content, listed.id);
      after = { created_at: listed.created_at, id: listed.id };
      readings += 1;
      taken += 1;
      if (packed) {
        items.push(packed.item);
        for (const entry of packed.entries) add(entry);
        missing.push(...packed.missing);
        warnings.push(...packed.warnings);
        relationships.push(...packed.relationships);
      }
      if (bytes >= bounds.segmentBytes) break;
    }
    exhausted = taken === page.length;
  }

  let next: ArchiveExportCursor = { ...cursor, phase: exhausted ? "finalize" : "readings", after };
  if (entries.length > 0) {
    if (await cancelIfInactive(build)) return "cancelled";
    const keys = segmentKeys(prefix, cursor.segments.length + 1);
    const segment = await writeZipSegment(entries, {
      offset: cursor.offset,
      // Room for the closing files, so a library ZIP32 cannot hold is refused
      // on the segment that crosses the limit rather than at the end.
      entriesBefore: cursor.entries + CLOSING_ENTRIES,
      modifiedAt: new Date(lease.startedAtMs),
    });
    const part = await putPart(content, keys.segment, segment.local);
    const state: SegmentState = SegmentStateSchema.parse({
      version: 1,
      items,
      missing,
      warnings,
      relationships,
      checksums: entries.map((entry) => ({ name: entry.name, sha256: entry.sha256 })),
      central: toBase64(segment.central),
    });
    await content.put(keys.state, jsonBytes(state), "application/json");
    next = {
      ...next,
      offset: cursor.offset + segment.local.byteLength,
      entries: cursor.entries + segment.entries,
      segments: [...cursor.segments, part],
    };
  }
  return (await commitCursor(build, next)) ? "continue" : standDown(build);
}

async function readSegmentState(content: ContentStore, key: string): Promise<SegmentState> {
  const object = await content.get(key);
  if (!object) throw new Error(`archive segment state missing: ${key}`);
  return SegmentStateSchema.parse(JSON.parse(new TextDecoder().decode(await object.arrayBuffer())));
}

// The last delivery: export.json, index.json, report.json, and
// checksums.sha256 from every segment's state, then one central directory
// joined from the fragments, then the EOCD. The download reads one part per
// segment plus two. Publishes under users FOR SHARE and the lease.
async function finalizeArchive(build: ClaimedBuild): Promise<"ready" | "cancelled" | "failed" | "lease_held"> {
  const { sql, envelope, content, prefix, lease } = build;
  const cursor = lease.cursor;
  const items: ListIndexItem[] = [];
  const missing: ArchiveMissingArtifact[] = [];
  const warnings: ArchiveContentWarning[] = [];
  const relationships: ArchiveDanglingRelationship[] = [];
  const checksums: ChecksumLine[] = [];
  const centrals: Uint8Array[] = [];
  for (let number = 1; number <= cursor.segments.length; number++) {
    const state = await readSegmentState(content, segmentKeys(prefix, number).state);
    items.push(...state.items);
    missing.push(...state.missing);
    warnings.push(...state.warnings);
    relationships.push(...state.relationships);
    checksums.push(...state.checksums);
    centrals.push(fromBase64(state.central));
  }

  const counts = countStatuses(items);
  const exported = new Set(items.map((item) => item.id));
  const report = ArchiveReportSchema.parse({
    format_version: 1,
    missing_artifacts: sortedBy(missing, (item) => [item.reading_id, item.kind, item.path]),
    dangling_relationships: sortedBy(
      relationships.filter((relationship) => !exported.has(relationship.target_id)),
      (item) => [item.reading_id, item.kind, item.target_id],
    ),
    warnings: sortedBy(warnings, (item) => [item.reading_id, item.code, item.path]),
  });
  const closing = [
    await hashed("export.json", jsonBytes(archiveDocument({ generatedAtMs: lease.startedAtMs, counts }))),
    await hashed("index.json", jsonBytes(ListIndexSchema.parse({ version: 1, items }))),
    await hashed("report.json", jsonBytes(report)),
  ];
  checksums.push(...closing.map((entry) => ({ name: entry.name, sha256: entry.sha256 })));
  const lines = sortedBy(checksums, (checksum) => [checksum.name])
    .map((checksum) => `${checksum.sha256}  ${checksum.name}\n`)
    .join("");
  const segment = await writeZipSegment([...closing, { name: CHECKSUMS_FILE, data: textBytes(lines) }], {
    offset: cursor.offset,
    entriesBefore: cursor.entries,
    modifiedAt: new Date(lease.startedAtMs),
  });
  const central = concat([...centrals, segment.central]);
  const eocd = writeZipEocd({
    entries: cursor.entries + segment.entries,
    centralBytes: central.byteLength,
    centralOffset: cursor.offset + segment.local.byteLength,
  });
  const parts = [
    ...cursor.segments,
    await putPart(content, segmentKeys(prefix, cursor.segments.length + 1).segment, segment.local),
    await putPart(content, `${prefix}/central`, central),
    await putPart(content, `${prefix}/eocd`, eocd),
  ];
  const segments = { parts, total_bytes: parts.reduce((total, part) => total + part.bytes, 0) };

  const now = toTimestamp(build.nowMs);
  const expires = toTimestamp(build.nowMs + ARCHIVE_EXPORT_RETENTION_MS);
  const published = await fromSql(sql).transaction(async (tx) => {
    const user = await tx.first<{ status: string }>(
      "SELECT status FROM users WHERE id = ? FOR SHARE",
      envelope.tenantId,
    );
    if (!user || user.status !== "active") {
      await cancelActiveArchiveExports(tx, {
        tenantId: envelope.tenantId,
        exportId: envelope.exportId,
        nowMs: build.nowMs,
      });
      return "cancelled" as const;
    }
    const result = await tx.run(
      `UPDATE archive_exports
       SET status = 'ready', completed_at = ?, expires_at = ?, updated_at = ?,
           segments = ?::jsonb, counts = ?::jsonb, lease_seq = lease_seq + 1
       WHERE id = ? AND tenant_id = ? AND status = 'building' AND lease_seq = ?`,
      now,
      expires,
      now,
      JSON.stringify(segments),
      JSON.stringify(counts),
      envelope.exportId,
      envelope.tenantId,
      lease.seq,
    );
    return result.changes === 1 ? ("ready" as const) : ("lease_held" as const);
  });
  if (published === "cancelled") await content.deletePrefix(prefix);
  return published === "lease_held" ? standDown(build) : published;
}

function positiveInteger(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid export ${what}`);
  return value;
}

// One delivery of an export: one segment of readings, or the finalize.
export async function buildArchiveExport(
  sql: Sql,
  envelope: ArchiveExportEnvelopeV1,
  env: ArchiveExportEnv,
  deps: ArchiveExportJobDeps,
): Promise<BuildOutcome> {
  const bounds: SegmentBounds = {
    pageSize: positiveInteger(deps.pageSize ?? ARCHIVE_EXPORT_PAGE_SIZE, "page size"),
    segmentReadings: positiveInteger(deps.segmentReadings ?? ARCHIVE_EXPORT_SEGMENT_READINGS, "segment readings"),
    segmentBytes: positiveInteger(deps.segmentBytes ?? ARCHIVE_EXPORT_SEGMENT_BYTES, "segment size"),
  };
  const content = contentStoreFor(env.READINGS_BUCKET, { tenantId: envelope.tenantId as TenantId }, env);
  const prefix = exportObjectPrefix(envelope.exportId);
  const lease = await claim(sql, envelope, deps.nowMs);
  if (lease === "skipped") return lease;
  if (lease === "ended") {
    // A cancelled or failed export serves no one, so a delivery that finds
    // one sweeps it: parts an earlier delivery wrote before it crashed, or
    // left when its own delete failed after losing the commit.
    await content.deletePrefix(prefix);
    return "skipped";
  }
  if (lease === "cancelled") {
    // Earlier deliveries' segments serve no one once the row is cancelled.
    await content.deletePrefix(prefix);
    return lease;
  }
  const build: ClaimedBuild = { sql, envelope, content, prefix, lease, nowMs: deps.nowMs };
  try {
    return lease.cursor.phase === "finalize" ? await finalizeArchive(build) : await buildReadingsSegment(build, bounds);
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    // Parts first: if the delete throws, the redelivery or the DLQ still
    // finds the export unfinished and removes them.
    await content.deletePrefix(prefix);
    await failExport(sql, envelope, deps.nowMs, { code: "zip_limit" });
    return "failed";
  }
}

async function failExport(
  sql: Sql,
  envelope: ArchiveExportEnvelopeV1,
  nowMs: number,
  error: ArchiveExportError,
): Promise<void> {
  await markArchiveExportFailed(fromSql(sql), {
    tenantId: envelope.tenantId,
    exportId: envelope.exportId,
    nowMs,
    error,
  });
}

export async function consumeArchiveExportMessage(
  msg: { body: unknown; ack: () => void; retry: (opts?: { delaySeconds?: number }) => void },
  env: ArchiveExportEnv,
  deps: ArchiveExportJobDeps,
): Promise<void> {
  const parsed = parseArchiveExportEnvelope(msg.body);
  if (!parsed.ok) {
    logArchiveExportEnvelopeRejected(parsed.reason);
    msg.ack();
    return;
  }
  const sql = sqlSessionFor(env);
  try {
    const outcome = await buildArchiveExport(sql, parsed.envelope, env, deps);
    if (outcome === "continue") {
      const queue = env.ARCHIVE_EXPORT_JOBS;
      if (!queue) throw new Error("ARCHIVE_EXPORT_JOBS unbound");
      await queue.send(parsed.envelope);
    } else if (outcome === "lease_held") {
      console.warn(
        JSON.stringify({
          event: "archive_export_lease_held",
          export_id: parsed.envelope.exportId,
          note: "another delivery claimed this export; conditional update changed no rows",
        }),
      );
    }
    msg.ack();
  } catch (error) {
    console.error(error);
    msg.retry();
  } finally {
    await sql.end();
  }
}

export async function handleArchiveExportDeadLetter(
  msg: { body: unknown; ack: () => void; retry: (opts?: { delaySeconds?: number }) => void },
  env: ArchiveExportEnv,
  deps: { nowMs: number },
): Promise<void> {
  const parsed = parseArchiveExportEnvelope(msg.body);
  if (!parsed.ok) {
    logArchiveExportEnvelopeRejected(parsed.reason);
    msg.ack();
    return;
  }
  // Acking a failed mark burns the DLQ's retries and leaves the row queued
  // or building, so the partial unique index 409s the tenant until manual SQL.
  // A transient database error has to fail the delivery and keep the retry.
  // The same holds for the parts a build wrote before it kept failing: a failed
  // row never serves them, so they go now or never. A ready row, reached by a
  // stale dead letter, keeps its parts.
  const sql = sqlSessionFor(env);
  try {
    const { tenantId, exportId } = parsed.envelope;
    await failExport(sql, parsed.envelope, deps.nowMs, { code: "dead_letter" });
    const row = await fromSql(sql).first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ? AND tenant_id = ?",
      exportId,
      tenantId,
    );
    if (row?.status === "failed") {
      const content = contentStoreFor(env.READINGS_BUCKET, { tenantId: tenantId as TenantId }, env);
      await content.deletePrefix(exportObjectPrefix(exportId));
    }
    msg.ack();
  } catch (error) {
    console.error(error);
    msg.retry();
  } finally {
    await sql.end();
  }
}

// The */15 cron. A queued or building export whose row has not changed in
// ARCHIVE_EXPORT_LEASE_MS lost its message (a lost continuation, or a crash
// between a commit and its self-send), so it is sent again. The row is renewed
// first, conditional on what was read, so the next tick sees it live and a
// delivery that moved it in between wins.
export async function resumeStalledArchiveExports(
  env: ArchiveExportEnv,
  deps: { nowMs: number },
): Promise<{ enqueued: number }> {
  const queue = env.ARCHIVE_EXPORT_JOBS;
  if (!queue) {
    console.warn(JSON.stringify({ event: "archive_export_resume_skipped", reason: "queue_unbound" }));
    return { enqueued: 0 };
  }
  return withSqlSession(env, async (sql) => {
    const db = fromSql(sql);
    const stale = toTimestamp(deps.nowMs - ARCHIVE_EXPORT_LEASE_MS);
    const now = toTimestamp(deps.nowMs);
    const rows = await db.all<{ id: string; tenant_id: string; lease_seq: number }>(
      `SELECT id, tenant_id, lease_seq FROM archive_exports
       WHERE status IN ('queued', 'building') AND updated_at < ?
       ORDER BY updated_at
       LIMIT ?`,
      stale,
      ARCHIVE_EXPORT_RESUME_BATCH,
    );
    let enqueued = 0;
    for (const row of rows) {
      try {
        const tenantId = parseTenantId(row.tenant_id);
        if (!tenantId) continue;
        const renewed = await db.run(
          `UPDATE archive_exports SET updated_at = ?
           WHERE id = ? AND tenant_id = ? AND status IN ('queued', 'building')
             AND lease_seq = ? AND updated_at < ?`,
          now,
          row.id,
          row.tenant_id,
          row.lease_seq,
          stale,
        );
        if (renewed.changes !== 1) continue;
        await queue.send(archiveExportEnvelopeV1({ tenantId, exportId: row.id }));
        enqueued += 1;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "archive_export_resume_failed",
            export_id: row.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return { enqueued };
  });
}

// The */15 cron's expiry (reading-lite-mxwx.4). A ready export past
// `expires_at` is marked expired at once; the download also refuses a ready
// row past `expires_at` on its own, so a late tick changes nothing a client
// sees. Its prefix is deleted only once ARCHIVE_EXPORT_DOWNLOAD_GRACE_MS has
// passed too, so a download that started before `expires_at` can finish.
// `segments` stays on the row until the delete succeeds, which is how a later
// tick finds a delete that failed. Each tick touches the rows it picks before
// trying them and picks the least recently touched first, so a row whose
// delete keeps failing rotates behind newer expiries instead of holding the
// head of the batch.
export async function expireArchiveExports(
  env: ArchiveExportEnv,
  deps: { nowMs: number },
): Promise<{ expired: number; deleted: number }> {
  return withSqlSession(env, async (sql) => {
    const db = fromSql(sql);
    const now = toTimestamp(deps.nowMs);
    const marked = await db.run(
      `UPDATE archive_exports
       SET status = 'expired', updated_at = ?, lease_seq = lease_seq + 1
       WHERE id IN (
         SELECT id FROM archive_exports
         WHERE status = 'ready' AND expires_at <= ?
         ORDER BY expires_at
         LIMIT ?
       ) AND status = 'ready'`,
      now,
      now,
      ARCHIVE_EXPORT_EXPIRE_BATCH,
    );
    const rows = await db.all<{ id: string; tenant_id: string }>(
      `UPDATE archive_exports SET updated_at = ?
       WHERE id IN (
         SELECT id FROM archive_exports
         WHERE status = 'expired' AND segments IS NOT NULL AND expires_at <= ?
         ORDER BY updated_at
         LIMIT ?
       ) AND status = 'expired' AND segments IS NOT NULL
       RETURNING id, tenant_id`,
      now,
      toTimestamp(deps.nowMs - ARCHIVE_EXPORT_DOWNLOAD_GRACE_MS),
      ARCHIVE_EXPORT_EXPIRE_BATCH,
    );
    let deleted = 0;
    for (const row of rows) {
      try {
        const tenantId = parseTenantId(row.tenant_id);
        if (tenantId) {
          const content = contentStoreFor(env.READINGS_BUCKET, { tenantId }, env);
          await content.deletePrefix(exportObjectPrefix(row.id));
        } else {
          // A build writes parts only under its envelope's parsed tenant and
          // commits only where the row's tenant_id matches it, so this row
          // points at nothing to delete. Clear it rather than retry it forever.
          console.error(
            JSON.stringify({ event: "archive_export_expire_failed", export_id: row.id, reason: "invalid_tenant_id" }),
          );
        }
        await db.run(
          `UPDATE archive_exports SET segments = NULL
           WHERE id = ? AND tenant_id = ? AND status = 'expired'`,
          row.id,
          row.tenant_id,
        );
        if (tenantId) deleted += 1;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "archive_export_expire_failed",
            export_id: row.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return { expired: marked.changes, deleted };
  });
}
