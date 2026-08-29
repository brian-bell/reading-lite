import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_MAX_AGE_SECONDS, SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";

const NOW = "2026-08-16T12:00:00.000Z";

function services() {
  return {
    fetch: globalThis.fetch,
    now: () => NOW,
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
  } = {},
) {
  const sent: MagicLinkMail[] = [];
  const app = createApp({
    services: services(),
    auth: { sendMagicLink: async (message) => { sent.push(message); } },
  });
  const ctx = createExecutionContext();
  const headers = new Headers();
  const origin = init.origin ?? "http://t";
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin !== "") headers.set("origin", origin);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sent };
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

describe("invite-only magic-link sessions", () => {
  it("redeems a newest-only link into a durable host-only session cookie", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "FOUNDER@test.example" },
    });
    expect(challenge.res.status).toBe(200);
    expect(challenge.res.headers.get("cache-control")).toBe("no-store");
    expect(await challenge.res.json()).toEqual({ ok: true });
    expect(challenge.sent).toHaveLength(1);
    expect(challenge.sent[0]?.to).toBe("founder@test.example");
    expect(challenge.sent[0]?.verifyUrl).toContain("/auth/verify#");

    const getRedeem = await request("/api/auth/redeem", { method: "GET" });
    expect(getRedeem.res.status).toBe(405);

    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_first" },
    });
    expect(redeemed.res.status).toBe(200);
    expect(redeemed.res.headers.get("cache-control")).toBe("no-store");
    const setCookie = redeemed.res.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
    expect(setCookie.includes("Domain=")).toBe(false);

    const cookie = cookieFrom(redeemed.res);
    expect(cookie).toBeTruthy();
    const whoami = await request("/api/whoami", { cookie: cookie! });
    expect(whoami.res.status).toBe(200);
    const body = (await whoami.res.json()) as Record<string, unknown>;
    expect(body.principal).toBe("session");
    expect(body.email).toBe("founder@test.example");
    expect(whoami.res.headers.get("cache-control")).toBe("no-store");

    const readings = await request("/api/readings", { cookie: cookie! });
    expect(readings.res.status).toBe(200);
  });

  it("retries the same redemption id and rejects a competing claimant", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const first = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_same" },
    });
    expect(first.res.status).toBe(200);
    const retry = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_same" },
    });
    expect(retry.res.status).toBe(200);
    const competing = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_other" },
    });
    expect(competing.res.status).toBe(409);
  });

  it("lets an invalid bearer win over a valid session cookie", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_mixed" },
    });
    expect(redeemed.res.status).toBe(200);
    const cookie = cookieFrom(redeemed.res)!;
    const mixed = await request("/api/whoami", {
      cookie,
      authorization: "Bearer definitely-wrong",
    });
    expect(mixed.res.status).toBe(401);
  });

  it("logs out by revoking the D1 session and clearing the cookie", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_logout" },
    });
    expect(redeemed.res.status).toBe(200);
    const cookie = cookieFrom(redeemed.res)!;
    expect(cookie).toBeTruthy();
    const logout = await request("/api/auth/logout", { method: "POST", cookie, body: {} });
    expect(logout.res.status).toBe(200);
    expect(logout.res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    const after = await request("/api/whoami", { cookie });
    expect(after.res.status).toBe(401);
  });

  it("returns 401 not 500 when Continue is retried after logout", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_replay2" },
    });
    expect(redeemed.res.status).toBe(200);
    const cookie = cookieFrom(redeemed.res)!;
    const logout = await request("/api/auth/logout", { method: "POST", cookie, body: {} });
    expect(logout.res.status).toBe(200);
    const again = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_replay2" },
    });
    expect(again.res.status).toBe(401);
    expect(again.res.headers.get("set-cookie")).toBeNull();
  });

  it("stores the magic link in the local mail sink when no sender is injected", async () => {
    const app = createApp({ services: services() });
    const ctx = createExecutionContext();
    const origin = "http://127.0.0.1";
    const challenge = await app.fetch(
      new Request("http://127.0.0.1/api/auth/challenge", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "founder@test.example" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ ok: true });
    const mailboxCtx = createExecutionContext();
    const mailbox = await app.fetch(
      new Request("http://127.0.0.1/api/dev/mailbox?email=founder@test.example"),
      env,
      mailboxCtx,
    );
    await waitOnExecutionContext(mailboxCtx);
    expect(mailbox.status).toBe(200);
    const body = (await mailbox.json()) as { to: string; verify_url: string };
    expect(body.to).toBe("founder@test.example");
    expect(body.verify_url).toContain("/auth/verify#");
    expect(body.verify_url).not.toContain("reader@test.example");
  });

  it("AuthRateGuard denies after the per-email ceiling", async () => {
    const workerEnv = env as unknown as Env;
    expect(workerEnv.AUTH_RATE_GUARD).toBeTruthy();
    const stub = workerEnv.AUTH_RATE_GUARD!.get(workerEnv.AUTH_RATE_GUARD!.idFromName("test-email-ceiling"));
    const admit = async () =>
      stub.fetch("https://auth-rate-guard/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailHash: "test-email-hash",
          ipHash: "test-ip-hash",
          emailWindowMs: 60_000,
          emailMax: 2,
          ipWindowMs: 60_000,
          ipMax: 20,
          globalWindowMs: 60_000,
          globalMax: 200,
        }),
      });
    expect(((await (await admit()).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit()).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit()).json()) as { ok: boolean }).ok).toBe(false);
  });

  it("does not let a concurrent AuthRateGuard burst all pass the email ceiling", async () => {
    const workerEnv = env as unknown as Env;
    const stub = workerEnv.AUTH_RATE_GUARD!.get(workerEnv.AUTH_RATE_GUARD!.idFromName("test-email-burst"));
    const payload = JSON.stringify({
      emailHash: "test-burst-hash",
      ipHash: "test-burst-ip",
      emailWindowMs: 60_000,
      emailMax: 2,
      ipWindowMs: 60_000,
      ipMax: 20,
      globalWindowMs: 60_000,
      globalMax: 200,
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        stub.fetch("https://auth-rate-guard/admit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      ),
    );
    const outcomes = await Promise.all(responses.map(async (res) => ((await res.json()) as { ok: boolean }).ok));
    expect(outcomes.filter((ok) => ok)).toHaveLength(2);
    expect(outcomes.filter((ok) => !ok)).toHaveLength(6);
  });

  it("does not disclose whether an unknown address is invited", async () => {
    const workerEnv = env as unknown as Env;
    await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'invite_only' WHERE id = 1").run();
    try {
      const unknown = await request("/api/auth/challenge", {
        method: "POST",
        body: { email: "nobody@test.example" },
      });
      expect(unknown.res.status).toBe(200);
      expect(await unknown.res.json()).toEqual({ ok: true });
      expect(unknown.sent).toHaveLength(0);
    } finally {
      await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'open' WHERE id = 1").run();
    }
  });

  it("provisions an invited address on redemption", async () => {
    const workerEnv = env as unknown as Env;
    const now = Date.parse(NOW);
    await workerEnv.CONTROL_PLANE.prepare(
      "UPDATE system_policy SET signup_mode = 'invite_only' WHERE id = 1",
    ).run();
    await workerEnv.CONTROL_PLANE.prepare(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
       VALUES ('invited@test.example', 'Invited@test.example', ?)`,
    )
      .bind(now)
      .run();
    try {
      const challenge = await request("/api/auth/challenge", {
        method: "POST",
        body: { email: "invited@test.example" },
      });
      expect(challenge.sent).toHaveLength(1);
      expect(challenge.sent[0]?.to).toBe("Invited@test.example");
      const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
      const redeemed = await request("/api/auth/redeem", {
        method: "POST",
        body: { credential, redemption_id: "clm_invited" },
      });
      expect(redeemed.res.status).toBe(200);
      const body = (await redeemed.res.json()) as { email: string; principal: string };
      expect(body.email).toBe("Invited@test.example");
      expect(body.principal).toBe("session");
    } finally {
      await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'open' WHERE id = 1").run();
    }
  });
});
