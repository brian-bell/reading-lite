import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_USAGE_GUARD_NAME, SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { utcSpendDay, utcSpendDayResetAt } from "../../src/control-plane/spend-ledger";
import { parseProviderKeySecret } from "../../src/control-plane/crypto";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { decryptProviderKey } from "../../src/control-plane/provider-key-crypto";
import { readProviderCredential } from "../../src/control-plane/provider-credentials";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { CSRF_HEADER, EXPECTED_TENANT_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import { testControlPlane } from "../helpers/control-plane-db";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID, insertSecondTenant } from "../helpers/tenant-fixtures";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const SUMMARY_MODEL = "gpt-catalog-fixed";
const EMBEDDING_MODEL = "text-embedding-3-small";
const OPERATOR = 100_000_000_000;
const OTHER_OPERATOR = 1_000_000;
const KEY = "sk-catalog-key-1234";
const REPLACEMENT = "sk-catalog-key-5678";

beforeEach(() => {
  const workerEnv = env as unknown as Env;
  workerEnv.PROVIDER_KEY_SECRET = SECRET;
  workerEnv.OPENAI_SUMMARIZATION_MODEL = SUMMARY_MODEL;
  delete workerEnv.PROVIDER_KEY_VERSION;
  delete workerEnv.TENANT_PROVIDER_KEYS;
});

function catalog(ids: string[] | number | "throw") {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (ids === "throw") throw new Error("network down");
    if (typeof ids === "number") return new Response("upstream", { status: ids });
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const BOTH = [SUMMARY_MODEL, EMBEDDING_MODEL];

async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    cookie?: string;
    csrf?: string;
    authorization?: string;
    expectedTenant?: string;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const sent: MagicLinkMail[] = [];
  const app = createApp({
    services: {
      fetch: init.fetchImpl ?? globalThis.fetch,
      lookup: async () => [{ address: "93.184.216.34" }],
      now: () => NOW,
      newId: () => "rd_AUTH01",
    },
    auth: { sendMagicLink: async (message) => { sent.push(message); } },
  });
  const ctx = createExecutionContext();
  const headers = new Headers({ origin: "http://t" });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.csrf) headers.set(CSRF_HEADER, init.csrf);
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.expectedTenant !== undefined) headers.set(EXPECTED_TENANT_HEADER, init.expectedTenant);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sent };
}

function cookieFrom(res: Response): string {
  const value = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(value);
  if (!match) throw new Error("missing session cookie");
  return `${SESSION_COOKIE_NAME}=${match[1]}`;
}

async function redeem(email: string, redemptionId: string) {
  const challenge = await request("/api/auth/challenge", { method: "POST", body: { email } });
  expect(challenge.sent).toHaveLength(1);
  const credential = challenge.sent[0]!.verifyUrl.split("#")[1]!;
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
  });
  expect(redeemed.res.status).toBe(200);
  const cookie = cookieFrom(redeemed.res);
  const whoami = await request("/api/whoami", { cookie });
  const identity = (await whoami.res.json()) as { csrf_token: string; user_id: string; tenant_id: string };
  return { cookie, csrf: identity.csrf_token, userId: identity.user_id, tenantId: identity.tenant_id };
}

async function storedKey(userId: string): Promise<string | null> {
  const stored = await readProviderCredential(testControlPlane(env), userId);
  if (!stored) return null;
  return decryptProviderKey({
    roots: { providerKeyRoot: { secret: parseProviderKeySecret(SECRET), version: 1 } },
    tenantId: userId,
    credentialVersion: stored.credentialVersion,
    keyVersion: stored.keyVersion,
    ciphertext: stored.ciphertext,
    iv: stored.iv,
  });
}

function masked(lastFour: string, patch: Record<string, unknown> = {}) {
  return {
    credential: {
      provider: "openai",
      last_four: lastFour,
      status: "active",
      validated_at_ms: NOW_MS,
    },
    key_required: false,
    effort: "high",
    daily_spend_cap_microdollars: null,
    effective_daily_spend_microdollars: OPERATOR,
    operator_daily_spend_microdollars: OPERATOR,
    ...patch,
  };
}

