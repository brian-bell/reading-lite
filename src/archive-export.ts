// Archive export consumer (reading-lite-mxwx). One delivery builds the zip —
// the format note, one manifest per reading, captured extracted.md and
// raw.<ext>, export.json, index.json, report.json, and checksums.sha256 —
// uploading a segment and its central-directory fragment to R2 each time the
// pending entries fill ARCHIVE_EXPORT_SEGMENT_BYTES, then marks the row ready.
// Content keys come from contentKeys; this module does not spell object
// paths. A later slice resumes a build across deliveries and adds the cron
// that resumes or expires. The DLQ marks the export failed so the active slot
// frees, then deletes any parts the build wrote.

import type { ArchiveExportError } from "./schemas/api";
import { ListIndexItemSchema, ListIndexSchema, type ListIndexItem } from "./schemas/api";
import {
  ArchiveReportSchema,
  type ArchiveContentWarning,
  type ArchiveDanglingRelationship,
  type ArchiveMissingArtifact,
} from "./schemas/archive-report";
import type { Manifest } from "./schemas/manifest";
import {
  ARCHIVE_EXPORT_RETENTION_MS,
  archiveDocument,
  markArchiveExportFailed,
} from "./control-plane/archive-exports";
import { fromSql } from "./control-plane/db";
import {
  logArchiveExportEnvelopeRejected,
  parseArchiveExportEnvelope,
  type ArchiveExportEnvelopeV1,
} from "./control-plane/export-envelope";
import type { TenantId } from "./control-plane/ids";
import { toTimestamp } from "./control-plane/pg-time";
import { ZipLimitError, writeZipEocd, writeZipSegment, type ZipEntry } from "./modules/archive-zip";
import { sqlSessionFor, type Sql } from "./modules/db/sql";
import { sha256Bytes } from "./modules/extractor/response-bytes";
import { contentStoreFor, type ContentStore } from "./modules/stores/content-store";
import { rawExtFromContentType } from "./modules/stores/layout";
import { pgReadingStoreFor, type PgReadingStore } from "./modules/stores/postgres/reading-store";

