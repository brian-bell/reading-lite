/**
 * DIGEST_JOBS envelope v1. Cron fan-out puts one message per tenant; the
 * consumer re-reads settings at send time. The body carries only identity and
 * the ledger key — no email address, no reading ids.
 */
import { z } from "zod";
import { parseTenantId, parseUserId, type TenantId, type UserId } from "./ids";

export interface DigestEnvelopeV1 {
  version: 1;
  tenantId: TenantId;
  userId: UserId;
  period_key: string;
  cadence: "daily" | "weekly";
}

export type DigestEnvelopeRejectReason =
  | "unknown_version"
  | "absent_tenant"
  | "malformed_id"
  | "malformed_job";

export type ParseDigestEnvelopeResult =
  | { ok: true; envelope: DigestEnvelopeV1 }
  | { ok: false; reason: DigestEnvelopeRejectReason };

const DAILY_PERIOD = /^\d{4}-\d{2}-\d{2}$/;
const WEEKLY_PERIOD = /^\d{4}-W\d{2}$/;

const DigestEnvelopeV1Schema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().min(1),
    userId: z.string().min(1),
    period_key: z.string().min(1),
    cadence: z.enum(["daily", "weekly"]),
  })
  .strip();

export function parseDigestEnvelope(body: unknown): ParseDigestEnvelopeResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "unknown_version" };
  }
  const record = body as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, reason: "unknown_version" };
  }
  if (record.tenantId == null || record.tenantId === "" || record.userId == null || record.userId === "") {
    return { ok: false, reason: "absent_tenant" };
  }

  const parsed = DigestEnvelopeV1Schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: "malformed_job" };
  }
  const tenantId = parseTenantId(parsed.data.tenantId);
  const userId = parseUserId(parsed.data.userId);
  if (!tenantId || !userId || tenantId !== (userId as unknown as TenantId)) {
    return { ok: false, reason: "malformed_id" };
  }
  const periodOk =
    parsed.data.cadence === "daily"
      ? DAILY_PERIOD.test(parsed.data.period_key)
      : WEEKLY_PERIOD.test(parsed.data.period_key);
  if (!periodOk) {
    return { ok: false, reason: "malformed_job" };
  }
  return {
    ok: true,
    envelope: {
      version: 1,
      tenantId,
      userId,
      period_key: parsed.data.period_key,
      cadence: parsed.data.cadence,
    },
  };
}

export function digestEnvelopeV1(input: {
  tenantId: TenantId;
  userId: UserId;
  period_key: string;
  cadence: "daily" | "weekly";
}): DigestEnvelopeV1 {
  return {
    version: 1,
    tenantId: input.tenantId,
    userId: input.userId,
    period_key: input.period_key,
    cadence: input.cadence,
  };
}

export const DIGEST_ENVELOPE_REJECTED_EVENT = "digest_envelope_rejected";

export function logDigestEnvelopeRejected(reason: DigestEnvelopeRejectReason): void {
  console.error(
    JSON.stringify({
      severity: "high",
      event: DIGEST_ENVELOPE_REJECTED_EVENT,
      reason,
    }),
  );
}
