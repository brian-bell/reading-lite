/**
 * ARCHIVE_EXPORT_JOBS envelope v1. The body carries only identity — no
 * cursor, no object keys — so a crash redrive resumes from the
 * `archive_exports` row.
 */
import { z } from "zod";
import { parseTenantId, type TenantId } from "./ids";

const EXPORT_ID_RE =
  /^exp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ArchiveExportEnvelopeV1 {
  version: 1;
  tenantId: TenantId;
  exportId: string;
}

export type ArchiveExportEnvelopeRejectReason =
  | "unknown_version"
  | "absent_tenant"
  | "malformed_id"
  | "malformed_job";

export type ParseArchiveExportEnvelopeResult =
  | { ok: true; envelope: ArchiveExportEnvelopeV1 }
  | { ok: false; reason: ArchiveExportEnvelopeRejectReason };

const ArchiveExportEnvelopeV1Schema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().min(1),
    exportId: z.string().min(1),
  })
  .strip();

export function parseExportId(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return EXPORT_ID_RE.test(value) ? value : null;
}

export function mintExportId(uuid: () => string = () => crypto.randomUUID()): string {
  const id = `exp_${uuid()}`;
  if (!parseExportId(id)) throw new Error("minted export id was malformed");
  return id;
}

export function parseArchiveExportEnvelope(body: unknown): ParseArchiveExportEnvelopeResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "unknown_version" };
  }
  const record = body as Record<string, unknown>;
  if (record.version !== 1) return { ok: false, reason: "unknown_version" };
  if (record.tenantId == null || record.tenantId === "") return { ok: false, reason: "absent_tenant" };

  const parsed = ArchiveExportEnvelopeV1Schema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "malformed_job" };
  const tenantId = parseTenantId(parsed.data.tenantId);
  const exportId = parseExportId(parsed.data.exportId);
  if (!tenantId || !exportId) return { ok: false, reason: "malformed_id" };
  return { ok: true, envelope: { version: 1, tenantId, exportId } };
}

export function archiveExportEnvelopeV1(input: {
  tenantId: TenantId;
  exportId: string;
}): ArchiveExportEnvelopeV1 {
  const exportId = parseExportId(input.exportId);
  if (!exportId) throw new Error("malformed export id");
  return { version: 1, tenantId: input.tenantId, exportId };
}

export const ARCHIVE_EXPORT_ENVELOPE_REJECTED_EVENT = "archive_export_envelope_rejected";

export function logArchiveExportEnvelopeRejected(reason: ArchiveExportEnvelopeRejectReason): void {
  console.error(
    JSON.stringify({
      severity: "high",
      event: ARCHIVE_EXPORT_ENVELOPE_REJECTED_EVENT,
      reason,
    }),
  );
}
