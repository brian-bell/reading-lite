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
    lookup: async () => [{ address: "93.184.216.34" }],
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

async function insertReadToken(userId: string) {
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
    .bind(tokenId, userId, secretHmac, now, now + 90 * 24 * 60 * 60 * 1000)
    .run();
  await workerEnv.CONTROL_PLANE.prepare(
    "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, 'readings:read')",
  )
    .bind(tokenId)
    .run();
  return { tokenId, bearer: `Bearer ${tokenId}.cd${"cd".repeat(31)}` };
}

describe("verified email change", () => {
  it("requires CSRF for email-change request and redeem", async () => {
    const session = await redeemUser("csrf-changer@test.example", "clm_csrf_req");

    const missingCsrf = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      body: { email: "csrf-fresh@test.example" },
    });
    expect(missingCsrf.res.status).toBe(403);
    expect(missingCsrf.sent).toHaveLength(0);

    const requested = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "csrf-fresh@test.example" },
    });
    expect(requested.res.status).toBe(200);
    expect(requested.sent).toHaveLength(1);
    const credential = credentialFrom(requested.sent[0]!.verifyUrl);

    const missingRedeemCsrf = await request("/api/auth/redeem", {
      method: "POST",
      cookie: session.cookie,
      body: { credential, redemption_id: "clm_csrf_nocsrf" },
    });
    expect(missingRedeemCsrf.res.status).toBe(403);
  });

  it("acks occupied targets generically", async () => {
    const session = await redeemUser("occ-changer@test.example", "clm_occ_req");
    const occupied = await redeemUser("occ-taken@test.example", "clm_occ_taken");

    const occupiedAck = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: occupied.email },
    });
    expect(occupiedAck.res.status).toBe(200);
    expect(await occupiedAck.res.json()).toEqual({ ok: true });
  });

  it("swaps via redeem and revokes other sessions and tokens", async () => {
    const session = await redeemUser("swap-changer@test.example", "clm_swap_req");

    const requested = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "Swap-Fresh@test.example" },
    });
    expect(requested.res.status).toBe(200);
    expect(await requested.res.json()).toEqual({ ok: true });
    expect(requested.sent).toHaveLength(1);
    expect(requested.sent[0]?.to).toBe("Swap-Fresh@test.example");
    expect(requested.sent[0]?.subject).toMatch(/confirm/i);
    expect(requested.sent[0]?.verifyUrl).toContain("/auth/verify?purpose=email_change#");

    const credential = credentialFrom(requested.sent[0]!.verifyUrl);
    const cookieless = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_swap_nocookie" },
    });
    expect(cookieless.res.status).toBe(401);
    expect(await cookieless.res.json()).toEqual({ error: "unauthorized" });
    expect(cookieless.securityMail).toHaveLength(0);

    const other = await redeemUser("swap-changer@test.example", "clm_swap_other");
    const otherRedeem = await request("/api/auth/redeem", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { credential, redemption_id: "clm_swap_other_device" },
    });
    expect(otherRedeem.res.status).toBe(403);
    expect(await otherRedeem.res.json()).toEqual({ error: "forbidden" });
    const stillOld = await request("/api/whoami", { cookie: session.cookie });
    expect((await stillOld.res.json() as { email: string }).email).toBe("swap-changer@test.example");

    const { bearer } = await insertReadToken(session.userId);
    const tokenBefore = await request("/api/whoami", { authorization: bearer });
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
          redemption_id: "clm_swap_confirm",
        },
        securityMail,
      },
    );
    expect(confirmed.res.status).toBe(200);
    expect(cookieFrom(confirmed.res)).toBeNull();
    const body = (await confirmed.res.json()) as { email: string };
    expect(body.email).toBe("Swap-Fresh@test.example");
    expect(securityMail).toHaveLength(1);
    expect(securityMail[0]?.kind).toBe("email_changed");
    expect(securityMail[0]?.to).toBe("swap-changer@test.example");
    expect(`${securityMail[0]?.subject}\n${securityMail[0]?.text}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );

    const whoami = await request("/api/whoami", { cookie: session.cookie });
    expect(whoami.res.status).toBe(200);
    expect((await whoami.res.json() as { email: string }).email).toBe("Swap-Fresh@test.example");

    const otherWhoami = await request("/api/whoami", { cookie: other.cookie });
    expect(otherWhoami.res.status).toBe(401);

    const tokenAfter = await request("/api/whoami", { authorization: bearer });
    expect(tokenAfter.res.status).toBe(401);
  });

  it("requires recent authentication to request an email change", async () => {
    const session = await redeemUser("stale-changer@test.example", "clm_stale_req");
    const staleEnv = env as unknown as Env;
    const current = (
      await staleEnv.CONTROL_PLANE.prepare(
        "SELECT id FROM sessions WHERE user_id = ? AND revoked_at_ms IS NULL LIMIT 1",
      )
        .bind(session.userId)
        .first<{ id: string }>()
    )?.id;
    expect(current).toBeTruthy();
    await staleEnv.CONTROL_PLANE.prepare("UPDATE sessions SET authenticated_at_ms = ? WHERE id = ?")
      .bind(Date.parse(NOW) - 11 * 60 * 1000, current)
      .run();
    const stale = await request("/api/auth/email-change", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { email: "stale-later@test.example" },
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

  it("restores the caller's previous link without stealing another user's live target", async () => {
    const caller = await redeemUser("snapshot-caller@test.example", "clm_snap_caller");
    const other = await redeemUser("snapshot-other@test.example", "clm_snap_other");

    const toA = await request("/api/auth/email-change", {
      method: "POST",
      cookie: caller.cookie,
      csrf: caller.csrf,
      body: { email: "snap-a@test.example" },
    });
    expect(toA.sent).toHaveLength(1);
    const credentialA = credentialFrom(toA.sent[0]!.verifyUrl);

    const otherB = await request("/api/auth/email-change", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { email: "snap-b@test.example" },
    });
    expect(otherB.sent).toHaveLength(1);
    const credentialOtherB = credentialFrom(otherB.sent[0]!.verifyUrl);

    const callerB = await request("/api/auth/email-change", {
      method: "POST",
      cookie: caller.cookie,
      csrf: caller.csrf,
      body: { email: "snap-b@test.example" },
      sendMagicLink: async () => {
        throw new Error("resend 400");
      },
    });
    expect(callerB.res.status).toBe(200);
    expect(callerB.sent).toHaveLength(0);

    const workerEnv = env as unknown as Env;
    const rows = await workerEnv.CONTROL_PLANE.prepare(
      `SELECT email_canonical, user_id, state FROM auth_challenges
       WHERE purpose = 'email_change'
       ORDER BY issued_at_ms`,
    ).all<{ email_canonical: string; user_id: string; state: string }>();
    expect(rows.results).toEqual([
      { email_canonical: "snap-a@test.example", user_id: caller.userId, state: "issued" },
      { email_canonical: "snap-b@test.example", user_id: other.userId, state: "issued" },
      { email_canonical: "snap-b@test.example", user_id: caller.userId, state: "revoked" },
    ]);

    const restoredA = await request("/api/auth/redeem", {
      method: "POST",
      cookie: caller.cookie,
      csrf: caller.csrf,
      body: { credential: credentialA, redemption_id: "clm_snap_restore_a" },
    });
    expect(restoredA.res.status).toBe(200);

    const restoredOtherB = await request("/api/auth/redeem", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { credential: credentialOtherB, redemption_id: "clm_snap_restore_other_b" },
    });
    expect(restoredOtherB.res.status).toBe(200);

    const callerFailedB = await workerEnv.CONTROL_PLANE.prepare(
      `SELECT state FROM auth_challenges
       WHERE purpose = 'email_change' AND user_id = ? AND email_canonical = ?`,
    )
      .bind(caller.userId, "snap-b@test.example")
      .first<{ state: string }>();
    expect(callerFailedB?.state).toBe("revoked");
  });
});
