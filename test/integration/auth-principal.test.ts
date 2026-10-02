import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticateBearer } from "../../src/control-plane/authenticate";
import { bootstrapFounder } from "../../src/control-plane/bootstrap";
import { deriveHmacKey, hmacHex, parseAuthRootSecret, parseProviderKeySecret } from "../../src/control-plane/crypto";
import type { ApiScope } from "../../src/control-plane/principal";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";
import { testControlPlane } from "../helpers/control-plane-db";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { upsertProviderCredential } from "../../src/control-plane/provider-credentials";

const TOKEN = "test-token";

function services() {
  return {
    fetch: globalThis.fetch,
    lookup: async () => [{ address: "93.184.216.34" }],
    now: () => "2026-08-16T12:00:00.000Z",
    newId: () => "rd_AUTH01",
  };
}

async function request(
  path: string,
  authorization?: string,
  init: { method?: string; body?: unknown } = {},
) {
  const app = createApp({ services: services() });
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
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
  return res;
}

async function founderUserId(): Promise<string> {
  const workerEnv = env as unknown as Env;
  const row = await testControlPlane(workerEnv).first<{ id: string }>(
    "SELECT id FROM users WHERE email_canonical = ?",
    "founder@test.example",
  );
  if (!row) throw new Error("founder user missing");
  return row.id;
}

async function insertScopedToken(secret: string, scopes: readonly ApiScope[]): Promise<string> {
  const workerEnv = env as unknown as Env;
  const userId = await founderUserId();
  const tokenId = `tok_${crypto.randomUUID()}`;
  const secretHmac = await hmacHex(
    await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
    secret,
  );
  await testControlPlane(workerEnv).run(
    `INSERT INTO api_tokens (
       id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at
     ) VALUES (?, ?, 'scoped', 'legacy', ?, 1, ?, ?)`,
    tokenId, userId, secretHmac, toTimestamp(Date.now()), toTimestamp(Date.now() + 60_000),
  );
  for (const scope of scopes) {
    await testControlPlane(workerEnv).run(
      "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, ?)",
      tokenId, scope,
    );
  }
  return secret;
}

