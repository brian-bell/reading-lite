// Archive export consumer (reading-lite-mxwx.1). One delivery builds one zip
// segment — export.json, index.json, and one manifest per reading — writes
// it to R2, then marks the row ready. Later slices add more files, more
// segments, and the cron that resumes or expires. The DLQ marks the export
// failed so the active slot frees.

import type { ArchiveExportError } from "./schemas/api";
import { ListIndexSchema, type ListIndexItem } from "./schemas/api";
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
import { contentStoreFor } from "./modules/stores/content-store";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";

export const ARCHIVE_EXPORT_QUEUE_NAMES = ["reading-lite-export", "reading-lite-staging-export"] as const;
export const ARCHIVE_EXPORT_DLQ_NAMES = ["reading-lite-export-dlq", "reading-lite-staging-export-dlq"] as const;
export const ARCHIVE_EXPORT_PAGE_SIZE = 100;

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

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
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
  const manifests: ZipEntry[] = [];
  for (const item of listed) {
    const loaded = await store.loadReadingById(item.id);
    if (!loaded) continue;
    kept.push(item);
    manifests.push({ name: `readings/${item.id}/manifest.json`, data: jsonBytes(loaded.manifest) });
  }

  const counts = countStatuses(kept);
  const document = archiveDocument({ generatedAtMs: deps.nowMs, counts });
  const index = ListIndexSchema.parse({ version: 1, items: kept });
  let segment;
  let eocd;
  try {
    segment = await writeZipSegment(
      [
        { name: "export.json", data: jsonBytes(document) },
        { name: "index.json", data: jsonBytes(index) },
        ...manifests,
      ],
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
  const sql = sqlSessionFor(env);
  try {
    await failExport(sql, parsed.envelope, deps.nowMs, { code: "dead_letter" });
    msg.ack();
  } catch (error) {
    console.error(error);
    msg.retry();
  } finally {
    await sql.end();
  }
}
