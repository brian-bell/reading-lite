import { describe, expect, it, vi } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import {
  admitProcessReadingEnvelope,
  consumeProcessReadingMessage,
  envelopeFromPrincipal,
  parseProcessReadingEnvelope,
  type ProcessReadingEnvelopeV1,
} from "../../../src/control-plane/envelope";
import { parseTenantId, parseTokenId, parseUserId } from "../../../src/control-plane/ids";
import { createApiTokenPrincipal, createSessionPrincipal } from "../../../src/control-plane/principal";
import type { ProcessReadingArgs } from "../../../src/process-reading";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";
const READING_ID = "rd_0123456789";
const JOB_URL = "https://example.com/x";
const JOB_CREATED = "2026-08-16T12:00:00.000Z";
const JOB_URL_HASH = "54cef8f42f3f31ad349075022cd36ce1a378d039c1df7af45d61d693d9a35c6a";

function job(overrides: Partial<ProcessReadingArgs> = {}): ProcessReadingArgs {
  return {
    id: READING_ID,
    url: JOB_URL,
    urlHash: JOB_URL_HASH,
    createdAt: JOB_CREATED,
    keyPrefix: buildKeyPrefix(READING_ID, JOB_CREATED),
    attemptId: "at_0123456789",
    trigger: "submit",
    email: false,
    ...overrides,
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    tenant: { tenantId: TENANT },
    actor: { kind: "api_token", credentialId: TOKEN },
    job: job(),
    ...overrides,
  };
}

describe("parseProcessReadingEnvelope", () => {
  it("accepts a v1 envelope with tenant, actor, and job and strips scopes", () => {
    const parsed = parseProcessReadingEnvelope({
      ...validEnvelope(),
      scopes: ["readings:write"],
      token: "secret-should-not-survive",
    });
    expect(parsed).toEqual({
      ok: true,
      envelope: {
        version: 1,
        tenant: { tenantId: TENANT },
        actor: { kind: "api_token", credentialId: TOKEN },
        job: job(),
      },
    });
    if (parsed.ok) {
      expect(parsed.envelope).not.toHaveProperty("scopes");
      expect(parsed.envelope).not.toHaveProperty("token");
    }
  });

  it("rejects unversioned legacy ProcessReadingArgs as unknown_version", () => {
    expect(parseProcessReadingEnvelope(job())).toEqual({
      ok: false,
      reason: "unknown_version",
    });
  });

  it("rejects an unknown envelope version", () => {
    expect(parseProcessReadingEnvelope(validEnvelope({ version: 2 }))).toEqual({
      ok: false,
      reason: "unknown_version",
    });
  });

  it("rejects a missing tenant identity", () => {
    const { tenant: _tenant, ...rest } = validEnvelope();
    expect(parseProcessReadingEnvelope(rest)).toEqual({
      ok: false,
      reason: "absent_tenant",
    });
    expect(parseProcessReadingEnvelope(validEnvelope({ tenant: {} }))).toEqual({
      ok: false,
      reason: "absent_tenant",
    });
  });

  it("rejects malformed prefixed tenant and actor IDs", () => {
    expect(
      parseProcessReadingEnvelope(validEnvelope({ tenant: { tenantId: "not-a-tenant" } })),
    ).toEqual({ ok: false, reason: "malformed_id" });
    expect(
      parseProcessReadingEnvelope(
        validEnvelope({ actor: { kind: "api_token", credentialId: "tok_not-a-uuid" } }),
      ),
    ).toEqual({ ok: false, reason: "malformed_id" });
    expect(
      parseProcessReadingEnvelope(
        validEnvelope({ actor: { kind: "session", credentialId: "not-a-session" } }),
      ),
    ).toEqual({ ok: false, reason: "malformed_id" });
  });
});

describe("envelopeFromPrincipal", () => {
  it("wraps a job with the api_token principal's tenant and token id", () => {
    const principal = createApiTokenPrincipal({
      tenantId: parseTenantId(TENANT)!,
      userId: parseUserId(TENANT)!,
      tokenId: parseTokenId(TOKEN)!,
      scopes: ["readings:read", "readings:write"],
    });
    const envelope = envelopeFromPrincipal(principal, job());
    expect(envelope).toEqual({
      version: 1,
      tenant: { tenantId: TENANT },
      actor: { kind: "api_token", credentialId: TOKEN },
      job: job(),
    });
    expect(envelope).not.toHaveProperty("scopes");
  });

  it("wraps a job with the session principal's session id", () => {
    const principal = createSessionPrincipal({
      tenantId: TENANT,
      userId: TENANT,
      sessionId: SESSION,
      authenticatedAtMs: 1,
    });
    expect(envelopeFromPrincipal(principal, job()).actor).toEqual({
      kind: "session",
      credentialId: SESSION,
    });
  });
});

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function seededFounder() {
  const { sqlite, db } = openMigratedControlPlane();
  const founder = await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => TENANT,
    newTokenId: () => TOKEN,
  });
  return { sqlite, db, founder };
}