describe("founder principal", () => {
  it("authenticates the imported legacy bearer as only the founder tenant", async () => {
    const workerEnv = env as unknown as Env;
    const result = await authenticateBearer(testControlPlane(workerEnv), {
      authorization: `Bearer ${TOKEN}`,
      authRoot: {
        secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET),
        version: 1,
      },
      nowMs: Date.now(),
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.principal.kind).toBe("api_token");
    expect(result.principal.userId).toBe(result.principal.tenantId);
    expect(result.principal.userId).toMatch(/^usr_[0-9a-f-]{36}$/);

    const users = await testControlPlane(workerEnv).all<{ id: string; email_canonical: string; status: string }>(
      "SELECT id, email_canonical, status FROM users",
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(result.principal.userId);
    expect(users[0]?.status).toBe("active");

    const res = await request("/api/readings", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a missing or wrong bearer with 401", async () => {
    expect((await request("/api/readings")).status).toBe(401);
    expect((await request("/api/readings", "Bearer wrong")).status).toBe(401);
    expect((await request("/api/readings", "Basic test-token")).status).toBe(401);
    expect((await request("/api/whoami")).status).toBe(401);
    expect((await request("/api/whoami", "Bearer wrong")).status).toBe(401);
  });

  it.each(["suspended", "deleting"])("rejects a %s founder with 403", async (status) => {
    const workerEnv = env as unknown as Env;
    await testControlPlane(workerEnv).run(
      "UPDATE users SET status = ? WHERE email_canonical = ?",
      status, "founder@test.example",
    );

    try {
      const res = await request("/api/readings", `Bearer ${TOKEN}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    } finally {
      await testControlPlane(workerEnv).run(
        "UPDATE users SET status = 'active' WHERE email_canonical = ?",
        "founder@test.example",
      );
    }
  });

  it("refuses to bootstrap a second user onto the founder token HMAC", async () => {
    const workerEnv = env as unknown as Env;
    await expect(
      bootstrapFounder(testControlPlane(workerEnv), {
        email: "other@test.example",
        legacyToken: TOKEN,
        signupMode: "open",
        nowMs: Date.now(),
        authRoot: {
          secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET),
          version: 1,
        },
      }),
    ).rejects.toThrow(/different user|owned by a different user/i);

    const users = await testControlPlane(workerEnv).all<{
      email_canonical: string;
    }>(
      "SELECT email_canonical FROM users",
    );
    expect(users.map((row) => row.email_canonical)).toEqual(["founder@test.example"]);
  });
});

describe("api token scope matrix", () => {
  const readRoutes = [
    "/api/readings",
    "/api/readings/lookup?url=https://example.com/missing",
    "/api/readings/rd_missing",
    "/api/readings/rd_missing/content",
    "/api/readings/rd_missing/content/raw",
    "/api/readings/rd_missing/diagnostics",
  ];
  const writePosts = [
    { path: "/api/readings", body: {} },
    { path: "/api/readings/rd_missing/reprocess", body: {} },
    { path: "/api/readings/similar", body: {} },
  ];

  it("allows readings:read on GET routes and forbids writes and import", async () => {
    const secret = await insertScopedToken("scope-read-only", ["readings:read"]);
    const auth = `Bearer ${secret}`;
    for (const path of readRoutes) {
      const res = await request(path, auth);
      expect(res.status, path).not.toBe(403);
      expect(res.status, path).not.toBe(401);
    }
    for (const { path, body } of writePosts) {
      const res = await request(path, auth, { method: "POST", body });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    const imported = await request("/api/readings/import-markdown", auth, { method: "POST", body: {} });
    expect(imported.status).toBe(403);
  });

  it("allows readings:write on write POSTs and forbids reads and import", async () => {
    const secret = await insertScopedToken("scope-write-only", ["readings:write"]);
    const auth = `Bearer ${secret}`;
    for (const path of readRoutes) {
      expect((await request(path, auth)).status, path).toBe(403);
    }
    for (const { path, body } of writePosts) {
      const res = await request(path, auth, { method: "POST", body });
      expect(res.status, path).not.toBe(403);
      expect(res.status, path).not.toBe(401);
    }
    expect(
      (await request("/api/readings/import-markdown", auth, { method: "POST", body: {} })).status,
    ).toBe(403);
  });

  it("requires readings:delete for DELETE and grants nothing else with it", async () => {
    // Every pre-delete scope together still cannot delete.
    const legacyScopes = await insertScopedToken("scope-no-delete", [
      "readings:read",
      "readings:write",
      "readings:import",
    ]);
    const refused = await request("/api/readings/rd_missing", `Bearer ${legacyScopes}`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden" });

    // A delete-only token can delete (404 here: nothing to purge) but neither
    // read nor write.
    const deleter = await insertScopedToken("scope-delete-only", ["readings:delete"]);
    const auth = `Bearer ${deleter}`;
    const allowed = await request("/api/readings/rd_missing", auth, { method: "DELETE" });
    expect(allowed.status).toBe(404);
    for (const path of readRoutes) {
      expect((await request(path, auth)).status, path).toBe(403);
    }
    for (const { path, body } of writePosts) {
      expect((await request(path, auth, { method: "POST", body })).status, path).toBe(403);
    }
  });

  it("allows readings:import on import-markdown and forbids reads and writes", async () => {
    const secret = await insertScopedToken("scope-import-only", ["readings:import"]);
    const auth = `Bearer ${secret}`;
    for (const path of readRoutes) {
      expect((await request(path, auth)).status, path).toBe(403);
    }
    for (const { path, body } of writePosts) {
      expect((await request(path, auth, { method: "POST", body })).status, path).toBe(403);
    }
    const imported = await request("/api/readings/import-markdown", auth, { method: "POST", body: {} });
    expect(imported.status).not.toBe(403);
    expect(imported.status).not.toBe(401);
  });
});

describe("GET /api/whoami", () => {
  async function whoami(authorization?: string, envOverride?: Partial<Env>) {
    const app = createApp({ services: services() });
    const ctx = createExecutionContext();
    const headers = new Headers();
    if (authorization) headers.set("authorization", authorization);
    const res = await app.fetch(
      new Request("http://t/api/whoami", { headers }),
      { ...(env as unknown as Env), ...envOverride },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("returns the bearer token's own tenant identity, uncacheable", async () => {
    const res = await whoami(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tenant_id).toBe(await founderUserId());
    expect(body.user_id).toBe(body.tenant_id);
    expect(body.principal).toBe("api_token");
    // wrangler.test.toml runs the Workers pool with TENANT_DATA_PLANE=1.
    expect(body.tenant_data_plane).toBe(true);
    expect("csrf_token" in body).toBe(false);
  });

  it("reports the data-plane gate off when TENANT_DATA_PLANE is unset", async () => {
    const res = await whoami(`Bearer ${TOKEN}`, { TENANT_DATA_PLANE: undefined });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tenant_data_plane).toBe(false);
  });

  it.each([
    { name: "switch off, no key", switch: undefined, key: false, needs: false },
    { name: "switch on, no key", switch: "1", key: false, needs: true },
    { name: "switch on, active key", switch: "1", key: true, needs: false },
  ] as const)("reports needs_provider_key $needs ($name)", async (row) => {
    if (row.key) {
      await upsertProviderCredential(testControlPlane(env), {
        tenantId: await founderUserId(),
        plaintext: "sk-whoami-key-1234",
        root: { secret: parseProviderKeySecret("ab".repeat(32)), version: 1 },
        nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
        validatedAtMs: null,
      });
    }
    const res = await whoami(`Bearer ${TOKEN}`, { TENANT_PROVIDER_KEYS: row.switch });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).needs_provider_key).toBe(row.needs);
  });

  it("answers any authenticated principal regardless of scopes", async () => {
    const secret = await insertScopedToken("whoami-no-scopes", []);
    const res = await whoami(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tenant_id).toBe(await founderUserId());
  });
});

describe("x-expected-tenant layout pin", () => {
  async function readings(expected: string | undefined, envOverride?: Partial<Env>) {
    const app = createApp({ services: services() });
    const ctx = createExecutionContext();
    const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
    if (expected !== undefined) headers.set("x-expected-tenant", expected);
    const res = await app.fetch(
      new Request("http://t/api/readings", { headers }),
      { ...(env as unknown as Env), ...envOverride },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  // wrangler.test.toml runs the Workers pool with TENANT_DATA_PLANE=1, so the
  // acting layout is the principal's tenant namespace.
  it("rejects a pin naming a layout the request would not act on", async () => {
    const gateOn = await readings("global");
    expect(gateOn.status).toBe(412);
    expect(gateOn.headers.get("cache-control")).toBe("no-store");
    const body = (await gateOn.json()) as Record<string, unknown>;
    expect(body.error).toBe("expected tenant mismatch");
    expect(body.acting_tenant).toBe(await founderUserId());

    const gateOff = await readings(await founderUserId(), { TENANT_DATA_PLANE: undefined });
    expect(gateOff.status).toBe(412);
    expect(((await gateOff.json()) as Record<string, unknown>).acting_tenant).toBe("global");
  });

  it("passes a pin matching the acting layout, and requests with no pin", async () => {
    expect((await readings(await founderUserId())).status).toBe(200);
    expect((await readings("global", { TENANT_DATA_PLANE: undefined })).status).toBe(200);
    expect((await readings(undefined)).status).toBe(200);
  });
});
