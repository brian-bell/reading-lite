import { describe, expect, it } from "vitest";
import {
  FOUNDER_PLACEHOLDER_LIMITS,
  TOKEN_MAX_TTL_MS,
  bootstrapFounder,
} from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { deriveHmacKey, hmacHex } from "../../../src/control-plane/crypto";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const USER_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TOKEN_UUID = "660e8400-e29b-41d4-a716-446655440000";

function input() {
  return {
    email: "  Founder@Example.com ",
    legacyToken: "test-token",
    signupMode: "open" as const,
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => `usr_${USER_UUID}`,
    newTokenId: () => `tok_${TOKEN_UUID}`,
  };
}

describe("bootstrapFounder", () => {
  it("creates the founder user, defaults, explicit limits, and a 90-day legacy token", async () => {
    const { db } = openMigratedControlPlane();
    const result = await bootstrapFounder(db, input());

    expect(result.userId).toBe(`usr_${USER_UUID}`);
    expect(result.tokenId).toBe(`tok_${TOKEN_UUID}`);
    expect(result.createdUser).toBe(true);
    expect(result.createdToken).toBe(true);

    const user = await db.first<{
      email_canonical: string;
      email_display: string;
      status: string;
    }>("SELECT email_canonical, email_display, status FROM users WHERE id = ?", result.userId);
    expect(user).toEqual({
      email_canonical: "founder@example.com",
      email_display: "Founder@Example.com",
      status: "active",
    });

    const settings = await db.first<{ digest_cadence: string; time_zone: string; notify_immediate: number }>(
      "SELECT digest_cadence, time_zone, notify_immediate FROM user_settings WHERE user_id = ?",
      result.userId,
    );
    expect(settings).toEqual({
      digest_cadence: "off",
      time_zone: "UTC",
      notify_immediate: 1,
    });

    const limits = await db.first<typeof FOUNDER_PLACEHOLDER_LIMITS & { policy_version: number }>(
      "SELECT submissions_per_hour, monthly_readings, max_concurrent_work, daily_spend_microdollars, policy_version FROM tenant_limits WHERE tenant_id = ?",
      result.userId,
    );
    expect(limits).toEqual({ ...FOUNDER_PLACEHOLDER_LIMITS, policy_version: 1 });
    expect(Object.values(FOUNDER_PLACEHOLDER_LIMITS).every((n) => n > 0)).toBe(true);

    const token = await db.first<{
      format: string;
      expires_at_ms: number;
      hash_key_version: number;
    }>(
      "SELECT format, expires_at_ms, hash_key_version FROM api_tokens WHERE id = ?",
      result.tokenId,
    );
    expect(token?.format).toBe("legacy");
    expect(token?.hash_key_version).toBe(1);
    expect(token?.expires_at_ms).toBe(NOW_MS + TOKEN_MAX_TTL_MS);

    const scopes = await db.all<{ scope: string }>(
      "SELECT scope FROM api_token_scopes WHERE token_id = ? ORDER BY scope",
      result.tokenId,
    );
    expect(scopes.map((row) => row.scope)).toEqual([
      "readings:import",
      "readings:read",
      "readings:write",
    ]);

    const policy = await db.first<{ signup_mode: string }>(
      "SELECT signup_mode FROM system_policy WHERE id = 1",
    );
    expect(policy?.signup_mode).toBe("open");
  });

  it("is idempotent and keeps the original founder identity on re-run", async () => {
    const { db } = openMigratedControlPlane();
    const first = await bootstrapFounder(db, input());
    const second = await bootstrapFounder(db, {
      ...input(),
      newUserId: () => "usr_11111111-1111-4111-8111-111111111111",
      newTokenId: () => "tok_11111111-1111-4111-8111-111111111111",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.tokenId).toBe(first.tokenId);
    expect(second.createdUser).toBe(false);
    expect(second.createdToken).toBe(false);

    const users = await db.all<{ id: string }>("SELECT id FROM users");
    const tokens = await db.all<{ id: string }>("SELECT id FROM api_tokens");
    expect(users).toHaveLength(1);
    expect(tokens).toHaveLength(1);
  });

  it("repairs an expired or revoked legacy token on re-run", async () => {
    const { sqlite, db } = openMigratedControlPlane();
    const first = await bootstrapFounder(db, input());
    sqlite.prepare("UPDATE api_tokens SET expires_at_ms = ?, revoked_at_ms = ? WHERE id = ?").run(
      NOW_MS - 1,
      NOW_MS,
      first.tokenId,
    );

    const second = await bootstrapFounder(db, input());
    expect(second.createdToken).toBe(false);

    const token = sqlite
      .prepare("SELECT expires_at_ms, revoked_at_ms FROM api_tokens WHERE id = ?")
      .get(first.tokenId) as { expires_at_ms: number; revoked_at_ms: number | null };
    expect(token.revoked_at_ms).toBeNull();
    expect(token.expires_at_ms).toBe(NOW_MS + TOKEN_MAX_TTL_MS);
  });

  it("plans without writing when apply is false", async () => {
    const { db } = openMigratedControlPlane();
    const result = await bootstrapFounder(db, input(), { apply: false });
    expect(result.createdUser).toBe(true);
    expect(result.createdToken).toBe(true);
    expect(await db.first("SELECT id FROM users LIMIT 1")).toBeNull();
  });

  it("refuses a HMAC that already belongs to a different user", async () => {
    const { sqlite, db } = openMigratedControlPlane();
    await bootstrapFounder(db, input());
    sqlite
      .prepare(
        `INSERT INTO users (
           id, email_canonical, email_display, status,
           email_verified_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, 'other@example.com', 'other@example.com', 'active', ?, ?, ?)`,
      )
      .run("usr_11111111-1111-4111-8111-111111111111", NOW_MS, NOW_MS, NOW_MS);
    sqlite
      .prepare("UPDATE api_tokens SET user_id = ? WHERE id = ?")
      .run("usr_11111111-1111-4111-8111-111111111111", `tok_${TOKEN_UUID}`);

    await expect(bootstrapFounder(db, input())).rejects.toThrow(/different user|owned by a different user/i);

    const scopes = sqlite
      .prepare("SELECT COUNT(*) AS n FROM api_token_scopes WHERE token_id = ?")
      .get(`tok_${TOKEN_UUID}`) as { n: number };
    expect(scopes.n).toBe(3);
    const users = sqlite.prepare("SELECT email_canonical FROM users ORDER BY email_canonical").all() as {
      email_canonical: string;
    }[];
    expect(users.map((row) => row.email_canonical)).toEqual(["founder@example.com", "other@example.com"]);
  });

  it("refuses when the HMAC matches a standard-format token", async () => {
    const { sqlite, db } = openMigratedControlPlane();
    await bootstrapFounder(db, input());
    sqlite.prepare("UPDATE api_tokens SET format = 'standard'").run();

    await expect(bootstrapFounder(db, input())).rejects.toThrow(/non-legacy|standard/i);
  });

  it("refuses to change an existing system_policy signup_mode", async () => {
    const { db } = openMigratedControlPlane();
    await bootstrapFounder(db, input());
    await expect(bootstrapFounder(db, { ...input(), signupMode: "closed" })).rejects.toThrow(
      /signup_mode/,
    );
    const policy = await db.first<{ signup_mode: string }>("SELECT signup_mode FROM system_policy WHERE id = 1");
    expect(policy?.signup_mode).toBe("open");
  });

  it("resolves an existing legacy token stored under the previous auth root", async () => {
    const { db } = openMigratedControlPlane();
    const previousRoot = {
      secret: parseAuthRootSecret(
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      ),
      version: 0,
    };
    const activeRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

    const previousHmac = await hmacHex(
      await deriveHmacKey(previousRoot, "api_token"),
      "test-token",
    );
    await db.batch([
      {
        sql: `INSERT INTO users (
                id, email_canonical, email_display, status,
                email_verified_at_ms, created_at_ms, updated_at_ms
              ) VALUES (?, 'founder@example.com', 'Founder@Example.com', 'active', ?, ?, ?)`,
        params: [`usr_${USER_UUID}`, NOW_MS, NOW_MS, NOW_MS],
      },
      {
        sql: `INSERT INTO api_tokens (
                id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
              ) VALUES (?, ?, 'legacy', 'legacy', ?, 0, ?, ?)`,
        params: [
          `tok_${TOKEN_UUID}`,
          `usr_${USER_UUID}`,
          previousHmac,
          NOW_MS,
          NOW_MS + TOKEN_MAX_TTL_MS,
        ],
      },
    ]);

    const result = await bootstrapFounder(db, {
      ...input(),
      authRoot: activeRoot,
      previousAuthRoot: previousRoot,
    });

    expect(result.tokenId).toBe(`tok_${TOKEN_UUID}`);
    expect(result.createdToken).toBe(false);
    const tokens = await db.all<{ id: string }>("SELECT id FROM api_tokens");
    expect(tokens).toHaveLength(1);
  });
});