export const ARCHIVE_EXPORT_QUEUE_NAMES = ["reading-lite-export", "reading-lite-staging-export"] as const;
export const ARCHIVE_EXPORT_DLQ_NAMES = ["reading-lite-export-dlq", "reading-lite-staging-export-dlq"] as const;
export const ARCHIVE_EXPORT_PAGE_SIZE = 100;
// Uncompressed bytes a build holds before it uploads a segment. A segment can
// overrun it by one reading's files (fetches are capped by FETCH_MAX_BYTES,
// 10 MB by default), so memory stays bounded whatever the library's size.
export const ARCHIVE_EXPORT_SEGMENT_BYTES = 16 * 1024 * 1024;
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
- \`readings/<id>/raw.<ext>\` — the original bytes. \`<ext>\` comes from the stored content type: \`html\`, \`md\`, \`pdf\`, \`json\`, \`txt\`, or \`bin\`.
- \`report.json\` — gaps. \`missing_artifacts\` (an expected object was absent), \`dangling_relationships\` (a connection or tension whose target is not in this export), and \`warnings\` (the stored bytes disagree with \`content_bytes\`, \`content_sha256\`, or \`extracted_bytes\`). Warnings are not failures: the file in the zip is what was stored. All three arrays are always present. Nothing is left out.
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
}

export interface ArchiveExportJobDeps {
  nowMs: number;
  pageSize?: number;
  segmentBytes?: number;
}

type BuildOutcome = "ready" | "skipped" | "cancelled" | "failed";

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

async function readBytes(content: ContentStore, key: string | null): Promise<Uint8Array | null> {
  if (key === null) return null;
  const object = await content.get(key);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
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
  entries: HashedEntry[];
  missing: ArchiveMissingArtifact[];
  warnings: ArchiveContentWarning[];
  // Every connection and tension; the dangling ones are known once the whole
  // library has been read.
  relationships: ArchiveDanglingRelationship[];
}

// One reading's files. extracted.md only when the row says the content was
// captured; raw.<ext> for every reading. An expected object that is not in
// the bucket is a missing artifact. A present object whose size or sha256
// disagrees with the row is a warning, and the bytes still ship.
async function packReading(
  store: PgReadingStore,
  content: ContentStore,
  manifest: Manifest,
): Promise<PackedReading> {
  const id = manifest.id;
  const dir = `readings/${id}`;
  const keys = await store.contentKeys(id);
  const rawPath = `${dir}/raw.${rawExtFromContentType(keys?.contentType ?? manifest.content_type)}`;
  const extractedPath = `${dir}/extracted.md`;
  const entries: HashedEntry[] = [await hashed(`${dir}/manifest.json`, jsonBytes(manifest))];
  const missing: ArchiveMissingArtifact[] = [];
  const warnings: ArchiveContentWarning[] = [];

  if (manifest.content_status === "captured") {
    const extracted = await readBytes(content, keys?.extractedKey ?? null);
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

  const raw = await readBytes(content, keys?.rawKey ?? null);
  if (!raw) {
    missing.push({ reading_id: id, kind: "raw", path: rawPath });
  } else {
    const entry = await hashed(rawPath, raw);
    entries.push(entry);
    if (raw.byteLength !== manifest.content_bytes) {
      warnings.push({
        reading_id: id,
        code: "content_size_mismatch",
        path: rawPath,
        expected: manifest.content_bytes,
        actual: raw.byteLength,
      });
    }
    if (entry.sha256 !== manifest.content_sha256) {
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
  return { entries, missing, warnings, relationships };
}

// Uploads the zip while it is built. Once the pending entries reach the
// budget, their segment (local headers and data) and its central-directory
// fragment go to R2 and leave memory, so a build holds about one segment, not
// the library. Only checksum lines and part sizes accumulate. Offsets run
// across segments, so the download joins segments, then fragments, then the
// EOCD into one zip.
class ArchiveWriter {
  private readonly segments: ArchivePart[] = [];
  private readonly centrals: ArchivePart[] = [];
  private readonly checksums: Array<{ name: string; sha256: string }> = [];
  private pending: ZipEntry[] = [];
  private pendingBytes = 0;
  private offset = 0;
  private centralBytes = 0;
  private entries = 0;

  constructor(
    private readonly content: ContentStore,
    private readonly prefix: string,
    private readonly modifiedAt: Date,
    private readonly segmentBytes: number,
  ) {}

  async add(entry: HashedEntry): Promise<void> {
    this.checksums.push({ name: entry.name, sha256: entry.sha256 });
    this.pending.push({ name: entry.name, data: entry.data });
    this.pendingBytes += entry.data.byteLength;
    if (this.pendingBytes >= this.segmentBytes) await this.flush();
  }

  // Writes checksums.sha256 (every other entry, sorted by path), the last
  // segment, and the EOCD. Returns the parts in download order.
  async finish(): Promise<{ parts: ArchivePart[]; total_bytes: number }> {
    const lines = sortedBy(this.checksums, (checksum) => [checksum.name])
      .map((checksum) => `${checksum.sha256}  ${checksum.name}\n`)
      .join("");
    this.pending.push({ name: CHECKSUMS_FILE, data: textBytes(lines) });
    await this.flush();
    const eocd = writeZipEocd({ entries: this.entries, centralBytes: this.centralBytes, centralOffset: this.offset });
    const parts = [...this.segments, ...this.centrals, await this.put("eocd", eocd)];
    return { parts, total_bytes: parts.reduce((total, part) => total + part.bytes, 0) };
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const segment = await writeZipSegment(this.pending, { offset: this.offset, modifiedAt: this.modifiedAt });
    const number = String(this.segments.length + 1).padStart(4, "0");
    this.segments.push(await this.put(`segment-${number}`, segment.local));
    this.centrals.push(await this.put(`central-${number}`, segment.central));
    this.offset += segment.local.byteLength;
    this.centralBytes += segment.central.byteLength;
    this.entries += segment.entries;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private async put(name: string, body: Uint8Array): Promise<ArchivePart> {
    const key = `${this.prefix}/${name}`;
    await this.content.put(key, body, "application/octet-stream");
    return { key, bytes: body.byteLength };
  }
}

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

function exportObjectPrefix(exportId: string): string {
  return `exports/${exportId}`;
}

async function claim(
  sql: Sql,
  envelope: ArchiveExportEnvelopeV1,
  nowMs: number,
): Promise<"build" | "skipped" | "cancelled"> {
  const now = toTimestamp(nowMs);
  return fromSql(sql).transaction(async (tx) => {
    const user = await tx.first<{ status: string }>(
      "SELECT status FROM users WHERE id = ? FOR SHARE",
      envelope.tenantId,
    );
    const row = await tx.first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ? AND tenant_id = ? FOR UPDATE",
      envelope.exportId,
      envelope.tenantId,
    );
    if (!row || row.status === "ready" || row.status === "failed" || row.status === "expired" || row.status === "cancelled") {
      return "skipped";
    }
    if (!user || user.status !== "active") {
      await tx.run(
        `UPDATE archive_exports
         SET status = 'cancelled', completed_at = ?, updated_at = ?, lease_seq = lease_seq + 1
         WHERE id = ? AND tenant_id = ? AND status IN ('queued', 'building')`,
        now,
        now,
        envelope.exportId,
        envelope.tenantId,
      );
      return "cancelled";
    }
    await tx.run(
      `UPDATE archive_exports
       SET status = 'building', started_at = COALESCE(started_at, ?), updated_at = ?,
           lease_seq = lease_seq + 1
       WHERE id = ? AND tenant_id = ? AND status IN ('queued', 'building')`,
      now,
      now,
      envelope.exportId,
      envelope.tenantId,
    );
    return "build";
  });
}

async function collectIndex(
  store: ReturnType<typeof pgReadingStoreFor>,
  pageSize: number,
): Promise<ListIndexItem[]> {
  const items: ListIndexItem[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await store.listItemsKeyset(cursor, pageSize);
    items.push(...page);
    if (page.length < pageSize) return items;
    const last = page[page.length - 1]!;
    const next = { createdAt: last.created_at, id: last.id };
    if (cursor && cursor.createdAt === next.createdAt && cursor.id === next.id) {
      throw new Error("export index page did not advance");
    }
    cursor = next;
  }
}

export async function buildArchiveExport(
  sql: Sql,
  envelope: ArchiveExportEnvelopeV1,
  env: ArchiveExportEnv,
  deps: ArchiveExportJobDeps,
): Promise<BuildOutcome> {
  const claimed = await claim(sql, envelope, deps.nowMs);
  if (claimed !== "build") return claimed;

  const pageSize = deps.pageSize ?? ARCHIVE_EXPORT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("invalid export page size");

  const segmentBytes = deps.segmentBytes ?? ARCHIVE_EXPORT_SEGMENT_BYTES;
  if (!Number.isInteger(segmentBytes) || segmentBytes < 1) throw new Error("invalid export segment size");

  const tenant = { tenantId: envelope.tenantId as TenantId };
  const store = pgReadingStoreFor(sql, tenant);
  const content = contentStoreFor(env.READINGS_BUCKET, tenant, env);
  const prefix = exportObjectPrefix(envelope.exportId);
  const writer = new ArchiveWriter(content, prefix, new Date(deps.nowMs), segmentBytes);
  const listed = await collectIndex(store, pageSize);
  const kept: ListIndexItem[] = [];
  const missing: ArchiveMissingArtifact[] = [];
  const warnings: ArchiveContentWarning[] = [];
  const relationships: ArchiveDanglingRelationship[] = [];
  let built: { segments: { parts: ArchivePart[]; total_bytes: number }; counts: ReturnType<typeof countStatuses> };
  try {
    await writer.add(await hashed("README.md", textBytes(ARCHIVE_README)));
    for (const item of listed) {
      const loaded = await store.loadReadingById(item.id);
      if (!loaded) continue;
      // The listed item can be stale by now (a publish or reprocess landed
      // between pages), so index.json and counts come from the manifest that
      // ships beside it.
      kept.push(ListIndexItemSchema.parse({ ...loaded.manifest, key_prefix: loaded.keyPrefix }));
      const packed = await packReading(store, content, loaded.manifest);
      for (const entry of packed.entries) await writer.add(entry);
      missing.push(...packed.missing);
      warnings.push(...packed.warnings);
      relationships.push(...packed.relationships);
    }

    const counts = countStatuses(kept);
    const exported = new Set(kept.map((item) => item.id));
    const report = ArchiveReportSchema.parse({
      format_version: 1,
      missing_artifacts: sortedBy(missing, (item) => [item.reading_id, item.kind, item.path]),
      dangling_relationships: sortedBy(
        relationships.filter((relationship) => !exported.has(relationship.target_id)),
        (item) => [item.reading_id, item.kind, item.target_id],
      ),
      warnings: sortedBy(warnings, (item) => [item.reading_id, item.code, item.path]),
    });
    await writer.add(await hashed("export.json", jsonBytes(archiveDocument({ generatedAtMs: deps.nowMs, counts }))));
    await writer.add(await hashed("index.json", jsonBytes(ListIndexSchema.parse({ version: 1, items: kept }))));
    await writer.add(await hashed("report.json", jsonBytes(report)));
    built = { segments: await writer.finish(), counts };
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    // Parts first: if the delete throws, the redelivery or the DLQ still
    // finds the export unfinished and removes them.
    await content.deletePrefix(prefix);
    await failExport(sql, envelope, deps.nowMs, { code: "zip_limit" });
    return "failed";
  }

  const now = toTimestamp(deps.nowMs);
  const expires = toTimestamp(deps.nowMs + ARCHIVE_EXPORT_RETENTION_MS);
  const published = await fromSql(sql).transaction(async (tx) => {
    const user = await tx.first<{ status: string }>(
      "SELECT status FROM users WHERE id = ? FOR SHARE",
      envelope.tenantId,
    );
    if (!user || user.status !== "active") {
      await tx.run(
        `UPDATE archive_exports
         SET status = 'cancelled', completed_at = ?, updated_at = ?, lease_seq = lease_seq + 1
         WHERE id = ? AND tenant_id = ? AND status = 'building'`,
        now,
        now,
        envelope.exportId,
        envelope.tenantId,
      );
      return "cancelled" as const;
    }
    const result = await tx.run(
      `UPDATE archive_exports
       SET status = 'ready', completed_at = ?, expires_at = ?, updated_at = ?,
           segments = ?::jsonb, counts = ?::jsonb, lease_seq = lease_seq + 1
       WHERE id = ? AND tenant_id = ? AND status = 'building'`,
      now,
      expires,
      now,
      JSON.stringify(built.segments),
      JSON.stringify(built.counts),
      envelope.exportId,
      envelope.tenantId,
    );
    return result.changes === 1 ? ("ready" as const) : ("skipped" as const);
  });
  if (published === "cancelled") await content.deletePrefix(prefix);
  return published;
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
    await buildArchiveExport(sql, parsed.envelope, env, deps);
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
