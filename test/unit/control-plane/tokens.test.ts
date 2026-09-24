import { describe, expect, it } from "vitest";
import { authenticateBearer } from "../../../src/control-plane/authenticate";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import {
  MAX_ACTIVE_TOKENS,
  TOKEN_MAX_TTL_MS,
  TOKEN_NAME_MAX,
} from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { parseUserId } from "../../../src/control-plane/ids";
import { API_SCOPES } from "../../../src/control-plane/principal";
import {
  countActiveApiTokens,
  createApiToken,
  listApiTokensForUser,
  revokeOwnedApiToken,
} from "../../../src/control-plane/tokens";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";
import { toTimestamp } from "../../../src/control-plane/pg-time";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };
const TOKEN_UUID = "770e8400-e29b-41d4-a716-446655440000";
const SECRET_BYTES = new Uint8Array(32).fill(0xab);

async function seeded() {
  const { raw, db } = openControlPlane();
  const founder = await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  const userId = parseUserId(founder.userId);
  if (!userId) throw new Error("expected founder id");
  return { raw, db, founder, userId };
}

describe("createApiToken", () => {
  it("mints a standard tok_.hex credential once and never stores the secret", async () => {
    const { raw, db, userId } = await seeded();
    const created = await createApiToken(db, {
      userId,
      name: "  ops  ",
      scopes: ["readings:write", "readings:read", "readings:delete", "readings:import", "readings:read"],
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "vitest",
      newUuid: () => TOKEN_UUID,
      randomBytes: () => SECRET_BYTES,
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    expect(created.created).toEqual({
      token: `tok_${TOKEN_UUID}.${"ab".repeat(32)}`,
      id: `tok_${TOKEN_UUID}`,
      name: "ops",
      scopes: ["readings:delete", "readings:import", "readings:read", "readings:write"],
      created_at_ms: NOW_MS,
      expires_at_ms: NOW_MS + TOKEN_MAX_TTL_MS,
    });

    const row = withMs(await raw.first("SELECT * FROM api_tokens WHERE id = ?", created.created.id)) as Record<
      string,
      unknown
    >;
    expect(row.format).toBe("standard");
    expect(JSON.stringify(row)).not.toContain(created.created.token);
    expect(JSON.stringify(row)).not.toContain("ab".repeat(32));
    expect(row.secret_hmac).not.toBe("ab".repeat(32));

    const scopes = withMs(await raw.all(
      "SELECT scope FROM api_token_scopes WHERE token_id = ? ORDER BY scope",
      created.created.id,
    )) as { scope: string }[];
    expect(scopes.map((s) => s.scope)).toEqual([...API_SCOPES].sort());
  });

  it("rejects empty, unknown, blank, oversized, or over-TTL input", async () => {
    const { db, userId } = await seeded();
    const base = {
      userId,
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: null as string | null,
    };
    expect(await createApiToken(db, { ...base, name: "ok", scopes: [] })).toEqual({ kind: "invalid_scopes" });
    expect(await createApiToken(db, { ...base, name: "ok", scopes: ["readings:read", "admin"] })).toEqual({
      kind: "invalid_scopes",
    });
    expect(await createApiToken(db, { ...base, name: "   ", scopes: ["readings:read"] })).toEqual({
      kind: "invalid_name",
    });
    expect(
      await createApiToken(db, { ...base, name: "n".repeat(TOKEN_NAME_MAX + 1), scopes: ["readings:read"] }),
    ).toEqual({ kind: "invalid_name" });
    expect(
      await createApiToken(db, {
        ...base,
        name: "ok",
        scopes: ["readings:read"],
        expiresAtMs: NOW_MS + TOKEN_MAX_TTL_MS + 1,
      }),
    ).toEqual({ kind: "invalid_expiry" });
    expect(
      await createApiToken(db, {
        ...base,
        name: "ok",
        scopes: ["readings:read"],
        expiresAtMs: NOW_MS,
      }),
    ).toEqual({ kind: "invalid_expiry" });
  });

  it("409s at 10 active tokens including the founder legacy row", async () => {
    const { raw, db, userId, founder } = await seeded();
    expect(await countActiveApiTokens(db, { userId, nowMs: NOW_MS })).toBe(1);

    for (let i = 0; i < MAX_ACTIVE_TOKENS - 1; i += 1) {
      const minted = await createApiToken(db, {
        userId,
        name: `t${i}`,
        scopes: ["readings:read"],
        nowMs: NOW_MS + i,
        authRoot,
        userAgentLabel: null,
        newUuid: () => `770e8400-e29b-41d4-a716-44665544000${i}`,
      });
      expect(minted.kind).toBe("ok");
    }
    expect(await countActiveApiTokens(db, { userId, nowMs: NOW_MS })).toBe(MAX_ACTIVE_TOKENS);

    const blocked = await createApiToken(db, {
      userId,
      name: "eleventh",
      scopes: ["readings:read"],
      nowMs: NOW_MS + 20,
      authRoot,
      userAgentLabel: null,
      newUuid: () => "880e8400-e29b-41d4-a716-446655440000",
    });
    expect(blocked).toEqual({ kind: "cap" });
    expect(withMs(await raw.first("SELECT COUNT(*) AS n FROM api_tokens"))).toEqual({ n: MAX_ACTIVE_TOKENS });

    await raw.run("UPDATE api_tokens SET expires_at = ? WHERE id = ?", toTimestamp(NOW_MS), founder.tokenId);
    const afterExpiry = await createApiToken(db, {
      userId,
      name: "after-expiry",
      scopes: ["readings:read"],
      nowMs: NOW_MS + 20,
      authRoot,
      userAgentLabel: null,
      newUuid: () => "880e8400-e29b-41d4-a716-446655440000",
    });
    expect(afterExpiry.kind).toBe("ok");
  });

});

describe("listApiTokensForUser", () => {
  it("omits secrets and marks revoked or expired rows unusable", async () => {
    const { raw, db, userId, founder } = await seeded();
    const created = await createApiToken(db, {
      userId,
      name: "ops",
      scopes: ["readings:read"],
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "vitest",
      newUuid: () => TOKEN_UUID,
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;

    await raw.run("UPDATE api_tokens SET expires_at = ? WHERE id = ?", toTimestamp(NOW_MS), founder.tokenId);

    const listed = await listApiTokensForUser(db, { userId, nowMs: NOW_MS });
    expect(JSON.stringify(listed)).not.toContain(created.created.token);
    expect(listed.tokens.find((row) => row.id === created.created.id)).toMatchObject({
      name: "ops",
      format: "standard",
      scopes: ["readings:read"],
      usable: true,
      revoked_at_ms: null,
      last_used_at_ms: null,
      user_agent_label: "vitest",
    });
    expect(listed.tokens.find((row) => row.id === founder.tokenId)).toMatchObject({
      format: "legacy",
      usable: false,
    });
  });
});

describe("revokeOwnedApiToken", () => {
  it("soft-revokes an owned token and 404s another user's id", async () => {
    const { raw, db, userId } = await seeded();
    const created = await createApiToken(db, {
      userId,
      name: "ops",
      scopes: ["readings:read"],
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: null,
      newUuid: () => TOKEN_UUID,
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;

    expect(await revokeOwnedApiToken(db, { tokenId: created.created.id, userId, nowMs: NOW_MS + 5 })).toBe("ok");
    const row = withMs(await raw.first("SELECT revoked_at FROM api_tokens WHERE id = ?", created.created.id)) as {
      revoked_at_ms: number | null;
    };
    expect(row.revoked_at_ms).toBe(NOW_MS + 5);
    expect(await revokeOwnedApiToken(db, { tokenId: created.created.id, userId, nowMs: NOW_MS + 9 })).toBe("ok");
    expect(
      withMs(await raw.first("SELECT revoked_at FROM api_tokens WHERE id = ?", created.created.id)),
    ).toEqual({ revoked_at_ms: NOW_MS + 5 });

    const other = parseUserId("usr_11111111-1111-4111-8111-111111111111");
    if (!other) throw new Error("expected other user");
    expect(await revokeOwnedApiToken(db, { tokenId: created.created.id, userId: other, nowMs: NOW_MS })).toBe(
      "not_found",
    );
    expect(await revokeOwnedApiToken(db, { tokenId: "not-a-token", userId, nowMs: NOW_MS })).toBe("not_found");

    const auth = await authenticateBearer(db, {
      authorization: `Bearer ${created.created.token}`,
      authRoot,
      nowMs: NOW_MS + 5,
    });
    expect(auth.kind).toBe("unauthenticated");
  });
});
