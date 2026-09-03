/**
 * ACCOUNT_WIPE_JOBS envelope v1. Cron fan-out starts one message per deleting
 * tenant past the grace window, or resumes in-progress/leftover wipes even
 * during grace (preserving `force` from progress.json). An operator may
 * enqueue the same shape with `force: true` to skip grace on a new wipe.
 * The body carries only identity and the force flag — no email, no object
 * keys. Continuation cursors live in R2 (`wipe/{tenantId}/progress.json`),
 * not in the message, so a crash redrive resumes without mutating the
 * queue payload.
 */
import { z } from "zod";
import { parseTenantId, parseUserId, type TenantId } from "./ids";

export interface AccountWipeEnvelopeV1 {
  version: 1;
  tenantId: TenantId;
  force: boolean;
}

export type AccountWipeEnvelopeRejectReason =
  | "unknown_version"
  | "absent_tenant"
  | "malformed_id"
  | "malformed_job";

export type ParseAccountWipeEnvelopeResult =
  | { ok: true; envelope: AccountWipeEnvelopeV1 }
  | { ok: false; reason: AccountWipeEnvelopeRejectReason };

const AccountWipeEnvelopeV1Schema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().min(1),
    force: z.boolean().optional(),
  })
  .strip();

export function parseAccountWipeEnvelope(body: unknown): ParseAccountWipeEnvelopeResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "unknown_version" };
  }
  const record = body as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, reason: "unknown_version" };
  }
  if (record.tenantId == null || record.tenantId === "") {
    return { ok: false, reason: "absent_tenant" };
  }

  const parsed = AccountWipeEnvelopeV1Schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: "malformed_job" };
  }
  const tenantId = parseTenantId(parsed.data.tenantId);
  const userId = parseUserId(parsed.data.tenantId);
  if (!tenantId || !userId) {
    return { ok: false, reason: "malformed_id" };
  }
  return {
    ok: true,
    envelope: {
      version: 1,
      tenantId,
      force: parsed.data.force === true,
    },
  };
}

export function accountWipeEnvelopeV1(input: {
  tenantId: TenantId;
  force?: boolean;
}): AccountWipeEnvelopeV1 {
  return {
    version: 1,
    tenantId: input.tenantId,
    force: input.force === true,
  };
}

export const ACCOUNT_WIPE_ENVELOPE_REJECTED_EVENT = "account_wipe_envelope_rejected";

export function logAccountWipeEnvelopeRejected(reason: AccountWipeEnvelopeRejectReason): void {
  console.error(
    JSON.stringify({
      severity: "high",
      event: ACCOUNT_WIPE_ENVELOPE_REJECTED_EVENT,
      reason,
    }),
  );
}
