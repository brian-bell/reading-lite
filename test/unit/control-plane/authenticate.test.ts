import { describe, expect, it } from "vitest";
import { authenticateBearer } from "../../../src/control-plane/authenticate";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { API_SCOPES } from "../../../src/control-plane/principal";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function seeded(root = authRoot) {
  const { sqlite, db } = openMigratedControlPlane();
  const founder = await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: root,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { sqlite, db, founder };
}

describe("authenticateBearer", () => {
  it("authenticates the imported legacy token as the founder", async () => {
    const { db, founder } = await seeded();
    const result = await authenticateBearer(db, {
      authorization: "Bearer test-token",
      authRoot,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      kind: "ok",
      principal: {
        kind: "api_token",
        tenantId: founder.userId,
        userId: founder.userId,
        tokenId: founder.tokenId,
        scopes: new Set(API_SCOPES),
      },
    });
  });

  it("rejects a missing, malformed, or unknown bearer", async () => {
    const { db } = await seeded();
    const env = { authRoot, nowMs: NOW_MS };
    expect(await authenticateBearer(db, { authorization: undefined, ...env })).toEqual({
      kind: "unauthenticated",
    });
    expect(await authenticateBearer(db, { authorization: "Basic x", ...env })).toEqual({
      kind: "unauthenticated",
    });
    expect(await authenticateBearer(db, { authorization: "Bearer wrong", ...env })).toEqual({
      kind: "unauthenticated",
    });
  });

  it("forbids a suspended founder", async () => {
    const { sqlite, db } = await seeded();
    sqlite.prepare("UPDATE users SET status = 'suspended' WHERE email_canonical = ?").run(
      "founder@example.com",
    );
    expect(
      await authenticateBearer(db, {
        authorization: "Bearer test-token",
        authRoot,
        nowMs: NOW_MS,
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("rejects an expired or revoked token", async () => {
    const { sqlite, db } = await seeded();
    sqlite.prepare("UPDATE api_tokens SET expires_at_ms = ?").run(NOW_MS - 1);
    expect(
      await authenticateBearer(db, {
        authorization: "Bearer test-token",
        authRoot,
        nowMs: NOW_MS,
      }),
    ).toEqual({ kind: "unauthenticated" });

    sqlite.prepare("UPDATE api_tokens SET expires_at_ms = ?, revoked_at_ms = ?").run(
      NOW_MS + 1000,
      NOW_MS,
    );
    expect(
      await authenticateBearer(db, {
        authorization: "Bearer test-token",
        authRoot,
        nowMs: NOW_MS,
      }),
    ).toEqual({ kind: "unauthenticated" });
  });

  it("authenticates a standard selector.secret token", async () => {
    const { sqlite, db, founder } = await seeded();
    const key = await deriveHmacKey(authRoot, "api_token");
    const secretHmac = await hmacHex(key, "super-secret");
    sqlite
      .prepare(
        `INSERT INTO api_tokens (
           id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
         ) VALUES (?, ?, 'std', 'standard', ?, 1, ?, ?)`,
      )
      .run(
        "tok_770e8400-e29b-41d4-a716-446655440000",
        founder.userId,
        secretHmac,
        NOW_MS,
        NOW_MS + 60_000,
      );
    sqlite
      .prepare("INSERT INTO api_token_scopes (token_id, scope) VALUES (?, 'readings:read')")
      .run("tok_770e8400-e29b-41d4-a716-446655440000");

    const result = await authenticateBearer(db, {
      authorization: "Bearer tok_770e8400-e29b-41d4-a716-446655440000.super-secret",
      authRoot,
      nowMs: NOW_MS,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.principal.kind).toBe("api_token");
    if (result.principal.kind !== "api_token") return;
    expect(result.principal.tokenId).toBe("tok_770e8400-e29b-41d4-a716-446655440000");
    expect([...result.principal.scopes]).toEqual(["readings:read"]);
  });

  it("re-HMACs a legacy token authenticated under the previous auth root", async () => {
    const previousAuthRoot = {
      secret: parseAuthRootSecret("ff".repeat(32)),
      version: 0,
    };
    const { sqlite, db, founder } = await seeded(previousAuthRoot);
    const previousHmac = sqlite.prepare("SELECT secret_hmac, hash_key_version FROM api_tokens WHERE id = ?").get(
      founder.tokenId,
    ) as { secret_hmac: string; hash_key_version: number };
    expect(previousHmac.hash_key_version).toBe(0);

    const result = await authenticateBearer(db, {
      authorization: "Bearer test-token",
      authRoot,
      previousAuthRoot,
      nowMs: NOW_MS,
    });
    expect(result.kind).toBe("ok");

    const rotated = sqlite.prepare("SELECT secret_hmac, hash_key_version FROM api_tokens WHERE id = ?").get(
      founder.tokenId,
    ) as { secret_hmac: string; hash_key_version: number };
    const expected = await hmacHex(await deriveHmacKey(authRoot, "api_token"), "test-token");
    expect(rotated.secret_hmac).toBe(expected);
    expect(rotated.secret_hmac).not.toBe(previousHmac.secret_hmac);
    expect(rotated.hash_key_version).toBe(1);

    const after = await authenticateBearer(db, {
      authorization: "Bearer test-token",
      authRoot,
      nowMs: NOW_MS,
    });
    expect(after.kind).toBe("ok");
  });

  it("falls back to legacy lookup when a token-shaped secret was imported as legacy", async () => {
    const { db } = openMigratedControlPlane();
    const tokenId = "tok_550e8400-e29b-41d4-a716-446655440000";
    const legacyToken = `${tokenId}.imported-secret`;
    const founder = await bootstrapFounder(db, {
      email: "founder@example.com",
      legacyToken,
      signupMode: "open",
      nowMs: NOW_MS,
      authRoot,
      newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
      newTokenId: () => tokenId,
    });

    const result = await authenticateBearer(db, {
      authorization: `Bearer ${legacyToken}`,
      authRoot,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      kind: "ok",
      principal: {
        kind: "api_token",
        tenantId: founder.userId,
        userId: founder.userId,
        tokenId: founder.tokenId,
        scopes: new Set(API_SCOPES),
      },
    });
  });

  it("re-HMACs a standard token authenticated under the previous auth root", async () => {
    const previousAuthRoot = {
      secret: parseAuthRootSecret("ff".repeat(32)),
      version: 0,
    };
    const { sqlite, db, founder } = await seeded();
    const tokenId = "tok_770e8400-e29b-41d4-a716-446655440000";
    const previousHmac = await hmacHex(await deriveHmacKey(previousAuthRoot, "api_token"), "super-secret");
    sqlite
      .prepare(
        `INSERT INTO api_tokens (
           id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
         ) VALUES (?, ?, 'std', 'standard', ?, 0, ?, ?)`,
      )
      .run(tokenId, founder.userId, previousHmac, NOW_MS, NOW_MS + 60_000);
    sqlite.prepare("INSERT INTO api_token_scopes (token_id, scope) VALUES (?, 'readings:read')").run(tokenId);

    const result = await authenticateBearer(db, {
      authorization: `Bearer ${tokenId}.super-secret`,
      authRoot,
      previousAuthRoot,
      nowMs: NOW_MS,
    });
    expect(result.kind).toBe("ok");

    const rotated = sqlite.prepare("SELECT secret_hmac, hash_key_version FROM api_tokens WHERE id = ?").get(
      tokenId,
    ) as { secret_hmac: string; hash_key_version: number };
    expect(rotated.secret_hmac).toBe(await hmacHex(await deriveHmacKey(authRoot, "api_token"), "super-secret"));
    expect(rotated.hash_key_version).toBe(1);
  });
});
