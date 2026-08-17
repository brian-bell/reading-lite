import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticateBearer } from "../../src/control-plane/authenticate";
import { bootstrapFounder } from "../../src/control-plane/bootstrap";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import { fromD1 } from "../../src/control-plane/db";
import type { ApiScope } from "../../src/control-plane/principal";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";

const TOKEN = "test-token";

function services() {
  return {
    fetch: globalThis.fetch,
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
  const row = await workerEnv.CONTROL_PLANE.prepare(
    "SELECT id FROM users WHERE email_canonical = ?",
  )
    .bind("founder@test.example")
    .first<{ id: string }>();
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
  await workerEnv.CONTROL_PLANE.prepare(
    `INSERT INTO api_tokens (
       id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
     ) VALUES (?, ?, 'scoped', 'legacy', ?, 1, ?, ?)`,
  )
    .bind(tokenId, userId, secretHmac, Date.now(), Date.now() + 60_000)
    .run();
  for (const scope of scopes) {
    await workerEnv.CONTROL_PLANE.prepare(
      "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, ?)",
    )
      .bind(tokenId, scope)
      .run();
  }
  return secret;
}

describe("D1-backed founder principal", () => {
  it("authenticates the imported legacy bearer as only the founder tenant", async () => {
    const workerEnv = env as unknown as Env;
    const result = await authenticateBearer(fromD1(workerEnv.CONTROL_PLANE), {
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

    const users = await workerEnv.CONTROL_PLANE.prepare(
      "SELECT id, email_canonical, status FROM users",
    ).all<{ id: string; email_canonical: string; status: string }>();
    expect(users.results).toHaveLength(1);
    expect(users.results[0]?.id).toBe(result.principal.userId);
    expect(users.results[0]?.status).toBe("active");

    const res = await request("/api/readings", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a missing or wrong bearer with 401", async () => {
    expect((await request("/api/readings")).status).toBe(401);
    expect((await request("/api/readings", "Bearer wrong")).status).toBe(401);
    expect((await request("/api/readings", "Basic test-token")).status).toBe(401);
  });

  it("rejects a suspended founder with 403", async () => {
    const workerEnv = env as unknown as Env;
    await workerEnv.CONTROL_PLANE.prepare(
      "UPDATE users SET status = 'suspended' WHERE email_canonical = ?",
    )
      .bind("founder@test.example")
      .run();

    try {
      const res = await request("/api/readings", `Bearer ${TOKEN}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    } finally {
      await workerEnv.CONTROL_PLANE.prepare(
        "UPDATE users SET status = 'active' WHERE email_canonical = ?",
      )
        .bind("founder@test.example")
        .run();
    }
  });

  it("rejects a deleting founder with 403", async () => {
    const workerEnv = env as unknown as Env;
    await workerEnv.CONTROL_PLANE.prepare(
      "UPDATE users SET status = 'deleting' WHERE email_canonical = ?",
    )
      .bind("founder@test.example")
      .run();

    try {
      const res = await request("/api/readings", `Bearer ${TOKEN}`);
      expect(res.status).toBe(403);
    } finally {
      await workerEnv.CONTROL_PLANE.prepare(
        "UPDATE users SET status = 'active' WHERE email_canonical = ?",
      )
        .bind("founder@test.example")
        .run();
    }
  });

  it("refuses to bootstrap a second user onto the founder token HMAC", async () => {
    const workerEnv = env as unknown as Env;
    await expect(
      bootstrapFounder(fromD1(workerEnv.CONTROL_PLANE), {
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

    const users = await workerEnv.CONTROL_PLANE.prepare("SELECT email_canonical FROM users").all<{
      email_canonical: string;
    }>();
    expect(users.results.map((row) => row.email_canonical)).toEqual(["founder@test.example"]);
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
