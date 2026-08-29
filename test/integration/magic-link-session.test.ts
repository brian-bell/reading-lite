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
    secFetchSite?: string;
  } = {},
  workerEnv: Env = env as unknown as Env,
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
  if (init.secFetchSite) headers.set("sec-fetch-site", init.secFetchSite);
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

function recordingRateGuard() {
  const posts: { kind?: string }[] = [];
  const ns = {
    idFromName: () => ({ toString: () => "id" }),
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)) as { kind?: string });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  return { ns, posts };
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

  it("denies cookie writes without a same-origin Origin and leaves bearer unconstrained", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_origin" },
    });
    expect(redeemed.res.status).toBe(200);
    const cookie = cookieFrom(redeemed.res)!;

    const missing = await request("/api/readings", {
      method: "POST",
      cookie,
      origin: "",
      body: { url: "https://example.com/origin-missing" },
    });
    expect(missing.res.status).toBe(401);

    const cross = await request("/api/readings", {
      method: "POST",
      cookie,
      origin: "https://evil.example",
      body: { url: "https://example.com/origin-cross" },
    });
    expect(cross.res.status).toBe(401);

    const sameOriginWhoami = await request("/api/whoami", { cookie });
    expect(sameOriginWhoami.res.status).toBe(200);

    const bearerMissingOrigin = await request("/api/whoami", {
      authorization: "Bearer test-token",
      origin: "",
    });
    expect(bearerMissingOrigin.res.status).toBe(200);

    const bearerWrite = await request("/api/readings", {
      method: "POST",
      authorization: "Bearer test-token",
      origin: "",
      body: { url: "https://example.com/bearer-no-origin" },
    });
    expect(bearerWrite.res.status).not.toBe(401);
    expect(bearerWrite.res.status).not.toBe(403);
  });

  it("allows a same-origin cookie GET without Origin and still requires Origin on cookie POST", async () => {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_sec_fetch" },
    });
    expect(redeemed.res.status).toBe(200);
    const cookie = cookieFrom(redeemed.res)!;

    const whoami = await request("/api/whoami", {
      cookie,
      origin: "",
      secFetchSite: "same-origin",
    });
    expect(whoami.res.status).toBe(200);
    const body = (await whoami.res.json()) as { principal: string };
    expect(body.principal).toBe("session");

    const write = await request("/api/readings", {
      method: "POST",
      cookie,
      origin: "",
      body: { url: "https://example.com/cookie-post-no-origin" },
    });
    expect(write.res.status).toBe(401);
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
          kind: "send",
          emailHash: "test-email-hash",
          emailWindowMs: 60_000,
          emailMax: 2,
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
      kind: "send",
      emailHash: "test-burst-hash",
      emailWindowMs: 60_000,
      emailMax: 2,
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

  it("counts IP on every challenge POST and email/global only when sending", async () => {
    const workerEnv = env as unknown as Env;
    const origGuard = workerEnv.AUTH_RATE_GUARD;
    const { ns, posts } = recordingRateGuard();
    workerEnv.AUTH_RATE_GUARD = ns as unknown as Env["AUTH_RATE_GUARD"];
    await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'invite_only' WHERE id = 1").run();
    try {
      const unknown = await request(
        "/api/auth/challenge",
        { method: "POST", body: { email: "nobody-rate@test.example" } },
        workerEnv,
      );
      expect(unknown.res.status).toBe(200);
      expect(unknown.sent).toHaveLength(0);
      expect(posts.map((post) => post.kind)).toEqual(["ip"]);

      const founder = await request(
        "/api/auth/challenge",
        { method: "POST", body: { email: "founder@test.example" } },
        workerEnv,
      );
      expect(founder.sent).toHaveLength(1);
      expect(posts.map((post) => post.kind)).toEqual(["ip", "ip", "send"]);
    } finally {
      workerEnv.AUTH_RATE_GUARD = origGuard;
      await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'open' WHERE id = 1").run();
    }
  });

  it("does not count email/global for allowlist-blocked challenge POSTs", async () => {
    const workerEnv = env as unknown as Env;
    const origGuard = workerEnv.AUTH_RATE_GUARD;
    const origAppEnv = workerEnv.APP_ENV;
    const origAllowlist = workerEnv.AUTH_MAIL_ALLOWLIST;
    const { ns, posts } = recordingRateGuard();
    workerEnv.AUTH_RATE_GUARD = ns as unknown as Env["AUTH_RATE_GUARD"];
    workerEnv.APP_ENV = "staging";
    workerEnv.AUTH_MAIL_ALLOWLIST = "";
    try {
      const blocked = await request(
        "/api/auth/challenge",
        { method: "POST", body: { email: "blocked-rate@test.example" } },
        workerEnv,
      );
      expect(blocked.res.status).toBe(200);
      expect(blocked.sent).toHaveLength(0);
      expect(posts.map((post) => post.kind)).toEqual(["ip"]);
    } finally {
      workerEnv.AUTH_RATE_GUARD = origGuard;
      workerEnv.APP_ENV = origAppEnv;
      if (origAllowlist === undefined) {
        delete workerEnv.AUTH_MAIL_ALLOWLIST;
      } else {
        workerEnv.AUTH_MAIL_ALLOWLIST = origAllowlist;
      }
    }
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

  it("does not revoke a live challenge when staging allowlist forbids delivery", async () => {
    const workerEnv = env as unknown as Env;
    const now = Date.parse(NOW);
    const origAppEnv = workerEnv.APP_ENV;
    const origAllowlist = workerEnv.AUTH_MAIL_ALLOWLIST;
    await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'invite_only' WHERE id = 1").run();
    await workerEnv.CONTROL_PLANE.prepare(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
       VALUES ('keep-live@test.example', 'Keep-Live@test.example', ?)`,
    )
      .bind(now)
      .run();
    try {
      const first = await request("/api/auth/challenge", {
        method: "POST",
        body: { email: "keep-live@test.example" },
      });
      expect(first.res.status).toBe(200);
      expect(first.sent).toHaveLength(1);
      const credential = credentialFrom(first.sent[0]!.verifyUrl);

      workerEnv.APP_ENV = "staging";
      workerEnv.AUTH_MAIL_ALLOWLIST = "";

      const denied = await request("/api/auth/challenge", {
        method: "POST",
        body: { email: "keep-live@test.example" },
      });
      expect(denied.res.status).toBe(200);
      expect(await denied.res.json()).toEqual({ ok: true });
      expect(denied.sent).toHaveLength(0);

      const redeemed = await request("/api/auth/redeem", {
        method: "POST",
        body: { credential, redemption_id: "clm_allowlist_keep" },
      });
      expect(redeemed.res.status).toBe(200);
    } finally {
      workerEnv.APP_ENV = origAppEnv;
      if (origAllowlist === undefined) {
        delete workerEnv.AUTH_MAIL_ALLOWLIST;
      } else {
        workerEnv.AUTH_MAIL_ALLOWLIST = origAllowlist;
      }
      await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = 'open' WHERE id = 1").run();
      await workerEnv.CONTROL_PLANE.prepare(
        "DELETE FROM signup_invites WHERE email_canonical = 'keep-live@test.example'",
      ).run();
    }
  });

  it("restores the previous live challenge when delivery throws", async () => {
    const first = await request("/api/auth/challenge", {
      method: "POST",
      body: { email: "founder@test.example" },
    });
    expect(first.sent).toHaveLength(1);
    const credential = credentialFrom(first.sent[0]!.verifyUrl);

    const app = createApp({
      services: services(),
      auth: {
        sendMagicLink: async () => {
          throw new Error("resend 400");
        },
      },
    });
    const ctx = createExecutionContext();
    const failed = await app.fetch(
      new Request("http://t/api/auth/challenge", {
        method: "POST",
        headers: { origin: "http://t", "content-type": "application/json" },
        body: JSON.stringify({ email: "founder@test.example" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ ok: true });

    const redeemed = await request("/api/auth/redeem", {
      method: "POST",
      body: { credential, redemption_id: "clm_restore_live" },
    });
    expect(redeemed.res.status).toBe(200);
  });
});
