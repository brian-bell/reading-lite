import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import type { SecurityMail } from "../../src/control-plane/security-mail";
import { CSRF_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";

const NOW = "2026-08-16T12:00:00.000Z";

function services(now = NOW) {
  return {
    fetch: globalThis.fetch,
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
    now?: string;
    securityMail?: SecurityMail[];
    sendMagicLink?: (message: MagicLinkMail) => Promise<void>;
  } = {},
  workerEnv: Env = env as unknown as Env,
) {
  const sent: MagicLinkMail[] = [];
  const securityMail = init.securityMail ?? [];
  const app = createApp({
    services: services(init.now ?? NOW),
    auth: {
      sendMagicLink: init.sendMagicLink
        ? init.sendMagicLink
        : async (message) => {
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

async function redeemUser(email: string, redemptionId: string) {
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
  const body = (await whoami.res.json()) as { csrf_token: string; user_id: string; email: string };
  return { cookie: cookie!, csrf: body.csrf_token, userId: body.user_id, email: body.email };
}

describe("verified email change", () => {
  it("acks generically, requires CSRF and recent-auth, then swaps via redeem", async () => {
    const session = await redeemUser("changer@test.example", "clm_email_req");
    const occupied = await redeemUser("taken@test.example", "clm_taken_user");

    const missingCsrf = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      body: { email: "fresh@test.example" },
    });
    expect(missingCsrf.res.status).toBe(403);
    expect(missingCsrf.sent).toHaveLength(0);

    const occupiedAck = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: occupied.email },
    });
    expect(occupiedAck.res.status).toBe(200);
    expect(await occupiedAck.res.json()).toEqual({ ok: true });

    const requested = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "Fresh@test.example" },
    });
    expect(requested.res.status).toBe(200);
    expect(await requested.res.json()).toEqual({ ok: true });
    expect(requested.sent).toHaveLength(1);
    expect(requested.sent[0]?.to).toBe("Fresh@test.example");
    expect(requested.sent[0]?.subject).toMatch(/confirm/i);
    expect(requested.sent[0]?.verifyUrl).toContain("/auth/verify?purpose=email_change#");

    const credential = credentialFrom(requested.sent[0]!.verifyUrl);
    const cookieless = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_email_nocookie" },
    });
    expect(cookieless.res.status).toBe(401);
    expect(await cookieless.res.json()).toEqual({ error: "unauthorized" });
    expect(cookieless.securityMail).toHaveLength(0);

    const missingRedeemCsrf = await request("/api/auth/redeem", {
      method: "POST",
      cookie: session.cookie,
      body: { credential, redemption_id: "clm_email_nocsrf" },
    });
    expect(missingRedeemCsrf.res.status).toBe(403);

    const other = await redeemUser("changer@test.example", "clm_email_other");
    const otherRedeem = await request("/api/auth/redeem", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { credential, redemption_id: "clm_email_other_device" },
    });
    expect(otherRedeem.res.status).toBe(403);
    expect(await otherRedeem.res.json()).toEqual({ error: "forbidden" });
    const stillOld = await request("/api/whoami", { cookie: session.cookie });
    expect((await stillOld.res.json() as { email: string }).email).toBe("changer@test.example");
    const workerEnv = env as unknown as Env;
    const secretHmac = await hmacHex(
      await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
      "cd".repeat(32),
    );
    const now = Date.parse(NOW);
    const tokenId = `tok_${crypto.randomUUID()}`;
    await workerEnv.CONTROL_PLANE.prepare(
      `INSERT INTO api_tokens (
         id, user_id, name, format, secret_hmac, hash_key_version,
         created_at_ms, expires_at_ms
       ) VALUES (?, ?, 'cli', 'standard', ?, 1, ?, ?)`,
    )
      .bind(tokenId, session.userId, secretHmac, now, now + 90 * 24 * 60 * 60 * 1000)
      .run();
    await workerEnv.CONTROL_PLANE.prepare(
      "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, 'readings:read')",
    )
      .bind(tokenId)
      .run();
    const tokenBefore = await request("/api/whoami", { authorization: `Bearer ${tokenId}.cd${"cd".repeat(31)}` });
    expect(tokenBefore.res.status).toBe(200);

    const securityMail: SecurityMail[] = [];
    const confirmed = await request(
      "/api/auth/redeem",
      {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: {
          credential,
          redemption_id: "clm_email_confirm",
        },
        securityMail,
      },
    );
    expect(confirmed.res.status).toBe(200);
    expect(cookieFrom(confirmed.res)).toBeNull();
    const body = (await confirmed.res.json()) as { email: string };
    expect(body.email).toBe("Fresh@test.example");
    expect(securityMail).toHaveLength(1);
    expect(securityMail[0]?.kind).toBe("email_changed");
    expect(securityMail[0]?.to).toBe("changer@test.example");
    expect(`${securityMail[0]?.subject}\n${securityMail[0]?.text}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );

    const whoami = await request("/api/whoami", { cookie: session.cookie });
    expect(whoami.res.status).toBe(200);
    expect((await whoami.res.json() as { email: string }).email).toBe("Fresh@test.example");

    const otherWhoami = await request("/api/whoami", { cookie: other.cookie });
    expect(otherWhoami.res.status).toBe(401);

    const tokenAfter = await request("/api/whoami", { authorization: `Bearer ${tokenId}.cd${"cd".repeat(31)}` });
    expect(tokenAfter.res.status).toBe(401);

    const staleEnv = env as unknown as Env;
    const current = (
      await staleEnv.CONTROL_PLANE.prepare("SELECT id FROM sessions WHERE revoked_at_ms IS NULL LIMIT 1").first<{
        id: string;
      }>()
    )?.id;
    expect(current).toBeTruthy();
    await staleEnv.CONTROL_PLANE.prepare("UPDATE sessions SET authenticated_at_ms = ? WHERE id = ?")
      .bind(Date.parse(NOW) - 11 * 60 * 1000, current)
      .run();
    const stale = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "later@test.example" },
    });
    expect(stale.res.status).toBe(403);
    expect(await stale.res.json()).toEqual({ error: "recent authentication required" });
  });

  it("rejects bearer callers and does not reveal occupancy", async () => {
    const session = await redeemUser("reveal@test.example", "clm_reveal");
    const bearer = await request("/api/auth/email-change", {
      method: "POST",
      authorization: "Bearer test-token",
      body: { email: "other@test.example" },
    });
    expect(bearer.res.status).toBe(403);
    expect(bearer.sent).toHaveLength(0);

    const same = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: session.email },
    });
    expect(same.res.status).toBe(200);
    expect(same.sent).toHaveLength(0);
  });

  it("restores the previous email-change link when a later different-address send fails", async () => {
    const session = await redeemUser("restore-changer@test.example", "clm_restore_email_req");
    const toA = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "address-a@test.example" },
    });
    expect(toA.res.status).toBe(200);
    expect(toA.sent).toHaveLength(1);
    const credentialA = credentialFrom(toA.sent[0]!.verifyUrl);

    const toB = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "address-b@test.example" },
      sendMagicLink: async () => {
        throw new Error("resend 400");
      },
    });
    expect(toB.res.status).toBe(200);
    expect(await toB.res.json()).toEqual({ ok: true });
    expect(toB.sent).toHaveLength(0);

    const workerEnv = env as unknown as Env;
    const rows = await workerEnv.CONTROL_PLANE.prepare(
      `SELECT email_canonical, state FROM auth_challenges
       WHERE purpose = 'email_change' AND user_id = ?
       ORDER BY issued_at_ms`,
    )
      .bind(session.userId)
      .all<{ email_canonical: string; state: string }>();
    expect(rows.results).toEqual([
      { email_canonical: "address-a@test.example", state: "issued" },
      { email_canonical: "address-b@test.example", state: "revoked" },
    ]);

    const restored = await request("/api/auth/redeem", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { credential: credentialA, redemption_id: "clm_restore_email_a" },
    });
    expect(restored.res.status).toBe(200);
    expect((await restored.res.json() as { email: string }).email).toBe("address-a@test.example");
  });
});