function founderEnvelope(
  overrides: Partial<ProcessReadingEnvelopeV1> = {},
): ProcessReadingEnvelopeV1 {
  return {
    version: 1,
    tenant: { tenantId: parseTenantId(TENANT)! },
    actor: { kind: "api_token", credentialId: TOKEN },
    job: job(),
    ...overrides,
  };
}

describe("admitProcessReadingEnvelope", () => {
  it("admits an active founder tenant and api_token with readings:write", async () => {
    const { db, founder } = await seededFounder();
    await expect(admitProcessReadingEnvelope(db, founderEnvelope(), NOW_MS)).resolves.toEqual({
      ok: true,
      tenant: { tenantId: founder.userId },
    });
  });

  it("rejects a missing or inactive tenant before processing", async () => {
    const { sqlite, db } = await seededFounder();
    const missing = founderEnvelope({
      tenant: { tenantId: parseTenantId("usr_11111111-1111-4111-8111-111111111111")! },
    });
    await expect(admitProcessReadingEnvelope(db, missing, NOW_MS)).resolves.toEqual({
      ok: false,
      reason: "tenant_inactive",
    });

    sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(TENANT);
    await expect(admitProcessReadingEnvelope(db, founderEnvelope(), NOW_MS)).resolves.toEqual({
      ok: false,
      reason: "tenant_inactive",
    });
  });

  it("rejects a revoked, expired, or write-scopeless api_token", async () => {
    const { sqlite, db } = await seededFounder();
    sqlite.prepare("UPDATE api_tokens SET revoked_at_ms = ?").run(NOW_MS);
    await expect(admitProcessReadingEnvelope(db, founderEnvelope(), NOW_MS)).resolves.toEqual({
      ok: false,
      reason: "token_unusable",
    });

    sqlite.prepare("UPDATE api_tokens SET revoked_at_ms = NULL, expires_at_ms = ?").run(NOW_MS - 1);
    await expect(admitProcessReadingEnvelope(db, founderEnvelope(), NOW_MS)).resolves.toEqual({
      ok: false,
      reason: "token_unusable",
    });

    sqlite.prepare("UPDATE api_tokens SET expires_at_ms = ?").run(NOW_MS + 60_000);
    sqlite.prepare("DELETE FROM api_token_scopes WHERE token_id = ? AND scope = 'readings:write'").run(TOKEN);
    await expect(admitProcessReadingEnvelope(db, founderEnvelope(), NOW_MS)).resolves.toEqual({
      ok: false,
      reason: "token_unusable",
    });
  });

  it("rejects session and operator actors until their authority can be verified", async () => {
    const { db } = await seededFounder();
    await expect(
      admitProcessReadingEnvelope(
        db,
        founderEnvelope({ actor: { kind: "session", credentialId: SESSION } }),
        NOW_MS,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "token_unusable",
    });
    await expect(
      admitProcessReadingEnvelope(
        db,
        founderEnvelope({ actor: { kind: "operator", operationId: "op_bootstrap" } }),
        NOW_MS,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "token_unusable",
    });
  });
});

function fakeMessage(body: unknown) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function throwingDb(): ControlPlaneDb {
  const boom = async () => {
    throw new Error("D1 must not be touched before envelope validation");
  };
  return { first: boom, all: boom, batch: boom };
}

describe("consumeProcessReadingMessage", () => {
  it("acks unversioned messages with a redacted high-severity log and never touches D1 or processing", async () => {
    const msg = fakeMessage(job());
    const process = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await consumeProcessReadingMessage(msg, {
      db: throwingDb(),
      nowMs: NOW_MS,
      process,
    });

    expect(process).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(consoleErr).toHaveBeenCalledWith(
      JSON.stringify({
        severity: "high",
        event: "queue_envelope_rejected",
        reason: "unknown_version",
      }),
    );
    consoleErr.mockRestore();
  });

  it("acks malformed tenant IDs without processing", async () => {
    const msg = fakeMessage(validEnvelope({ tenant: { tenantId: "founder" } }));
    const process = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await consumeProcessReadingMessage(msg, {
      db: throwingDb(),
      nowMs: NOW_MS,
      process,
    });

    expect(process).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"malformed_id"'),
    );
    consoleErr.mockRestore();
  });

  it("passes tenant context and job to process for an admitted founder envelope", async () => {
    const { db, founder } = await seededFounder();
    const envelope = founderEnvelope();
    const msg = fakeMessage(envelope);
    const process = vi.fn(async () => {});

    await consumeProcessReadingMessage(msg, {
      db,
      nowMs: NOW_MS,
      process,
    });

    expect(process).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledWith(envelope.job, { tenantId: founder.userId });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("acks an inactive-tenant envelope without processing", async () => {
    const { sqlite, db } = await seededFounder();
    sqlite.prepare("UPDATE users SET status = 'deleting' WHERE id = ?").run(TENANT);
    const msg = fakeMessage(founderEnvelope());
    const process = vi.fn();

    await consumeProcessReadingMessage(msg, {
      db,
      nowMs: NOW_MS,
      process,
    });

    expect(process).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});
