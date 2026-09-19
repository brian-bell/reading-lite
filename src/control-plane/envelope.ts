import { z } from "zod";
import type { ProcessReadingArgs } from "../attempt-ownership";
import { buildKeyPrefix } from "../modules/stores/reading-store";
import { parseReadingId, sha256Hex } from "../services";
import { ProcessingAttemptTriggerSchema, SourceTypeSchema } from "../schemas/manifest";
import type { ControlPlaneDb } from "./db";
import { parseSessionId, parseTenantId, parseTokenId, type TenantContext, type TenantId } from "./ids";
import type { AuthenticatedPrincipal } from "./principal";

export interface ProcessReadingEnvelopeV1 {
  version: 1;
  tenant: { tenantId: TenantId };
  actor:
    | { kind: "session"; credentialId: string }
    | { kind: "api_token"; credentialId: string }
    | { kind: "operator"; operationId: string };
  job: ProcessReadingArgs;
}

export type EnvelopeRejectReason = "unknown_version" | "absent_tenant" | "malformed_id" | "malformed_job";

export type ParseEnvelopeResult =
  | { ok: true; envelope: ProcessReadingEnvelopeV1 }
  | { ok: false; reason: EnvelopeRejectReason };

const ProcessReadingSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url") }),
  z.object({
    kind: z.literal("markdown"),
    markdown: z.string(),
    title: z.string().optional(),
  }),
]);

const ProcessReadingArgsSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().min(1),
    urlHash: z.string().min(1),
    createdAt: z.string().min(1),
    keyPrefix: z.string().min(1),
    source: ProcessReadingSourceSchema.optional(),
    attemptId: z.string().min(1).optional(),
    attemptStartedAt: z.string().min(1).optional(),
    trigger: ProcessingAttemptTriggerSchema.optional(),
    sourceTypeOnFailure: SourceTypeSchema.optional(),
    email: z.boolean().optional(),
  })
  .strip();

const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), credentialId: z.string().min(1) }),
  z.object({ kind: z.literal("api_token"), credentialId: z.string().min(1) }),
  z.object({ kind: z.literal("operator"), operationId: z.string().min(1) }),
]);

const EnvelopeV1Schema = z
  .object({
    version: z.literal(1),
    tenant: z.object({ tenantId: z.string().min(1) }),
    actor: ActorSchema,
    job: ProcessReadingArgsSchema,
  })
  .strip();

export function parseProcessReadingEnvelope(body: unknown): ParseEnvelopeResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "unknown_version" };
  }
  const record = body as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, reason: "unknown_version" };
  }
  if (record.tenant == null) {
    return { ok: false, reason: "absent_tenant" };
  }
  if (typeof record.tenant !== "object" || !("tenantId" in record.tenant) || record.tenant.tenantId == null || record.tenant.tenantId === "") {
    return { ok: false, reason: "absent_tenant" };
  }
  if (!parseTenantId(String(record.tenant.tenantId))) {
    return { ok: false, reason: "malformed_id" };
  }
  if (!actorIdsValid(record.actor)) {
    return { ok: false, reason: "malformed_id" };
  }

  const parsed = EnvelopeV1Schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: "malformed_job" };
  }
  const tenantId = parseTenantId(parsed.data.tenant.tenantId);
  if (!tenantId) {
    return { ok: false, reason: "malformed_id" };
  }
  return {
    ok: true,
    envelope: {
      version: 1,
      tenant: { tenantId },
      actor: parsed.data.actor,
      job: parsed.data.job,
    },
  };
}

export type AdmitEnvelopeResult =
  | { ok: true; tenant: TenantContext }
  | { ok: false; reason: "tenant_inactive" | "token_unusable" };

