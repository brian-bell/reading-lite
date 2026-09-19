import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import type { SecurityMail } from "../../src/control-plane/security-mail";
import { CSRF_HEADER, EXPECTED_TENANT_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { consumeProcessReadingMessage } from "../../src/control-plane/envelope";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  PUBLIC_LOOKUP,
  insertSecondTenant,
} from "../helpers/tenant-fixtures";
import { testControlPlane } from "../helpers/control-plane-db";
import { toTimestamp } from "../../src/control-plane/pg-time";

const NOW = "2026-08-16T12:00:00.000Z";
const TOKEN_ID = "tok_550e8400-e29b-41d4-a716-446655440000";

function services(now = NOW) {
  return {
    fetch: globalThis.fetch,
    lookup: PUBLIC_LOOKUP,
    now: () => now,
    newId: () => "rd_AUTH01",
  };
}

async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    authorization?: string;
    cookie?: string;
    origin?: string;
    csrf?: string;
    expectedTenant?: string;
    now?: string;
    securityMail?: SecurityMail[];
  } = {},
  workerEnv: Env = env as unknown as Env,
) {
  const sent: MagicLinkMail[] = [];
  const securityMail = init.securityMail ?? [];
  const app = createApp({
    services: services(init.now ?? NOW),
    auth: {
      sendMagicLink: async (message) => {
        sent.push(message);
      },
      sendSecurityMail: async (message) => {
        securityMail.push(message);
      },
    },
  });
  const ctx = createExecutionContext();
  const headers = new Headers();
  const origin = init.origin ?? "http://t";
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin !== "") headers.set("origin", origin);
  if (init.csrf) headers.set(CSRF_HEADER, init.csrf);
  if (init.expectedTenant !== undefined) headers.set(EXPECTED_TENANT_HEADER, init.expectedTenant);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sent, securityMail };
}

function cookieFrom(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
  return match ? `${SESSION_COOKIE_NAME}=${match[1]}` : null;
}

function credentialFrom(verifyUrl: string): string {
  const hash = verifyUrl.split("#")[1];
  if (!hash) throw new Error("missing fragment");
  return hash;
}

async function redeemUser(redemptionId: string, email = "founder@test.example") {
  const challenge = await request("/api/auth/challenge", {
    method: "POST",
    body: { email },
  });
  expect(challenge.sent).toHaveLength(1);
  const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
  });
  expect(redeemed.res.status).toBe(200);
  const cookie = cookieFrom(redeemed.res);
  expect(cookie).toBeTruthy();
  const whoami = await request("/api/whoami", { cookie: cookie! });
  const body = (await whoami.res.json()) as { csrf_token: string; user_id: string };
  return { cookie: cookie!, csrf: body.csrf_token, userId: body.user_id };
}

async function restoreFounder(): Promise<void> {
  const workerEnv = env as unknown as Env;
  await testControlPlane(workerEnv).run(
    "UPDATE users SET status = 'active', deleting_at = NULL WHERE id = ?",
    FOUNDER_TENANT_ID,
  );
  await testControlPlane(workerEnv).run(
    "UPDATE api_tokens SET revoked_at = NULL WHERE user_id = ?",
    FOUNDER_TENANT_ID,
  );
}

async function restoreOtherTenant(): Promise<void> {
  const workerEnv = env as unknown as Env;
  await testControlPlane(workerEnv).run(
    "UPDATE users SET status = 'active', deleting_at = NULL WHERE id = ?",
    OTHER_TENANT_ID,
  );
  await testControlPlane(workerEnv).run(
    "UPDATE api_tokens SET revoked_at = NULL WHERE user_id = ?",
    OTHER_TENANT_ID,
  );
}