describe("/api/auth/provider", () => {
  it("rejects an API bearer on every provider route", async () => {
    const routes = [
      { method: "GET", path: "/api/auth/provider" },
      { method: "POST", path: "/api/auth/provider", body: { api_key: KEY } },
      { method: "DELETE", path: "/api/auth/provider" },
      { method: "POST", path: "/api/auth/provider/preferences", body: { effort: "low" } },
      { method: "GET", path: "/api/auth/provider/usage" },
    ];
    for (const route of routes) {
      const { res } = await request(route.path, {
        method: route.method,
        authorization: "Bearer test-token",
        ...("body" in route ? { body: route.body } : {}),
      });
      expect(res.status, route.path).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(await storedKey(FOUNDER_TENANT_ID)).toBeNull();
  });

  it("requires the CSRF header on connect, remove, and preference changes", async () => {
    const session = await redeem("founder@test.example", "clm_provider_csrf");
    const list = catalog(BOTH);
    const connect = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      body: { api_key: KEY },
      fetchImpl: list.fetchImpl,
    });
    expect(connect.res.status).toBe(403);
    expect(await connect.res.json()).toEqual({ error: "forbidden" });
    expect(list.calls).toEqual([]);

    const preferences = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      body: { effort: "low" },
    });
    expect(preferences.res.status).toBe(403);
    expect(await preferences.res.json()).toEqual({ error: "forbidden" });

    const remove = await request("/api/auth/provider", {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(remove.res.status).toBe(403);
    expect(await remove.res.json()).toEqual({ error: "forbidden" });

    const read = await request("/api/auth/provider", { cookie: session.cookie });
    expect(read.res.status).toBe(200);
    expect(await read.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "high",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: OPERATOR,
      operator_daily_spend_microdollars: OPERATOR,
    });
    expect(await storedKey(session.userId)).toBeNull();
  });

  it("requires recent sign-in to connect, replace, and remove", async () => {
    const session = await redeem("founder@test.example", "clm_provider_recent");
    const list = catalog(BOTH);
    const connected = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: KEY },
      fetchImpl: list.fetchImpl,
    });
    expect(connected.res.status).toBe(200);

    const workerEnv = env as unknown as Env;
    const current = (
      await testControlPlane(workerEnv).first<{ id: string }>(
        "SELECT id FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
    )?.id;
    expect(current).toBeTruthy();
    await testControlPlane(workerEnv).run(
      "UPDATE sessions SET authenticated_at = ? WHERE id = ?",
      toTimestamp(NOW_MS - 11 * 60 * 1000),
      current,
    );

    const read = await request("/api/auth/provider", { cookie: session.cookie });
    expect(read.res.status).toBe(200);
    expect(await read.res.json()).toEqual(masked("1234"));

    const effort = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { effort: "medium" },
    });
    expect(effort.res.status).toBe(200);
    expect(await effort.res.json()).toEqual(masked("1234", { effort: "medium" }));

    const replace = catalog(BOTH);
    const replaced = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: REPLACEMENT },
      fetchImpl: replace.fetchImpl,
    });
    expect(replaced.res.status).toBe(403);
    expect(await replaced.res.json()).toEqual({ error: "recent authentication required" });
    expect(replace.calls).toEqual([]);
    expect(await storedKey(session.userId)).toBe(KEY);

    const removed = await request("/api/auth/provider", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
    });
    expect(removed.res.status).toBe(403);
    expect(await removed.res.json()).toEqual({ error: "recent authentication required" });
    expect(await storedKey(session.userId)).toBe(KEY);
  });

  it("returns 412 when the tenant pin is not the acting tenant and stores nothing", async () => {
    const session = await redeem("founder@test.example", "clm_provider_pin");
    const mismatch = { error: "expected tenant mismatch", acting_tenant: session.tenantId };
    const read = await request("/api/auth/provider", { cookie: session.cookie, expectedTenant: "global" });
    expect(read.res.status).toBe(412);
    expect(await read.res.json()).toEqual(mismatch);

    const list = catalog(BOTH);
    const write = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: "global",
      body: { api_key: KEY },
      fetchImpl: list.fetchImpl,
    });
    expect(write.res.status).toBe(412);
    expect(await write.res.json()).toEqual(mismatch);
    expect(list.calls).toEqual([]);
    expect(await storedKey(session.userId)).toBeNull();
  });

  it("stores a catalog-checked key and returns only the mask", async () => {
    const session = await redeem("founder@test.example", "clm_provider_store");
    const list = catalog(BOTH);
    const connected = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: KEY },
      fetchImpl: list.fetchImpl,
    });
    expect(connected.res.status).toBe(200);
    expect(await connected.res.json()).toEqual(masked("1234"));
    expect(list.calls).toEqual([
      { url: "https://api.openai.com/v1/models", authorization: `Bearer ${KEY}` },
    ]);
    expect(await storedKey(session.userId)).toBe(KEY);

    const replacement = catalog(BOTH);
    const replaced = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: REPLACEMENT },
      fetchImpl: replacement.fetchImpl,
    });
    expect(replaced.res.status).toBe(200);
    expect(await replaced.res.json()).toEqual(masked("5678"));
    expect(await storedKey(session.userId)).toBe(REPLACEMENT);
  });

  it.each([
    {
      name: "an invalid key",
      ids: 401 as const,
      status: 400,
      body: { error: "invalid key", code: "invalid_key" },
    },
    {
      name: "a missing summarization model",
      ids: [EMBEDDING_MODEL],
      status: 400,
      body: { error: "model access", code: "model_access" },
    },
    {
      name: "an unreachable provider",
      ids: "throw" as const,
      status: 503,
      body: { error: "provider unavailable", code: "provider_unavailable" },
    },
  ])("stores nothing for $name", async ({ ids, status, body }) => {
    const session = await redeem("founder@test.example", `clm_provider_reject_${status}`);
    const first = catalog(BOTH);
    const connected = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: KEY },
      fetchImpl: first.fetchImpl,
    });
    expect(connected.res.status).toBe(200);

    const rejected = catalog(ids);
    const attempt = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: REPLACEMENT },
      fetchImpl: rejected.fetchImpl,
    });
    expect(attempt.res.status).toBe(status);
    expect(await attempt.res.json()).toEqual(body);
    expect(await storedKey(session.userId)).toBe(KEY);
    const read = await request("/api/auth/provider", { cookie: session.cookie });
    expect(await read.res.json()).toEqual(masked("1234"));
  });

  it("stores nothing when the first check fails", async () => {
    const session = await redeem("founder@test.example", "clm_provider_first_reject");
    const list = catalog(401);
    const attempt = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: KEY },
      fetchImpl: list.fetchImpl,
    });
    expect(attempt.res.status).toBe(400);
    expect(await attempt.res.json()).toEqual({ error: "invalid key", code: "invalid_key" });
    expect(await storedKey(session.userId)).toBeNull();
  });

  it("does not call OpenAI when the key cannot be stored", async () => {
    const session = await redeem("founder@test.example", "clm_provider_nosecret");
    delete (env as unknown as Env).PROVIDER_KEY_SECRET;
    const list = catalog(BOTH);
    try {
      const attempt = await request("/api/auth/provider", {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: { api_key: KEY },
        fetchImpl: list.fetchImpl,
      });
      expect(attempt.res.status).toBe(500);
      expect(await attempt.res.json()).toEqual({ error: "auth misconfigured" });
      expect(list.calls).toEqual([]);
      expect(await storedKey(session.userId)).toBeNull();
    } finally {
      (env as unknown as Env).PROVIDER_KEY_SECRET = SECRET;
    }
  });

  it("says a key is required when tenant provider keys are on", async () => {
    (env as unknown as Env).TENANT_PROVIDER_KEYS = "1";
    const session = await redeem("founder@test.example", "clm_provider_required");
    const read = await request("/api/auth/provider", { cookie: session.cookie });
    expect(read.res.status).toBe(200);
    expect(await read.res.json()).toMatchObject({ credential: null, key_required: true });
  });

  it("removes the key and leaves effort in place", async () => {
    const session = await redeem("founder@test.example", "clm_provider_delete");
    const connected = await request("/api/auth/provider", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: KEY },
      fetchImpl: catalog(BOTH).fetchImpl,
    });
    expect(connected.res.status).toBe(200);
    const effort = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { effort: "low" },
    });
    expect(effort.res.status).toBe(200);

    const removed = await request("/api/auth/provider", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
    });
    expect(removed.res.status).toBe(200);
    expect(await removed.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "low",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: OPERATOR,
      operator_daily_spend_microdollars: OPERATOR,
    });
    expect(await storedKey(session.userId)).toBeNull();

    const again = await request("/api/auth/provider", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
    });
    expect(again.res.status).toBe(200);
    expect(await again.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "low",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: OPERATOR,
      operator_daily_spend_microdollars: OPERATOR,
    });
  });

  it("refuses a cap above the operator default and accepts a lower one", async () => {
    const session = await redeem("founder@test.example", "clm_provider_cap");
    const above = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { effort: "low", daily_spend_cap_microdollars: OPERATOR + 1 },
    });
    expect(above.res.status).toBe(400);
    expect(await above.res.json()).toEqual({
      error: "cap above operator default",
      code: "cap_above_operator_default",
    });
    const unchanged = await request("/api/auth/provider", { cookie: session.cookie });
    expect(await unchanged.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "high",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: OPERATOR,
      operator_daily_spend_microdollars: OPERATOR,
    });

    const lowered = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { daily_spend_cap_microdollars: 250_000 },
    });
    expect(lowered.res.status).toBe(200);
    expect(await lowered.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "high",
      daily_spend_cap_microdollars: 250_000,
      effective_daily_spend_microdollars: 250_000,
      operator_daily_spend_microdollars: OPERATOR,
    });

    await testControlPlane(env).run(
      "UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?",
      100_000,
      session.userId,
    );
    const tightened = await request("/api/auth/provider", { cookie: session.cookie });
    expect(tightened.res.status).toBe(200);
    expect(await tightened.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "high",
      daily_spend_cap_microdollars: 250_000,
      effective_daily_spend_microdollars: 100_000,
      operator_daily_spend_microdollars: 100_000,
    });
    await testControlPlane(env).run(
      "UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?",
      OPERATOR,
      session.userId,
    );

    const ceiling = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { effort: "low", daily_spend_cap_microdollars: OPERATOR },
    });
    expect(ceiling.res.status).toBe(200);
    expect(await ceiling.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "low",
      daily_spend_cap_microdollars: OPERATOR,
      effective_daily_spend_microdollars: OPERATOR,
      operator_daily_spend_microdollars: OPERATOR,
    });

    const cleared = await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { daily_spend_cap_microdollars: null },
    });
    expect(cleared.res.status).toBe(200);
    expect(await cleared.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "low",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: OPERATOR,
      operator_daily_spend_microdollars: OPERATOR,
    });
  });

  it("does not show another tenant's key", async () => {
    const workerEnv = env as unknown as Env;
    await insertSecondTenant(workerEnv);
    const owner = await redeem("founder@test.example", "clm_provider_owner");
    const other = await redeem("other@test.example", "clm_provider_other");
    const connected = await request("/api/auth/provider", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { api_key: KEY },
      fetchImpl: catalog(BOTH).fetchImpl,
    });
    expect(connected.res.status).toBe(200);

    const otherRead = await request("/api/auth/provider", { cookie: other.cookie });
    expect(otherRead.res.status).toBe(200);
    expect(await otherRead.res.json()).toEqual({
      credential: null,
      key_required: false,
      effort: "high",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: OTHER_OPERATOR,
      operator_daily_spend_microdollars: OTHER_OPERATOR,
    });
    expect(await storedKey(other.userId)).toBeNull();
    expect(await storedKey(owner.userId)).toBe(KEY);
  });
});

