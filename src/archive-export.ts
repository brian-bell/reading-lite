// Archive export consumer (reading-lite-mxwx). One delivery builds one zip
// segment — the format note, export.json, index.json, one manifest per
// reading, captured extracted.md and raw.<ext>, report.json, and
// checksums.sha256 — writes it to R2, then marks the row ready. Content keys
// come from contentKeys; this module does not spell object paths. Later
// slices add more segments and the cron that resumes or expires. The DLQ
// marks the export failed so the active slot frees, then deletes any parts
// the build wrote.

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

interface PackedReading {
  manifest: Manifest;
  entries: ZipEntry[];
  missing: ArchiveMissingArtifact[];
  warnings: ArchiveContentWarning[];
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
  const entries: ZipEntry[] = [{ name: `${dir}/manifest.json`, data: jsonBytes(manifest) }];
  const missing: ArchiveMissingArtifact[] = [];
  const warnings: ArchiveContentWarning[] = [];

  if (manifest.content_status === "captured") {
    const extracted = await readBytes(content, keys?.extractedKey ?? null);
    if (!extracted) {
      missing.push({ reading_id: id, kind: "extracted", path: extractedPath });
    } else {
      entries.push({ name: extractedPath, data: extracted });
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
    entries.push({ name: rawPath, data: raw });
    if (raw.byteLength !== manifest.content_bytes) {
      warnings.push({
        reading_id: id,
        code: "content_size_mismatch",
        path: rawPath,
        expected: manifest.content_bytes,
        actual: raw.byteLength,
      });
    }
    const hash = await sha256Bytes(raw);
    if (hash !== manifest.content_sha256) {
      warnings.push({
        reading_id: id,
        code: "content_hash_mismatch",
        path: rawPath,
        expected: manifest.content_sha256,
        actual: hash,
      });
    }
  }

  return { manifest, entries, missing, warnings };
}

function danglingRelationships(
  packed: readonly PackedReading[],
  exported: ReadonlySet<string>,
): ArchiveDanglingRelationship[] {
  const dangling: ArchiveDanglingRelationship[] = [];
  for (const reading of packed) {
    const id = reading.manifest.id;
    for (const connection of reading.manifest.connections ?? []) {
      if (!exported.has(connection.id)) {
        dangling.push({ reading_id: id, kind: "connection", target_id: connection.id });
      }
    }
    for (const tension of reading.manifest.tensions ?? []) {
      if (!exported.has(tension.id)) {
        dangling.push({ reading_id: id, kind: "tension", target_id: tension.id });
      }
    }
  }
  return dangling;
}

async function withChecksums(entries: readonly ZipEntry[]): Promise<ZipEntry[]> {
  const lines: string[] = [];
  for (const entry of [...entries].sort((left, right) => compareText(left.name, right.name))) {
    lines.push(`${await sha256Bytes(entry.data)}  ${entry.name}`);
  }
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return [...entries, { name: CHECKSUMS_FILE, data: textBytes(body) }];
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

  const tenant = { tenantId: envelope.tenantId as TenantId };
  const store = pgReadingStoreFor(sql, tenant);
  const content = contentStoreFor(env.READINGS_BUCKET, tenant, env);
  const listed = await collectIndex(store, pageSize);
  const kept: ListIndexItem[] = [];
  const packed: PackedReading[] = [];
  for (const item of listed) {
    const loaded = await store.loadReadingById(item.id);
    if (!loaded) continue;
    // The listed item can be stale by now (a publish or reprocess landed
    // between pages), so index.json and counts come from the manifest that
    // ships beside it.
    kept.push(ListIndexItemSchema.parse({ ...loaded.manifest, key_prefix: loaded.keyPrefix }));
    packed.push(await packReading(store, content, loaded.manifest));
  }

  const counts = countStatuses(kept);
  const document = archiveDocument({ generatedAtMs: deps.nowMs, counts });
  const index = ListIndexSchema.parse({ version: 1, items: kept });
  const exported = new Set(packed.map((reading) => reading.manifest.id));
  const report = ArchiveReportSchema.parse({
    format_version: 1,
    missing_artifacts: sortedBy(
      packed.flatMap((reading) => reading.missing),
      (item) => [item.reading_id, item.kind, item.path],
    ),
    dangling_relationships: sortedBy(danglingRelationships(packed, exported), (item) => [
      item.reading_id,
      item.kind,
      item.target_id,
    ]),
    warnings: sortedBy(
      packed.flatMap((reading) => reading.warnings),
      (item) => [item.reading_id, item.code, item.path],
    ),
  });
  let segment;
  let eocd;
  try {
    segment = await writeZipSegment(
      await withChecksums([
        { name: "README.md", data: textBytes(ARCHIVE_README) },
        { name: "export.json", data: jsonBytes(document) },
        { name: "index.json", data: jsonBytes(index) },
        ...packed.flatMap((reading) => reading.entries),
        { name: "report.json", data: jsonBytes(report) },
      ]),
      { offset: 0, modifiedAt: new Date(deps.nowMs) },
    );
    eocd = writeZipEocd({
      entries: segment.entries,
      centralBytes: segment.central.byteLength,
      centralOffset: segment.local.byteLength,
    });
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    await failExport(sql, envelope, deps.nowMs, { code: "zip_limit" });
    return "failed";
  }

  const total = segment.local.byteLength + segment.central.byteLength + eocd.byteLength;
  const prefix = exportObjectPrefix(envelope.exportId);
  const parts = [
    { key: `${prefix}/segment-0001`, bytes: segment.local.byteLength, body: segment.local },
    { key: `${prefix}/central-directory`, bytes: segment.central.byteLength, body: segment.central },
    { key: `${prefix}/eocd`, bytes: eocd.byteLength, body: eocd },
  ];
  for (const part of parts) {
    await content.put(part.key, part.body, "application/octet-stream");
  }

  const segments = {
    parts: parts.map(({ key, bytes }) => ({ key, bytes })),
    total_bytes: total,
  };
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
      JSON.stringify(segments),
      JSON.stringify(counts),
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
