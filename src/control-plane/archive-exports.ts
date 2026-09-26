// Admission for archive export (reading-lite-mxwx). One transaction under
// `users FOR UPDATE`, the same serialization the token cap uses: an active
// export (partial unique index) is 409, and a queued, building, or ready
// request inside the rolling day is 429. Failed, cancelled, and expired
// requests do not count, so a failure frees the slot immediately.
//
// Lifecycle (reading-lite-mxwx.4): account deletion cancels the active export
// (`cancelActiveArchiveExports`), and a ready export stops serving at
// `expires_at`, seven days after it finished, whether or not cron has marked
// it expired yet.

import { z } from "zod";
import {
  ArchiveExportDocumentSchema,
  ArchiveExportErrorSchema,
  ArchiveExportSummarySchema,
  type ArchiveExportDocument,
  type ArchiveExportError,
  type ArchiveExportSummary,
} from "../schemas/api";
import { isUniqueConstraintError, type ControlPlaneDb } from "./db";
import { mintExportId, parseExportId } from "./export-envelope";
import type { UserId } from "./ids";
import { fromTimestamp, toTimestamp } from "./pg-time";

export const ARCHIVE_EXPORT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ARCHIVE_EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RequestArchiveExportResult =
  | { kind: "queued"; id: string }
  | { kind: "inactive" }
  | { kind: "active"; id: string }
  | { kind: "daily"; resetAtMs: number };

export interface ArchiveExportSegments {
  parts: Array<{ key: string; bytes: number }>;
  total_bytes: number;
}

const PartSchema = z
  .object({
    key: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const SegmentsSchema = z
  .object({
    parts: z.array(PartSchema).min(1),
    total_bytes: z.number().int().nonnegative(),
  })
  .strict();

// Where a build stands between deliveries (reading-lite-mxwx.3). `after` is
// the last reading listed, in library order; `segments` are the local-header
// segments committed so far, in zip order. `offset` and `entries` are where
// the next segment starts. Everything per reading lives in each segment's R2
// state object, so the row does not grow with the library.
export const ArchiveExportCursorSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["readings", "finalize"]),
    after: z.object({ created_at: z.string().min(1), id: z.string().min(1) }).strict().nullable(),
    offset: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    segments: z.array(PartSchema),
  })
  .strict();
export type ArchiveExportCursor = z.infer<typeof ArchiveExportCursorSchema>;

export const EMPTY_ARCHIVE_EXPORT_CURSOR: ArchiveExportCursor = {
  version: 1,
  phase: "readings",
  after: null,
  offset: 0,
  entries: 0,
  segments: [],
};

interface ExportRow {
  id: string;
  tenant_id: string;
  status: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  segments: unknown;
  error: unknown;
}

const SUMMARY_COLUMNS = `id, tenant_id, status, requested_at, started_at, completed_at, expires_at, segments, error`;