describe("DELETE /api/account", () => {
  afterEach(async () => {
    await restoreFounder();
    await restoreOtherTenant();
  });

  it("deletes only the authenticated tenant's account and leaves another active", async () => {
    const workerEnv = env as unknown as Env;
    await insertSecondTenant(workerEnv);
    const founder = await redeemUser("clm_account_owner");
    const other = await redeemUser("clm_account_other", "other@test.example");

    const deleted = await request("/api/account", {
      method: "DELETE",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { confirm: "delete" },
    });
    expect(deleted.res.status).toBe(200);
    expect(await deleted.res.json()).toEqual({ ok: true });

    const [founderRow, otherRow] = await Promise.all([
      testControlPlane(workerEnv).first<{ status: string }>(
        "SELECT status FROM users WHERE id = ?",
        founder.userId,
      ),
      testControlPlane(workerEnv).first<{ status: string }>(
        "SELECT status FROM users WHERE id = ?",
        other.userId,
      ),
    ]);
    expect(founderRow?.status).toBe("active");
    expect(otherRow?.status).toBe("deleting");
    const founderStillAuthenticated = await request("/api/whoami", { cookie: founder.cookie });
    expect(founderStillAuthenticated.res.status).toBe(200);
  });

  it("requires recent auth, session principal, and explicit confirm", async () => {
    const session = await redeemUser("clm_acct_gates");
    const workerEnv = env as unknown as Env;
    const current = (
      await testControlPlane(workerEnv).first<{ id: string }>(
        "SELECT id FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
    )?.id;
    expect(current).toBeTruthy();

    const bearer = await request("/api/account", {
      method: "DELETE",
      authorization: "Bearer test-token",
      body: { confirm: "delete" },
    });
    expect(bearer.res.status).toBe(403);
    expect(await bearer.res.json()).toEqual({ error: "forbidden" });

    await testControlPlane(workerEnv).run(
      "UPDATE sessions SET authenticated_at = ? WHERE id = ?",
      toTimestamp(Date.parse(NOW) - 11 * 60 * 1000), current,
    );
    const stale = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { confirm: "delete" },
    });
    expect(stale.res.status).toBe(403);
    expect(await stale.res.json()).toEqual({ error: "recent authentication required" });

    await testControlPlane(workerEnv).run(
      "UPDATE sessions SET authenticated_at = ? WHERE id = ?",
      toTimestamp(Date.parse(NOW)), current,
    );

    const missingConfirm = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      body: {},
    });
    expect(missingConfirm.res.status).toBe(400);

    const wrongConfirm = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { confirm: true },
    });
    expect(wrongConfirm.res.status).toBe(400);

    const missingCsrf = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      body: { confirm: "delete" },
    });
    expect(missingCsrf.res.status).toBe(403);

    const still = await testControlPlane(workerEnv).first<{ status: string }>(
      "SELECT status FROM users WHERE id = ?",
      FOUNDER_TENANT_ID,
    );
    expect(still?.status).toBe("active");
  });

  it("marks deleting, revokes credentials, sends security mail, and 403s thereafter", async () => {
    const session = await redeemUser("clm_acct_delete");
    const extraTokenId = `tok_${crypto.randomUUID()}`;
    const now = Date.parse(NOW);
    const workerEnv = env as unknown as Env;
    const extraHmac = await hmacHex(
      await deriveHmacKey(
        { secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 },
        "api_token",
      ),
      `acct-del-${extraTokenId}`,
    );
    await testControlPlane(workerEnv).run(
      `INSERT INTO api_tokens (
         id, user_id, name, format, secret_hmac, hash_key_version,
         created_at, expires_at
       ) VALUES (?, ?, 'cli', 'standard', ?, 1, ?, ?)`,
      extraTokenId, session.userId, extraHmac, toTimestamp(now), toTimestamp(now + 90 * 24 * 60 * 60 * 1000),
    );

    const securityMail: SecurityMail[] = [];
    const deleted = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { confirm: "delete" },
      securityMail,
    });
    expect(deleted.res.status).toBe(200);
    expect(await deleted.res.json()).toEqual({ ok: true });
    expect(deleted.res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect(securityMail).toHaveLength(1);
    expect(securityMail[0]?.kind).toBe("account_deletion_started");
    expect(securityMail[0]?.text).toMatch(/access is revoked immediately/i);
    expect(securityMail[0]?.text).toContain("https://github.com/brian-bell/reading-lite");
    expect(`${securityMail[0]?.subject}\n${securityMail[0]?.text}`).not.toMatch(/sign-in link/i);
    expect(`${securityMail[0]?.subject}\n${securityMail[0]?.text}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );

    const user = await testControlPlane(workerEnv).first<{ status: string; deleting_at: string }>(
      "SELECT status, deleting_at FROM users WHERE id = ?",
      session.userId,
    );
    expect(user?.status).toBe("deleting");
    expect(user?.deleting_at).toBe(NOW);

    const liveSessions = await testControlPlane(workerEnv).first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
      session.userId,
    );
    expect(Number(liveSessions?.n)).toBe(0);

    const liveTokens = await testControlPlane(workerEnv).first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL",
      session.userId,
    );
    expect(Number(liveTokens?.n)).toBe(0);

    const cookieAfter = await request("/api/whoami", { cookie: session.cookie });
    expect(cookieAfter.res.status).toBe(401);

    const bearerAfter = await request("/api/readings", { authorization: "Bearer test-token" });
    expect([401, 403]).toContain(bearerAfter.res.status);

    const process = async () => {
      throw new Error("must not process");
    };
    const msg = {
      body: {
        version: 1,
        tenant: { tenantId: FOUNDER_TENANT_ID },
        actor: { kind: "api_token", credentialId: TOKEN_ID },
        job: {
          id: "rd_0123456789",
          url: "https://example.com/x",
          urlHash: "54cef8f42f3f31ad349075022cd36ce1a378d039c1df7af45d61d693d9a35c6a",
          createdAt: "2026-08-16T12:00:00.000Z",
          keyPrefix: buildKeyPrefix("rd_0123456789", "2026-08-16T12:00:00.000Z"),
          attemptId: "at_0123456789",
          trigger: "submit",
        },
      },
      ack: () => {
        /* observed via called flag */
      },
    };
    let acked = false;
    const wrapped = { ...msg, ack: () => { acked = true; } };
    await consumeProcessReadingMessage(wrapped, {
      db: testControlPlane(workerEnv),
      nowMs: Date.parse(NOW),
      process,
    });
    expect(acked).toBe(true);
  });

  it("returns 412 for a mismatched x-expected-tenant before recent auth, and fences nothing", async () => {
    const session = await redeemUser("clm_acct_pin");
    const workerEnv = env as unknown as Env;
    const whoami = await request("/api/whoami", { cookie: session.cookie });
    const identity = (await whoami.res.json()) as { tenant_id: string };
    const mismatch = { error: "expected tenant mismatch", acting_tenant: identity.tenant_id };

    const pinned = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: "global",
      body: { confirm: "delete" },
    });
    expect(pinned.res.status).toBe(412);
    expect(await pinned.res.json()).toEqual(mismatch);

    // A stale sign-in on the wrong account is not sent to step-up first.
    await testControlPlane(workerEnv).run(
      "UPDATE sessions SET authenticated_at = ? WHERE user_id = ?",
      toTimestamp(Date.parse(NOW) - 11 * 60 * 1000), session.userId,
    );
    const stale = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: "global",
      body: { confirm: "delete" },
    });
    expect(stale.res.status).toBe(412);

    const row = await testControlPlane(workerEnv).first<{ status: string }>(
      "SELECT status FROM users WHERE id = ?",
      session.userId,
    );
    expect(row?.status).toBe("active");

    await testControlPlane(workerEnv).run(
      "UPDATE sessions SET authenticated_at = ? WHERE user_id = ?",
      toTimestamp(Date.parse(NOW)), session.userId,
    );
    const matching = await request("/api/account", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: identity.tenant_id,
      body: { confirm: "delete" },
    });
    expect(matching.res.status).toBe(200);
  });
});