// Charges land through the guard itself, as hosted dispatch would make them.
async function chargeToday(tenantId: string, opId: string, maxMicrodollars: number) {
  const ns = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
  const stub = ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME));
  const quote = { dayKey: utcSpendDay(Date.now()), catalogVersion: 1, requestFingerprint: opId, maxMicrodollars };
  for (const kind of ["reserve_spend", "mark_spend_dispatched"]) {
    const response = await stub.fetch("https://guard/", {
      method: "POST",
      body: JSON.stringify({ kind, payer: "tenant", tenantId, opId, quote, nowMs: Date.now() }),
    });
    expect(await response.json(), kind).toMatchObject({ ok: true });
  }
}

describe("/api/auth/provider/usage", () => {
  it("shows the reader's own charges today against their effective cap", async () => {
    await insertSecondTenant(env as unknown as Env);
    const session = await redeem("founder@test.example", "clm_provider_usage");
    await chargeToday(session.userId, "usage-own", 25);
    await chargeToday(OTHER_TENANT_ID, "usage-other", 40);
    await request("/api/auth/provider/preferences", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { daily_spend_cap_microdollars: 250_000 },
    });

    const before = Date.now();
    const { res } = await request("/api/auth/provider/usage", { cookie: session.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { observed_at_ms: number };
    expect(body).toEqual({
      day_key: utcSpendDay(body.observed_at_ms),
      charged_microdollars: 25,
      effective_daily_spend_microdollars: 250_000,
      reset_at_ms: utcSpendDayResetAt(body.observed_at_ms),
      observed_at_ms: expect.any(Number),
    });
    expect(body.observed_at_ms).toBeGreaterThanOrEqual(before);
  });

  it("answers 503 with no figure when the spend authority is unreachable", async () => {
    const session = await redeem("founder@test.example", "clm_provider_usage_down");
    const workerEnv = env as unknown as Env;
    const guard = workerEnv.GLOBAL_USAGE_GUARD;
    delete workerEnv.GLOBAL_USAGE_GUARD;
    try {
      const { res } = await request("/api/auth/provider/usage", { cookie: session.cookie });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "usage unavailable" });
    } finally {
      workerEnv.GLOBAL_USAGE_GUARD = guard;
    }
  });
});
