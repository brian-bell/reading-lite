import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, TOKEN_MAX_TTL_MS } from "../../src/control-plane/constants";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import type { SecurityMail } from "../../src/control-plane/security-mail";
import { CSRF_HEADER, EXPECTED_TENANT_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { insertSecondTenant } from "../helpers/tenant-fixtures";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { testControlPlane } from "../helpers/control-plane-db";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ALL_SCOPES = ["readings:delete", "readings:import", "readings:read", "readings:write"] as const;

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

async function redeemSession(redemptionId: string, email = "founder@test.example") {
  const challenge = await request("/api/auth/challenge", {
    method: "POST",
    body: { email },
  });
  const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
  });
  expect(redeemed.res.status).toBe(200);
  const nextCookie = cookieFrom(redeemed.res);
  expect(nextCookie).toBeTruthy();
  const whoami = await request("/api/whoami", { cookie: nextCookie! });
  const body = (await whoami.res.json()) as { csrf_token: string };
  return { cookie: nextCookie!, csrf: body.csrf_token };
}

type CreatedToken = {
  token: string;
  id: string;
  name: string;
  scopes: string[];
  created_at_ms: number;
  expires_at_ms: number;
};

describe("API token lifecycle", () => {
  it("hides another tenant's tokens and rejects a foreign revoke without side effects", async () => {
    const workerEnv = env as unknown as Env;
    await insertSecondTenant(workerEnv);
    const owner = await redeemSession("clm_token_owner");
    const other = await redeemSession("clm_token_other", "other@test.example");
    const created = await request("/api/auth/tokens", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { name: "other-ops", scopes: ["readings:read"] },
    });
    expect(created.res.status).toBe(201);
    const foreignToken = (await created.res.json()) as CreatedToken;

    const ownerList = await request("/api/auth/tokens", { cookie: owner.cookie });
    expect(ownerList.res.status).toBe(200);
    const ownerBody = (await ownerList.res.json()) as { tokens: { id: string }[] };
    expect(ownerBody.tokens).not.toContainEqual(expect.objectContaining({ id: foreignToken.id }));

    const foreign = await request(`/api/auth/tokens/${foreignToken.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(foreign.res.status).toBe(404);
    expect(await foreign.res.json()).toEqual({ error: "not found" });
    const unknown = await request("/api/auth/tokens/tok_22222222-2222-4222-8222-222222222222", {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(unknown.res.status).toBe(foreign.res.status);
    expect(await unknown.res.json()).toEqual({ error: "not found" });
    const retained = await testControlPlane(workerEnv).first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM api_tokens WHERE id = ?",
      foreignToken.id,
    );
    expect(retained?.revoked_at).toBeNull();

    const ownerDelete = await request(`/api/auth/tokens/${foreignToken.id}`, {
      method: "DELETE",
      cookie: other.cookie,
      csrf: other.csrf,
    });
    expect(ownerDelete.res.status).toBe(200);
  });

  it("creates, lists, and revokes a token from a recent session", async () => {
    const session = await redeemSession("clm_token_create");
    const missingCsrf = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      body: { name: "ops", scopes: [...ALL_SCOPES] },
    });
    expect(missingCsrf.res.status).toBe(403);

    const securityMail: SecurityMail[] = [];
    const created = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "ops", scopes: [...ALL_SCOPES] },
      securityMail,
    });
    expect(created.res.status).toBe(201);
    const body = (await created.res.json()) as CreatedToken;
    expect(body.token).toMatch(
      /^tok_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/,
    );
    expect(body.id).toBe(body.token.slice(0, body.token.indexOf(".")));
    expect(body.name).toBe("ops");
    expect(body.scopes).toEqual([...ALL_SCOPES]);
    expect(body.created_at_ms).toBe(NOW_MS);
    expect(body.expires_at_ms).toBe(NOW_MS + TOKEN_MAX_TTL_MS);
    expect(securityMail).toHaveLength(1);
    expect(securityMail[0]?.kind).toBe("api_token_created");
    expect(`${securityMail[0]?.subject}\n${securityMail[0]?.text}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );

    const listed = await request("/api/auth/tokens", { cookie: session.cookie });
    expect(listed.res.status).toBe(200);
    const listBody = (await listed.res.json()) as {
      tokens: { id: string; usable: boolean; format: string; token?: string }[];
    };
    expect(JSON.stringify(listBody)).not.toContain(body.token);
    const minted = listBody.tokens.find((row) => row.id === body.id);
    expect(minted).toMatchObject({ usable: true, format: "standard" });
    expect(listBody.tokens.some((row) => row.format === "legacy" && row.usable)).toBe(true);

    const whoami = await request("/api/whoami", { authorization: `Bearer ${body.token}` });
    expect(whoami.res.status).toBe(200);
    expect(await whoami.res.json()).toMatchObject({ principal: "api_token" });

    const revoked = await request(`/api/auth/tokens/${body.id}`, {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
    });
    expect(revoked.res.status).toBe(200);
    expect(revoked.securityMail).toHaveLength(0);

    const afterWhoami = await request("/api/whoami", { authorization: `Bearer ${body.token}` });
    expect(afterWhoami.res.status).toBe(401);
    const afterList = await request("/api/auth/tokens", { cookie: session.cookie });
    const afterBody = (await afterList.res.json()) as { tokens: { id: string; usable: boolean }[] };
    expect(afterBody.tokens.find((row) => row.id === body.id)?.usable).toBe(false);
  });

  it("is session-only, requires recent-auth on create, and 404s an unowned id", async () => {
    const session = await redeemSession("clm_token_gates");
    const bearerGet = await request("/api/auth/tokens", { authorization: "Bearer test-token" });
    expect(bearerGet.res.status).toBe(403);
    expect(await bearerGet.res.json()).toEqual({ error: "forbidden" });

    const bearerPost = await request("/api/auth/tokens", {
      method: "POST",
      authorization: "Bearer test-token",
      body: { name: "ops", scopes: ["readings:read"] },
    });
    expect(bearerPost.res.status).toBe(403);
    expect(await bearerPost.res.json()).toEqual({ error: "forbidden" });

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

    const staleCreate = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "stale", scopes: ["readings:read"] },
    });
    expect(staleCreate.res.status).toBe(403);
    expect(await staleCreate.res.json()).toEqual({ error: "recent authentication required" });

    const listed = await request("/api/auth/tokens", { cookie: session.cookie });
    expect(listed.res.status).toBe(200);

    const missing = await request("/api/auth/tokens/tok_11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
    });
    expect(missing.res.status).toBe(404);
    const invalid = await request("/api/auth/tokens/not-a-token", {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
    });
    expect(invalid.res.status).toBe(400);

    const patched = await request("/api/auth/tokens", {
      method: "PATCH",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "nope" },
    });
    expect(patched.res.status).toBe(405);
  });

  it("rejects unknown scopes, over-TTL expiry, and the 11th active token", async () => {
    const session = await redeemSession("clm_token_cap");
    const unknown = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "ops", scopes: ["readings:admin"] },
    });
    expect(unknown.res.status).toBe(400);
    const empty = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "ops", scopes: [] },
    });
    expect(empty.res.status).toBe(400);
    const tooLong = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "ops", scopes: ["readings:read"], expires_at_ms: NOW_MS + TOKEN_MAX_TTL_MS + 1 },
    });
    expect(tooLong.res.status).toBe(400);

    const workerEnv = env as unknown as Env;
    const userId = (
      await testControlPlane(workerEnv).first<{ id: string }>(
        "SELECT id FROM users WHERE email_canonical = ?",
        "founder@test.example",
      )
    )?.id;
    expect(userId).toBeTruthy();
    const listed = await request("/api/auth/tokens", { cookie: session.cookie });
    const listBody = (await listed.res.json()) as { tokens: { id: string; usable: boolean }[] };
    const active = listBody.tokens.filter((row) => row.usable);
    const fillers: string[] = [];
    for (let i = active.length; i < 10; i += 1) {
      const id = `tok_990e8400-e29b-41d4-a716-44665544000${i}`;
      const secretHmac = await hmacHex(
        await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
        `filler-${i}`,
      );
      await testControlPlane(workerEnv).run(
        `INSERT INTO api_tokens (
           id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at
         ) VALUES (?, ?, ?, 'standard', ?, 1, ?, ?)`,
        id,
        userId,
        `filler-${i}`,
        secretHmac,
        toTimestamp(NOW_MS),
        toTimestamp(NOW_MS + TOKEN_MAX_TTL_MS),
      );
      fillers.push(id);
    }
    const blocked = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { name: "eleventh", scopes: ["readings:read"] },
    });
    expect(blocked.res.status).toBe(409);
    expect(await blocked.res.json()).toEqual({ error: "too many active tokens" });
    for (const id of fillers) {
      await testControlPlane(workerEnv).run("UPDATE api_tokens SET revoked_at = ? WHERE id = ?", toTimestamp(NOW_MS), id);
    }
  });

  it("closes a race when two creates compete for the last active slot", async () => {
    const session = await redeemSession("clm_token_race");
    const workerEnv = env as unknown as Env;
    const userId = (
      await testControlPlane(workerEnv).first<{ id: string }>(
        "SELECT id FROM users WHERE email_canonical = ?",
        "founder@test.example",
      )
    )?.id;
    expect(userId).toBeTruthy();
    const listed = await request("/api/auth/tokens", { cookie: session.cookie });
    const listBody = (await listed.res.json()) as { tokens: { id: string; usable: boolean }[] };
    const active = listBody.tokens.filter((row) => row.usable);
    const fillers: string[] = [];
    for (let i = active.length; i < 9; i += 1) {
      const id = `tok_aa0e8400-e29b-41d4-a716-44665544000${i}`;
      const secretHmac = await hmacHex(
        await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
        `race-fill-${i}`,
      );
      await testControlPlane(workerEnv).run(
        `INSERT INTO api_tokens (
           id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at
         ) VALUES (?, ?, ?, 'standard', ?, 1, ?, ?)`,
        id,
        userId,
        `race-fill-${i}`,
        secretHmac,
        toTimestamp(NOW_MS),
        toTimestamp(NOW_MS + TOKEN_MAX_TTL_MS),
      );
      fillers.push(id);
    }

    const [first, second] = await Promise.all([
      request("/api/auth/tokens", {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: { name: "race-a", scopes: ["readings:read"] },
      }),
      request("/api/auth/tokens", {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: { name: "race-b", scopes: ["readings:read"] },
      }),
    ]);
    const statuses = [first.res.status, second.res.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const loser = first.res.status === 409 ? first : second;
    expect(await loser.res.json()).toEqual({ error: "too many active tokens" });

    const after = await request("/api/auth/tokens", { cookie: session.cookie });
    const afterBody = (await after.res.json()) as { tokens: { id: string; usable: boolean }[] };
    expect(afterBody.tokens.filter((row) => row.usable)).toHaveLength(10);

    const winner = first.res.status === 201 ? first : second;
    const created = (await winner.res.json()) as CreatedToken;
    await testControlPlane(workerEnv).run(
      "UPDATE api_tokens SET revoked_at = ? WHERE id = ?",
      toTimestamp(NOW_MS),
      created.id,
    );
    for (const id of fillers) {
      await testControlPlane(workerEnv).run("UPDATE api_tokens SET revoked_at = ? WHERE id = ?", toTimestamp(NOW_MS), id);
    }
  });
});