export async function requestArchiveExport(
  db: ControlPlaneDb,
  input: { userId: UserId; nowMs: number; newUuid?: () => string },
): Promise<RequestArchiveExportResult> {
  const id = mintExportId(input.newUuid);
  const now = toTimestamp(input.nowMs);
  const windowStart = toTimestamp(input.nowMs - ARCHIVE_EXPORT_DAILY_WINDOW_MS);
  try {
    return await db.transaction(async (tx) => {
      const user = await tx.first<{ status: string }>(
        "SELECT status FROM users WHERE id = ? FOR UPDATE",
        input.userId,
      );
      if (!user || user.status !== "active") return { kind: "inactive" };

      const active = await tx.first<{ id: string }>(
        `SELECT id FROM archive_exports
         WHERE tenant_id = ? AND status IN ('queued', 'building')`,
        input.userId,
      );
      if (active) return { kind: "active", id: active.id };

      const recent = await tx.first<{ requested_at: string }>(
        `SELECT requested_at FROM archive_exports
         WHERE tenant_id = ? AND status IN ('queued', 'building', 'ready') AND requested_at > ?
         ORDER BY requested_at DESC
         LIMIT 1`,
        input.userId,
        windowStart,
      );
      if (recent) {
        return {
          kind: "daily",
          resetAtMs: fromTimestamp(recent.requested_at) + ARCHIVE_EXPORT_DAILY_WINDOW_MS,
        };
      }

      await tx.run(
        `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?)`,
        id,
        input.userId,
        now,
        now,
      );
      return { kind: "queued", id };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const active = await db.first<{ id: string }>(
      `SELECT id FROM archive_exports
       WHERE tenant_id = ? AND status IN ('queued', 'building')`,
      input.userId,
    );
    return { kind: "active", id: active?.id ?? id };
  }
}

export async function markArchiveExportFailed(
  db: ControlPlaneDb,
  input: { tenantId: string; exportId: string; nowMs: number; error: ArchiveExportError },
): Promise<void> {
  const error = ArchiveExportErrorSchema.parse(input.error);
  const now = toTimestamp(input.nowMs);
  await db.run(
    `UPDATE archive_exports
     SET status = 'failed', error = ?::jsonb, completed_at = ?, updated_at = ?,
         lease_seq = lease_seq + 1
     WHERE id = ? AND tenant_id = ? AND status IN ('queued', 'building')`,
    JSON.stringify(error),
    now,
    now,
    input.exportId,
    input.tenantId,
  );
}

// Cancels the tenant's queued or building export, or only `exportId` when
// given. Bumps lease_seq, so a delivery mid-build loses its next commit.
// `error` says who cancelled when it was not account deletion
// (`operator_cancelled` from `ops export cancel`). Returns the rows changed.
export async function cancelActiveArchiveExports(
  db: ControlPlaneDb,
  input: { tenantId: string; nowMs: number; exportId?: string; error?: ArchiveExportError },
): Promise<number> {
  const now = toTimestamp(input.nowMs);
  const error = input.error === undefined ? null : JSON.stringify(ArchiveExportErrorSchema.parse(input.error));
  const result = await db.run(
    `UPDATE archive_exports
     SET status = 'cancelled', completed_at = ?, updated_at = ?, lease_seq = lease_seq + 1,
         error = ?::jsonb
     WHERE tenant_id = ? AND status IN ('queued', 'building') AND (?::text IS NULL OR id = ?)`,
    now,
    now,
    error,
    input.tenantId,
    input.exportId ?? null,
    input.exportId ?? null,
  );
  return result.changes;
}

// An export's parts, relative to the tenant root: segments, their state
// objects, the joined central directory, and the EOCD. The consumer, the DLQ,
// expiry, and `ops export cancel` all delete this prefix and nothing narrower.
export function exportObjectPrefix(exportId: string): string {
  return `exports/${exportId}`;
}

export interface LatestArchiveExport {
  export: ArchiveExportSummary | null;
  nextAllowedAtMs: number;
}

export async function latestArchiveExport(
  db: ControlPlaneDb,
  input: { userId: UserId; nowMs: number },
): Promise<LatestArchiveExport> {
  const row = await db.first<ExportRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM archive_exports
     WHERE tenant_id = ?
     ORDER BY requested_at DESC
     LIMIT 1`,
    input.userId,
  );
  const counted = await db.first<{ requested_at: string }>(
    `SELECT requested_at FROM archive_exports
     WHERE tenant_id = ? AND status IN ('queued', 'building', 'ready')
     ORDER BY requested_at DESC
     LIMIT 1`,
    input.userId,
  );
  const nextAllowedAtMs = counted
    ? Math.max(input.nowMs, fromTimestamp(counted.requested_at) + ARCHIVE_EXPORT_DAILY_WINDOW_MS)
    : input.nowMs;
  return { export: row ? summaryOf(row, input.nowMs) : null, nextAllowedAtMs };
}

export type OwnedArchiveDownload =
  | { kind: "not_found" }
  | { kind: "not_ready" }
  | { kind: "expired" }
  | { kind: "ready"; segments: ArchiveExportSegments };

export async function ownedArchiveDownload(
  db: ControlPlaneDb,
  input: { userId: UserId; exportId: string; nowMs: number },
): Promise<OwnedArchiveDownload> {
  const exportId = parseExportId(input.exportId);
  if (!exportId) return { kind: "not_found" };
  const row = await db.first<ExportRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM archive_exports WHERE id = ? AND tenant_id = ?`,
    exportId,
    input.userId,
  );
  if (!row) return { kind: "not_found" };
  if (row.status === "expired") return { kind: "expired" };
  if (row.status !== "ready") return { kind: "not_ready" };
  if (row.expires_at === null || fromTimestamp(row.expires_at) <= input.nowMs) return { kind: "expired" };
  const segments = SegmentsSchema.parse(row.segments);
  const sum = segments.parts.reduce((total, part) => total + part.bytes, 0);
  if (sum !== segments.total_bytes) throw new Error("archive segment sizes do not add up");
  return { kind: "ready", segments };
}

export function archiveDocument(input: {
  generatedAtMs: number;
  counts: ArchiveExportDocument["counts"];
}): ArchiveExportDocument {
  return ArchiveExportDocumentSchema.parse({
    format_version: 1,
    generated_at: new Date(input.generatedAtMs).toISOString(),
    counts: input.counts,
  });
}

// A ready row past `expires_at` reads as expired, as the download treats it,
// before cron gets to it.
function summaryOf(row: ExportRow, nowMs: number): ArchiveExportSummary {
  const lapsed = row.status === "ready" && (row.expires_at === null || fromTimestamp(row.expires_at) <= nowMs);
  return ArchiveExportSummarySchema.parse({
    id: row.id,
    status: lapsed ? "expired" : row.status,
    requested_at: row.requested_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
    error: row.error === null || row.error === undefined ? null : ArchiveExportErrorSchema.parse(row.error),
  });
}
