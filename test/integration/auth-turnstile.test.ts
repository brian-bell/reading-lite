import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import {
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TEST_SECRET_PASS,
  TURNSTILE_TEST_SITE_KEY_PASS,
} from "../../src/control-plane/turnstile";

const NOW = "2026-08-16T12:00:00.000Z";

function services() {
  return {
    fetch: globalThis.fetch,
    now: () => NOW,
    newId: () => "rd_AUTH01",
  };
}

function siteverifyFetch(outcome: "ok" | "fail" | "http" | "throw", calls: string[]): typeof fetch {
  return async (input, init) => {
    calls.push(String(input));
    if (String(input) !== TURNSTILE_SITEVERIFY_URL) {
      throw new Error(`unexpected fetch ${String(input)}`);
    }
    void init;
    if (outcome === "throw") throw new Error("siteverify down");
    if (outcome === "http") return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ success: outcome === "ok" }), {
      headers: { "content-type": "application/json" },
    });
  };
}

async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    origin?: string;
    fetch?: typeof fetch;
  } = {},
  workerEnv: Env = env as unknown as Env,
) {
  const sent: MagicLinkMail[] = [];
  const app = createApp({
    services: services(),
    auth: {
      sendMagicLink: async (message) => {
        sent.push(message);
      },
      ...(init.fetch ? { fetch: init.fetch } : {}),
    },
  });
  const ctx = createExecutionContext();
  const headers = new Headers();
  const origin = init.origin ?? "http://t";
  if (init.origin !== "") headers.set("origin", origin);
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

function credentialFrom(verifyUrl: string): string {
  const hash = verifyUrl.split("#")[1];
  if (!hash) throw new Error("missing fragment");
  return hash;
}

async function setSignupMode(workerEnv: Env, mode: "open" | "invite_only" | "closed"): Promise<void> {
  await workerEnv.CONTROL_PLANE.prepare("UPDATE system_policy SET signup_mode = ? WHERE id = 1").bind(mode).run();
}

async function userExists(workerEnv: Env, emailCanonical: string): Promise<boolean> {
  const row = await workerEnv.CONTROL_PLANE.prepare("SELECT id FROM users WHERE email_canonical = ?")
    .bind(emailCanonical)
    .first<{ id: string }>();
  return Boolean(row);
}

async function challengeCount(workerEnv: Env, emailCanonical: string): Promise<number> {
  const row = await workerEnv.CONTROL_PLANE.prepare(
    "SELECT COUNT(*) AS n FROM auth_challenges WHERE email_canonical = ?",
  )
    .bind(emailCanonical)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("GET /api/auth/login-options", () => {
  it("returns the site key only when signup is open and the key is configured", async () => {
    const workerEnv = env as unknown as Env;
    const origKey = workerEnv.TURNSTILE_SITE_KEY;
    try {
      await setSignupMode(workerEnv, "open");
      workerEnv.TURNSTILE_SITE_KEY = TURNSTILE_TEST_SITE_KEY_PASS;
      const open = await request("/api/auth/login-options", {}, workerEnv);
      expect(open.res.status).toBe(200);
      expect(open.res.headers.get("cache-control")).toBe("no-store");
      expect(await open.res.json()).toEqual({ turnstile_site_key: TURNSTILE_TEST_SITE_KEY_PASS });

      delete workerEnv.TURNSTILE_SITE_KEY;
      const missing = await request("/api/auth/login-options", {}, workerEnv);
      expect(await missing.res.json()).toEqual({ turnstile_site_key: null });

      workerEnv.TURNSTILE_SITE_KEY = TURNSTILE_TEST_SITE_KEY_PASS;
      await setSignupMode(workerEnv, "invite_only");
      const invite = await request("/api/auth/login-options", {}, workerEnv);
      expect(await invite.res.json()).toEqual({ turnstile_site_key: null });

      await setSignupMode(workerEnv, "closed");
      const closed = await request("/api/auth/login-options", {}, workerEnv);
      const body = (await closed.res.json()) as Record<string, unknown>;
      expect(body).toEqual({ turnstile_site_key: null });
      expect("email_exists" in body).toBe(false);
    } finally {
      if (origKey === undefined) delete workerEnv.TURNSTILE_SITE_KEY;
      else workerEnv.TURNSTILE_SITE_KEY = origKey;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("rejects a cross-origin login-options GET", async () => {
    const denied = await request("/api/auth/login-options", { origin: "https://evil.example" });
    expect(denied.res.status).toBe(403);
  });
});

describe("open-mode Turnstile on POST /api/auth/challenge", () => {
  it("provisions an unknown open-mode address when siteverify succeeds", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const calls: string[] = [];
    const email = "open-new@test.example";
    try {
      await setSignupMode(workerEnv, "open");
      workerEnv.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET_PASS;
      const challenge = await request(
        "/api/auth/challenge",
        {
          method: "POST",
          body: { email, turnstile_token: "widget-ok" },
          fetch: siteverifyFetch("ok", calls),
        },
        workerEnv,
      );
      expect(challenge.res.status).toBe(200);
      expect(await challenge.res.json()).toEqual({ ok: true });
      expect(challenge.sent).toHaveLength(1);
      expect(calls).toEqual([TURNSTILE_SITEVERIFY_URL]);
      expect(await userExists(workerEnv, email)).toBe(false);

      const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
      const redeemed = await request("/api/auth/redeem", {
        method: "POST",
        body: { credential, redemption_id: "clm_open_new" },
      });
      expect(redeemed.res.status).toBe(200);
      expect(await userExists(workerEnv, email)).toBe(true);
    } finally {
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("does not mail or create when open mode is missing a token", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const calls: string[] = [];
    const logs: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => {
      logs.push(String(args[0]));
    };
    const email = "open-notoken@test.example";
    try {
      await setSignupMode(workerEnv, "open");
      workerEnv.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET_PASS;
      const challenge = await request(
        "/api/auth/challenge",
        {
          method: "POST",
          body: { email },
          fetch: siteverifyFetch("ok", calls),
        },
        workerEnv,
      );
      expect(challenge.res.status).toBe(200);
      expect(await challenge.res.json()).toEqual({ ok: true });
      expect(challenge.sent).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(await userExists(workerEnv, email)).toBe(false);
      expect(await challengeCount(workerEnv, email)).toBe(0);
      expect(logs.some((line) => line.includes("magic_link_turnstile_rejected"))).toBe(true);
    } finally {
      console.info = origInfo;
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("applies the same verify path to an existing open-mode user", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const calls: string[] = [];
    try {
      await setSignupMode(workerEnv, "open");
      workerEnv.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET_PASS;
      const denied = await request(
        "/api/auth/challenge",
        {
          method: "POST",
          body: { email: "founder@test.example" },
          fetch: siteverifyFetch("ok", calls),
        },
        workerEnv,
      );
      expect(await denied.res.json()).toEqual({ ok: true });
      expect(denied.sent).toHaveLength(0);
      expect(calls).toHaveLength(0);

      const allowed = await request(
        "/api/auth/challenge",
        {
          method: "POST",
          body: { email: "founder@test.example", turnstile_token: "widget-ok" },
          fetch: siteverifyFetch("ok", calls),
        },
        workerEnv,
      );
      expect(allowed.sent).toHaveLength(1);
      expect(calls).toEqual([TURNSTILE_SITEVERIFY_URL]);
    } finally {
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("fail-closes when siteverify reports failure or errors while the secret is set", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const email = "open-sitefail@test.example";
    try {
      await setSignupMode(workerEnv, "open");
      workerEnv.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET_PASS;
      for (const outcome of ["fail", "http", "throw"] as const) {
        const calls: string[] = [];
        const challenge = await request(
          "/api/auth/challenge",
          {
            method: "POST",
            body: { email, turnstile_token: "widget-bad" },
            fetch: siteverifyFetch(outcome, calls),
          },
          workerEnv,
        );
        expect(await challenge.res.json()).toEqual({ ok: true });
        expect(challenge.sent).toHaveLength(0);
        expect(await userExists(workerEnv, email)).toBe(false);
        if (outcome === "throw") expect(calls).toEqual([TURNSTILE_SITEVERIFY_URL]);
      }
    } finally {
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("fail-closes staging open-mode sends when the secret is missing", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const origAppEnv = workerEnv.APP_ENV;
    const origAllowlist = workerEnv.AUTH_MAIL_ALLOWLIST;
    try {
      await setSignupMode(workerEnv, "open");
      delete workerEnv.TURNSTILE_SECRET_KEY;
      workerEnv.APP_ENV = "staging";
      workerEnv.AUTH_MAIL_ALLOWLIST = "founder@test.example";
      const challenge = await request(
        "/api/auth/challenge",
        { method: "POST", body: { email: "founder@test.example", turnstile_token: "ignored" } },
        workerEnv,
      );
      expect(await challenge.res.json()).toEqual({ ok: true });
      expect(challenge.sent).toHaveLength(0);
    } finally {
      workerEnv.APP_ENV = origAppEnv;
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      if (origAllowlist === undefined) delete workerEnv.AUTH_MAIL_ALLOWLIST;
      else workerEnv.AUTH_MAIL_ALLOWLIST = origAllowlist;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("closed existing still mails without a Turnstile token when the secret is set", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const calls: string[] = [];
    try {
      await setSignupMode(workerEnv, "closed");
      workerEnv.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET_PASS;
      const challenge = await request(
        "/api/auth/challenge",
        {
          method: "POST",
          body: { email: "founder@test.example" },
          fetch: siteverifyFetch("fail", calls),
        },
        workerEnv,
      );
      expect(challenge.res.status).toBe(200);
      expect(challenge.sent).toHaveLength(1);
      expect(calls).toHaveLength(0);
    } finally {
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("invite_only unknown still returns {ok:true} without a token and ignores extras", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const calls: string[] = [];
    const email = "invite-unknown@test.example";
    try {
      await setSignupMode(workerEnv, "invite_only");
      workerEnv.TURNSTILE_SECRET_KEY = TURNSTILE_TEST_SECRET_PASS;
      const challenge = await request(
        "/api/auth/challenge",
        {
          method: "POST",
          body: { email, turnstile_token: "extra" },
          fetch: siteverifyFetch("ok", calls),
        },
        workerEnv,
      );
      expect(challenge.res.status).toBe(200);
      expect(await challenge.res.json()).toEqual({ ok: true });
      expect(challenge.sent).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(await userExists(workerEnv, email)).toBe(false);
    } finally {
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });

  it("local open without a Turnstile secret still sends (fail-open)", async () => {
    const workerEnv = env as unknown as Env;
    const origSecret = workerEnv.TURNSTILE_SECRET_KEY;
    const origAppEnv = workerEnv.APP_ENV;
    const email = "local-failopen@test.example";
    try {
      await setSignupMode(workerEnv, "open");
      delete workerEnv.TURNSTILE_SECRET_KEY;
      workerEnv.APP_ENV = "local";
      const challenge = await request(
        "/api/auth/challenge",
        { method: "POST", body: { email } },
        workerEnv,
      );
      expect(challenge.sent).toHaveLength(1);
      expect(await userExists(workerEnv, email)).toBe(false);
    } finally {
      workerEnv.APP_ENV = origAppEnv;
      if (origSecret === undefined) delete workerEnv.TURNSTILE_SECRET_KEY;
      else workerEnv.TURNSTILE_SECRET_KEY = origSecret;
      await setSignupMode(workerEnv, "open");
    }
  });
});