describe("x-expected-tenant on token routes", () => {
  it("returns 412 when the pin is not the acting tenant, and mints or revokes nothing", async () => {
    const session = await redeemSession("clm_token_expected_tenant");
    const whoami = await request("/api/whoami", { cookie: session.cookie });
    const identity = (await whoami.res.json()) as { tenant_id: string };
    const mismatch = { error: "expected tenant mismatch", acting_tenant: identity.tenant_id };

    const listed = await request("/api/auth/tokens", { cookie: session.cookie, expectedTenant: "global" });
    expect(listed.res.status).toBe(412);
    expect(listed.res.headers.get("cache-control")).toBe("no-store");
    expect(await listed.res.json()).toEqual(mismatch);
    expect((await request("/api/auth/tokens", { cookie: session.cookie })).res.status).toBe(200);
    expect(
      (await request("/api/auth/tokens", { cookie: session.cookie, expectedTenant: identity.tenant_id })).res.status,
    ).toBe(200);

    const securityMail: SecurityMail[] = [];
    const refusedCreate = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: "global",
      body: { name: "pinned", scopes: ["readings:read"] },
      securityMail,
    });
    expect(refusedCreate.res.status).toBe(412);
    expect(await refusedCreate.res.json()).toEqual(mismatch);
    expect(securityMail).toHaveLength(0);

    const created = await request("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: identity.tenant_id,
      body: { name: "pinned", scopes: ["readings:read"] },
    });
    expect(created.res.status).toBe(201);
    const token = (await created.res.json()) as CreatedToken;
    const minted = (await (await request("/api/auth/tokens", { cookie: session.cookie })).res.json()) as {
      tokens: { name: string }[];
    };
    expect(minted.tokens.filter((row) => row.name === "pinned")).toHaveLength(1);

    const refusedRevoke = await request(`/api/auth/tokens/${token.id}`, {
      method: "DELETE",
      cookie: session.cookie,
      csrf: session.csrf,
      expectedTenant: "global",
    });
    expect(refusedRevoke.res.status).toBe(412);
    expect(await refusedRevoke.res.json()).toEqual(mismatch);
    expect((await request("/api/whoami", { authorization: `Bearer ${token.token}` })).res.status).toBe(200);
  });
});
