import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_CAP_WARNING, SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import type { SecurityMail } from "../../src/control-plane/security-mail";
import { CSRF_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { OTHER_TOKEN_SECRET, insertSecondTenant } from "../helpers/tenant-fixtures";

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

async function redeemSession(redemptionId: string, cookie?: string, email = "founder@test.example") {
  const challenge = await request("/api/auth/challenge", {
    method: "POST",
    body: { email },
  });
  const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
    cookie,
  });
  expect(redeemed.res.status).toBe(200);
  const nextCookie = cookieFrom(redeemed.res) ?? cookie ?? null;
  expect(nextCookie).toBeTruthy();
  const whoami = await request("/api/whoami", { cookie: nextCookie! });
  const body = (await whoami.res.json()) as { csrf_token: string };
  return { cookie: nextCookie!, csrf: body.csrf_token, redeemed };
}

describe("session inspect and revoke", () => {
  it("does not list or revoke another tenant's session, while retaining owner control", async () => {
    const workerEnv = env as unknown as Env;
    await insertSecondTenant(workerEnv);
    const owner = await redeemSession("clm_session_owner");
    const other = await redeemSession("clm_session_other", undefined, "other@test.example");

    const ownerList = await request("/api/auth/sessions", { cookie: owner.cookie });
    expect(ownerList.res.status).toBe(200);
    const ownerBody = (await ownerList.res.json()) as { sessions: { id: string }[] };
    const otherList = await request("/api/auth/sessions", { cookie: other.cookie });
    expect(otherList.res.status).toBe(200);
    const otherBody = (await otherList.res.json()) as { sessions: { id: string }[] };
    const otherSessionId = otherBody.sessions.find((row) => !ownerBody.sessions.some((ownerRow) => ownerRow.id === row.id))
      ?.id;
    expect(otherSessionId).toBeTruthy();
    expect(ownerBody.sessions).not.toContainEqual(expect.objectContaining({ id: otherSessionId }));

    const foreign = await request(`/api/auth/sessions/${otherSessionId}`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(foreign.res.status).toBe(404);
    expect(await foreign.res.json()).toEqual({ error: "not found" });

    const unknown = await request("/api/auth/sessions/ses_22222222-2222-4222-8222-222222222222", {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(unknown.res.status).toBe(foreign.res.status);
    expect(await unknown.res.json()).toEqual({ error: "not found" });
    const retained = await workerEnv.CONTROL_PLANE.prepare(
      "SELECT revoked_at_ms FROM sessions WHERE id = ?",
    )
      .bind(otherSessionId)
      .first<{ revoked_at_ms: number | null }>();
    expect(retained?.revoked_at_ms).toBeNull();

    const ownerDelete = await request(`/api/auth/sessions/${otherSessionId}`, {
      method: "DELETE",
      cookie: other.cookie,
      csrf: other.csrf,
    });
    expect(ownerDelete.res.status).toBe(200);
    const revoked = await workerEnv.CONTROL_PLANE.prepare(
      "SELECT revoked_at_ms FROM sessions WHERE id = ?",
    )
      .bind(otherSessionId)
      .first<{ revoked_at_ms: number | null }>();
    expect(revoked?.revoked_at_ms).toBe(Date.parse(NOW));
  });

  it("lists sessions, marks current, and requires CSRF on cookie mutations", async () => {
    const first = await redeemSession("clm_list_a");
    const listed = await request("/api/auth/sessions", { cookie: first.cookie });
    expect(listed.res.status).toBe(200);
    expect(listed.res.headers.get("cache-control")).toBe("no-store");
    const body = (await listed.res.json()) as {
      sessions: { id: string; current: boolean; revoked_at_ms: number | null; usable: boolean }[];
      session_cap_warning: string | null;
    };
    expect(body.sessions.some((row) => row.current)).toBe(true);
    expect(body.sessions.find((row) => row.current)?.usable).toBe(true);
    expect(body.session_cap_warning).toBeNull();
    const currentId = body.sessions.find((row) => row.current)!.id;

    const missingCsrf = await request(`/api/auth/sessions/${currentId}`, {
      method: "DELETE",
      cookie: first.cookie,
    });
    expect(missingCsrf.res.status).toBe(403);

    const stillListed = await request("/api/auth/sessions", { cookie: first.cookie });
    expect(stillListed.res.status).toBe(200);

    const revoked = await request(`/api/auth/sessions/${currentId}`, {
      method: "DELETE",
      cookie: first.cookie,
      csrf: first.csrf,
    });
    expect(revoked.res.status).toBe(200);
    expect(revoked.res.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE_NAME}=`);
    expect(revoked.res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect(revoked.securityMail).toHaveLength(0);

    const after = await request("/api/auth/sessions", { cookie: first.cookie });
    expect(after.res.status).toBe(401);
  });

  it("revokes another session without clearing the current cookie or sending mail", async () => {
    await redeemSession("clm_other_a");
    const second = await redeemSession("clm_other_b");
    const listed = await request("/api/auth/sessions", { cookie: second.cookie });
    const body = (await listed.res.json()) as { sessions: { id: string; current: boolean }[] };
    const otherId = body.sessions.find((row) => !row.current)?.id;
    expect(otherId).toBeTruthy();

    const revoked = await request(`/api/auth/sessions/${otherId}`, {
      method: "DELETE",
      cookie: second.cookie,
      csrf: second.csrf,
    });
    expect(revoked.res.status).toBe(200);
    expect(revoked.res.headers.get("set-cookie")).toBeNull();
    expect(revoked.securityMail).toHaveLength(0);

    const still = await request("/api/whoami", { cookie: second.cookie });
    expect(still.res.status).toBe(200);
  });

  it("revoke-all logs the caller out, requires CSRF, and sends security mail", async () => {
    const session = await redeemSession("clm_revoke_all");
    const missingCsrf = await request("/api/auth/sessions/revoke-all", {
      method: "POST",
      cookie: session.cookie,
      body: {},
    });
    expect(missingCsrf.res.status).toBe(403);
    expect(missingCsrf.securityMail).toHaveLength(0);

    const securityMail: SecurityMail[] = [];
    const revoked = await request(
      "/api/auth/sessions/revoke-all",
      {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: {},
        securityMail,
      },
    );
    expect(revoked.res.status).toBe(200);
    expect(revoked.res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect(securityMail).toHaveLength(1);
    expect(securityMail[0]?.kind).toBe("sessions_revoked_all");
    expect(securityMail[0]?.to).toBe("founder@test.example");
    expect(`${securityMail[0]?.subject}\n${securityMail[0]?.text}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );

    const after = await request("/api/whoami", { cookie: session.cookie });
    expect(after.res.status).toBe(401);
  });

  it("revoke-all through cookie and bearer affects only the caller's populated account", async () => {
    const workerEnv = env as unknown as Env;
    await insertSecondTenant(workerEnv);
    const ownerCookie = await redeemSession("clm_revoke_scope_owner_cookie");
    const ownerSecond = await redeemSession("clm_revoke_scope_owner_second");
    const other = await redeemSession("clm_revoke_scope_other", undefined, "other@test.example");

    const cookieRevoke = await request("/api/auth/sessions/revoke-all", {
      method: "POST",
      cookie: ownerCookie.cookie,
      csrf: ownerCookie.csrf,
      body: {},
    });
    expect(cookieRevoke.res.status).toBe(200);
    expect((await request("/api/whoami", { cookie: ownerSecond.cookie })).res.status).toBe(401);
    expect((await request("/api/whoami", { cookie: other.cookie })).res.status).toBe(200);
    expect((await request("/api/whoami", { authorization: `Bearer ${OTHER_TOKEN_SECRET}` })).res.status).toBe(200);

    const ownerBearerSession = await redeemSession("clm_revoke_scope_owner_bearer");
    const securityMail: SecurityMail[] = [];
    const bearerRevoke = await request("/api/auth/sessions/revoke-all", {
      method: "POST",
      authorization: "Bearer test-token",
      body: {},
      securityMail,
    });
    expect(bearerRevoke.res.status).toBe(200);
    expect(bearerRevoke.res.headers.get("set-cookie")).toBeNull();
    expect(securityMail).toHaveLength(1);
    expect((await request("/api/whoami", { cookie: ownerBearerSession.cookie })).res.status).toBe(401);
    expect((await request("/api/whoami", { cookie: other.cookie })).res.status).toBe(200);
    expect((await request("/api/whoami", { authorization: `Bearer ${OTHER_TOKEN_SECRET}` })).res.status).toBe(200);

    // A second revoke with nothing left to revoke sends no security mail.
    const again: SecurityMail[] = [];
    const second = await request("/api/auth/sessions/revoke-all", {
      method: "POST",
      authorization: "Bearer test-token",
      body: {},
      securityMail: again,
    });
    expect(second.res.status).toBe(200);
    expect(again).toHaveLength(0);
  });

  it("logout revokes one session while another owner session and another tenant survive", async () => {
    const workerEnv = env as unknown as Env;
    await insertSecondTenant(workerEnv);
    const first = await redeemSession("clm_logout_scope_first");
    const second = await redeemSession("clm_logout_scope_second");
    const other = await redeemSession("clm_logout_scope_other", undefined, "other@test.example");

    const logout = await request("/api/auth/logout", {
      method: "POST",
      cookie: first.cookie,
      csrf: first.csrf,
      body: {},
    });
    expect(logout.res.status).toBe(200);
    expect((await request("/api/whoami", { cookie: first.cookie })).res.status).toBe(401);
    expect((await request("/api/whoami", { cookie: second.cookie })).res.status).toBe(200);
    expect((await request("/api/whoami", { cookie: other.cookie })).res.status).toBe(200);
  });

  it("lets bearer list sessions without CSRF, and leaves corpus reads ungated by recent-auth", async () => {
    const session = await redeemSession("clm_bearer_list");
    const listed = await request("/api/auth/sessions", { authorization: "Bearer test-token" });
    expect(listed.res.status).toBe(200);
    const body = (await listed.res.json()) as { sessions: { current: boolean }[] };
    expect(body.sessions.every((row) => row.current === false)).toBe(true);

    const workerEnv = env as unknown as Env;
    const current = (
      await workerEnv.CONTROL_PLANE.prepare(
        "SELECT id FROM sessions WHERE revoked_at_ms IS NULL ORDER BY created_at_ms DESC LIMIT 1",
      ).first<{ id: string }>()
    )?.id;
    expect(current).toBeTruthy();
    await workerEnv.CONTROL_PLANE.prepare("UPDATE sessions SET authenticated_at_ms = ? WHERE id = ?")
      .bind(Date.parse(NOW) - 11 * 60 * 1000, current)
      .run();

    const readings = await request("/api/readings", { cookie: session.cookie });
    expect(readings.res.status).toBe(200);
  });

  it("refreshes authenticated_at_ms on redeem when a live same-user cookie is present", async () => {
    const first = await redeemSession("clm_step_cookie");
    const workerEnv = env as unknown as Env;
    const before = await workerEnv.CONTROL_PLANE.prepare(
      "SELECT COUNT(*) AS n, MAX(authenticated_at_ms) AS auth FROM sessions WHERE revoked_at_ms IS NULL",
    ).first<{ n: number; auth: number }>();

    const later = "2026-08-16T12:05:00.000Z";
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
      now: later,
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const stepped = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_step_cookie_2" },
      cookie: first.cookie,
      now: later,
    });
    expect(stepped.res.status).toBe(200);
    expect(cookieFrom(stepped.res)).toBeNull();

    const after = await workerEnv.CONTROL_PLANE.prepare(
      "SELECT COUNT(*) AS n, MAX(authenticated_at_ms) AS auth FROM sessions WHERE revoked_at_ms IS NULL",
    ).first<{ n: number; auth: number }>();
    expect(after?.n).toBe(before?.n);
    expect(after?.auth).toBe(Date.parse(later));
  });

  it("surfaces the 11th-session warning once the account is at cap", async () => {
    const workerEnv = env as unknown as Env;
    const userId = (
      await workerEnv.CONTROL_PLANE.prepare(
        "SELECT id FROM users WHERE email_canonical = ?",
      )
        .bind("founder@test.example")
        .first<{ id: string }>()
    )?.id;
    expect(userId).toBeTruthy();
    const secretHmac = await hmacHex(
      await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "session"),
      "ab".repeat(32),
    );
    const now = Date.parse(NOW);
    for (let i = 0; i < 9; i += 1) {
      await workerEnv.CONTROL_PLANE.prepare(
        `INSERT INTO sessions (
           id, user_id, secret_hmac, hash_key_version,
           created_at_ms, authenticated_at_ms, last_seen_at_ms,
           idle_expires_at_ms, absolute_expires_at_ms, user_agent_label, created_from_claim_id
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `ses_${crypto.randomUUID()}`,
          userId,
          secretHmac,
          now + i,
          now + i,
          now + i,
          now + 30 * 24 * 60 * 60 * 1000,
          now + 90 * 24 * 60 * 60 * 1000,
          `cap-${i}`,
          `clm_warn_${i}`,
        )
        .run();
    }
    const session = await redeemSession("clm_warn_live");
    const listed = await request("/api/auth/sessions", { cookie: session.cookie });
    const body = (await listed.res.json()) as { session_cap_warning: string | null };
    expect(body.session_cap_warning).toBe(SESSION_CAP_WARNING);
  });

  it("keeps idle-expired sessions in the list as unusable", async () => {
    const workerEnv = env as unknown as Env;
    const userId = (
      await workerEnv.CONTROL_PLANE.prepare("SELECT id FROM users WHERE email_canonical = ?")
        .bind("founder@test.example")
        .first<{ id: string }>()
    )?.id;
    expect(userId).toBeTruthy();
    const secretHmac = await hmacHex(
      await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "session"),
      "ab".repeat(32),
    );
    const now = Date.parse(NOW);
    const expiredId = `ses_${crypto.randomUUID()}`;
    await workerEnv.CONTROL_PLANE.prepare(
      `INSERT INTO sessions (
         id, user_id, secret_hmac, hash_key_version,
         created_at_ms, authenticated_at_ms, last_seen_at_ms,
         idle_expires_at_ms, absolute_expires_at_ms, user_agent_label, created_from_claim_id
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        expiredId,
        userId,
        secretHmac,
        now,
        now,
        now,
        now,
        now + 90 * 24 * 60 * 60 * 1000,
        "Old laptop",
        "clm_expired_inspect",
      )
      .run();

    const session = await redeemSession("clm_expired_live");
    const listed = await request("/api/auth/sessions", { cookie: session.cookie });
    expect(listed.res.status).toBe(200);
    const body = (await listed.res.json()) as {
      sessions: {
        id: string;
        usable: boolean;
        revoked_at_ms: number | null;
        user_agent_label: string | null;
        current: boolean;
      }[];
      session_cap_warning: string | null;
    };
    const expired = body.sessions.find((row) => row.id === expiredId);
    const live = body.sessions.find((row) => row.current);
    expect(expired).toMatchObject({
      usable: false,
      revoked_at_ms: null,
      user_agent_label: "Old laptop",
      current: false,
    });
    expect(live?.usable).toBe(true);
  });
});