export async function admitProcessReadingEnvelope(
  db: ControlPlaneDb,
  envelope: ProcessReadingEnvelopeV1,
  nowMs: number,
): Promise<AdmitEnvelopeResult> {
  if (envelope.actor.kind !== "api_token" && envelope.actor.kind !== "session") {
    return { ok: false, reason: "token_unusable" };
  }

  const user = await db.first<{ id: string; status: string }>(
    "SELECT id, status FROM users WHERE id = ?",
    envelope.tenant.tenantId,
  );
  if (!user || user.status !== "active") {
    return { ok: false, reason: "tenant_inactive" };
  }

  if (envelope.actor.kind === "api_token") {
    const token = await db.first<{
      id: string;
      user_id: string;
      expires_at_ms: number;
      revoked_at_ms: number | null;
    }>(
      "SELECT id, user_id, expires_at_ms, revoked_at_ms FROM api_tokens WHERE id = ?",
      envelope.actor.credentialId,
    );
    if (
      !token ||
      token.user_id !== user.id ||
      token.revoked_at_ms != null ||
      token.expires_at_ms <= nowMs
    ) {
      return { ok: false, reason: "token_unusable" };
    }
    const requiredScope =
      envelope.job.trigger === "import" ? "readings:import" : "readings:write";
    const required = await db.first<{ scope: string }>(
      "SELECT scope FROM api_token_scopes WHERE token_id = ? AND scope = ?",
      token.id,
      requiredScope,
    );
    if (!required) {
      return { ok: false, reason: "token_unusable" };
    }
  }

  if (envelope.actor.kind === "session") {
    const session = await db.first<{
      user_id: string;
      revoked_at_ms: number | null;
      idle_expires_at_ms: number;
      absolute_expires_at_ms: number;
    }>(
      "SELECT user_id, revoked_at_ms, idle_expires_at_ms, absolute_expires_at_ms FROM sessions WHERE id = ?",
      envelope.actor.credentialId,
    );
    if (
      !session ||
      session.user_id !== user.id ||
      session.revoked_at_ms != null ||
      session.idle_expires_at_ms <= nowMs ||
      session.absolute_expires_at_ms <= nowMs
    ) {
      return { ok: false, reason: "token_unusable" };
    }
  }

  return { ok: true, tenant: { tenantId: envelope.tenant.tenantId } };
}

export const ENVELOPE_REJECTED_EVENT = "queue_envelope_rejected";

export function logEnvelopeRejected(reason: EnvelopeRejectReason): void {
  console.error(
    JSON.stringify({
      severity: "high",
      event: ENVELOPE_REJECTED_EVENT,
      reason,
    }),
  );
}

export async function consumeProcessReadingMessage(
  msg: { body: unknown; ack: () => void },
  deps: {
    db: ControlPlaneDb;
    nowMs: number;
    process: (job: ProcessReadingArgs, tenant: TenantContext) => Promise<void>;
  },
): Promise<void> {
  const parsed = parseProcessReadingEnvelope(msg.body);
  if (!parsed.ok) {
    logEnvelopeRejected(parsed.reason);
    msg.ack();
    return;
  }
  const admitted = await admitEnvelopeOrReject(deps.db, parsed.envelope, deps.nowMs);
  if (!admitted.ok) {
    if ("reason" in admitted && admitted.reason === "malformed_job") {
      logEnvelopeRejected("malformed_job");
    }
    msg.ack();
    return;
  }
  await deps.process(parsed.envelope.job, admitted.tenant);
}

export function envelopeFromPrincipal(
  principal: AuthenticatedPrincipal,
  job: ProcessReadingArgs,
): ProcessReadingEnvelopeV1 {
  return {
    version: 1,
    tenant: { tenantId: principal.tenantId },
    actor:
      principal.kind === "session"
        ? { kind: "session", credentialId: principal.sessionId }
        : { kind: "api_token", credentialId: principal.tokenId },
    job,
  };
}

function actorIdsValid(actor: unknown): boolean {
  if (actor === null || typeof actor !== "object" || !("kind" in actor)) return false;
  const rec = actor as Record<string, unknown>;
  if (rec.kind === "api_token") {
    return typeof rec.credentialId === "string" && parseTokenId(rec.credentialId) !== null;
  }
  if (rec.kind === "session") {
    return typeof rec.credentialId === "string" && parseSessionId(rec.credentialId) !== null;
  }
  if (rec.kind === "operator") {
    return typeof rec.operationId === "string" && rec.operationId.length > 0;
  }
  return false;
}

const URL_HASH_RE = /^[0-9a-f]{64}$/;

export async function validateEnvelopeJob(job: ProcessReadingArgs): Promise<boolean> {
  if (!parseReadingId(job.id)) return false;
  if (!URL_HASH_RE.test(job.urlHash)) return false;
  if (job.url.trim().length === 0) return false;
  const expectedHash = await sha256Hex(job.url);
  if (expectedHash !== job.urlHash) return false;
  try {
    const expectedPrefix = buildKeyPrefix(job.id, job.createdAt);
    if (job.keyPrefix !== expectedPrefix) return false;
  } catch {
    return false;
  }
  if (job.attemptId !== undefined && job.attemptId.length === 0) return false;
  return true;
}

export async function admitEnvelopeOrReject(
  db: ControlPlaneDb,
  envelope: ProcessReadingEnvelopeV1,
  nowMs: number,
): Promise<AdmitEnvelopeResult | { ok: false; reason: EnvelopeRejectReason }> {
  if (!(await validateEnvelopeJob(envelope.job))) {
    return { ok: false, reason: "malformed_job" };
  }
  const admitted = await admitProcessReadingEnvelope(db, envelope, nowMs);
  return admitted;
}
