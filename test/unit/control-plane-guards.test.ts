// Control-plane guards no integration test owns: account teardown's last
// checks before the users row is hard-deleted, paid dispatch's refusal to call
// a provider without clean admission or with another provider's key header,
// and provider-key ciphertext binding.
//
// Teardown runs against PostgreSQL so the foreign keys are enforced as in
// production; useControlPlane rolls each test back.

import { describe, expect, it, vi } from "vitest";
import { beginAccountDeletion } from "../../src/control-plane/account-delete";
import { tearDownAccount, type AccountTeardownEnv, type PrefixVerdict } from "../../src/control-plane/account-teardown";
import { bootstrapFounder } from "../../src/control-plane/bootstrap";
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from "../../src/control-plane/constants";
import { parseAuthRootSecret, parseProviderKeySecret } from "../../src/control-plane/crypto";
import type { ControlPlaneDb } from "../../src/control-plane/db";
import { createPaidFetch, SpendAdmissionError, type SpendRpc } from "../../src/control-plane/paid-dispatch";
import { decryptProviderKey, encryptProviderKey } from "../../src/control-plane/provider-key-crypto";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { buildSummarizeRequestBody as buildAnthropicBody } from "../../src/modules/anthropic";
import { useControlPlane } from "../helpers/control-plane-pg";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-09-04T10:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const OTHER = "usr_11111111-1111-4111-8111-111111111111";
const EMAIL = "founder@example.com";

describe("tearDownAccount", () => {
  const openControlPlane = useControlPlane();

  /** Tables teardown empties; a refusal must leave every one of them standing. */
  const CHILD_TABLES = [
    ["user_settings", "user_id"],
    ["api_tokens", "user_id"],
    ["sessions", "user_id"],
    ["wipe_progress", "tenant_id"],
    ["tenant_provider_credentials", "tenant_id"],
  ] as const;

  /** A tenant fenced by `DELETE /api/account` whose wipe has completed. */
  async function seeded() {
    const { raw, db } = openControlPlane();
    await bootstrapFounder(db, {
      email: EMAIL,
      legacyToken: "test-token",
      signupMode: "open",
      nowMs: NOW_MS,
      authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
      newUserId: () => USER,
      newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
    });
    await raw.run(
      `INSERT INTO sessions (id, user_id, secret_hmac, hash_key_version, created_at, authenticated_at,
         last_seen_at, idle_expires_at, absolute_expires_at, created_from_claim_id)
       VALUES ('ses_550e8400-e29b-41d4-a716-446655440000', ?, 'hmac', 1, ?, ?, ?, ?, ?, 'clm_teardown')`,
      USER,
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS + SESSION_IDLE_TTL_MS),
      toTimestamp(NOW_MS + SESSION_ABSOLUTE_TTL_MS),
    );
    await beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS });
    await raw.run(
      `INSERT INTO tenant_provider_credentials (tenant_id, provider, ciphertext, iv, key_version,
         credential_version, last_four, status, created_at, updated_at)
       VALUES (?, 'openai', ?, ?, 1, 1, '9876', 'active', ?, ?)`,
      USER,
      Buffer.from("sealed"),
      Buffer.from("0123456789ab"),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
    );
    await raw.run(
      `INSERT INTO wipe_progress (tenant_id, phase, lease_seq, updated_at, force, completed_at, residue,
         first_completed_at, first_residue)
       VALUES (?, 'done', 3, ?, false, ?, false, ?, false)`,
      USER,
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
    );
    return { raw, db };
  }

  /** A usage-guard namespace whose purge call runs `during` first, standing in for a race. */
  function guard(options: { fails?: boolean; during?: () => Promise<void> } = {}): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch() {
          await options.during?.();
          if (options.fails) return new Response("nope", { status: 500 });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
  }

  const count = async (raw: ControlPlaneDb, table: string, column: string) =>
    (await raw.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, USER))!.n;

  // Each scenario reaches tearDownAccount with a completed wipe and must come
  // out with the account whole and the audit row already written, so the next
  // cron tick can retry cleanly.
  it.each<{
    name: string;
    arrange?: (raw: ControlPlaneDb) => Promise<void>;
    env?: (raw: ControlPlaneDb) => AccountTeardownEnv;
    db?: (db: ControlPlaneDb) => ControlPlaneDb;
    verdict?: PrefixVerdict;
    expected: { resolves: unknown } | { rejects: RegExp };
  }>([
    {
      name: "the R2 prefix verdict is unknown",
      verdict: "unknown",
      expected: { resolves: { kind: "prefix_not_empty", verdict: "unknown" } },
    },
    {
      // `readings` has no foreign key to `users`; this check is all that keeps
      // a missed row from outliving its tenant.
      name: "the tenant still owns a reading row",
      arrange: (raw) =>
        raw.run(
          `INSERT INTO readings (tenant_id, id, key_prefix, url, url_hash, status, created_at, updated_at,
             content_type, content_status, content_bytes, content_sha256)
           VALUES (?, 'rd_0123456780', 'readings/2026/09/04T100000Z-rd_0123456780', 'https://example.com/a',
             ?, 'ready', ?, ?, 'text/html', 'captured', 1, ?)`,
          USER,
          "a".repeat(64),
          toTimestamp(NOW_MS),
          toTimestamp(NOW_MS),
          "b".repeat(64),
        ).then(() => undefined),
      expected: { resolves: { kind: "rows_remain", remaining: 1 } },
    },
    {
      name: "the account is reactivated during the guard purge",
      env: (raw) => ({
        TENANT_USAGE_GUARD: guard({ during: () => raw.run("UPDATE users SET status = 'active' WHERE id = ?", USER).then(() => undefined) }),
        GLOBAL_USAGE_GUARD: guard(),
      }),
      expected: { resolves: { kind: "reactivated" } },
    },
    {
      name: "a concurrent tick reopens the wipe during the guard purge",
      env: (raw) => ({
        TENANT_USAGE_GUARD: guard({
          during: () =>
            raw.run("UPDATE wipe_progress SET completed_at = NULL, phase = 'rows' WHERE tenant_id = ?", USER).then(() => undefined),
        }),
        GLOBAL_USAGE_GUARD: guard(),
      }),
      expected: { resolves: { kind: "wipe_reopened" } },
    },
    {
      name: "a usage guard purge fails",
      env: () => ({ TENANT_USAGE_GUARD: guard(), GLOBAL_USAGE_GUARD: guard({ fails: true }) }),
      expected: { rejects: /purge_tenant failed/ },
    },
    {
      name: "the final transaction crashes",
      db: (inner) => ({
        first: (sql, ...params) => inner.first(sql, ...params),
        all: (sql, ...params) => inner.all(sql, ...params),
        run: (sql, ...params) => inner.run(sql, ...params),
        batch: (statements) => inner.batch(statements),
        transaction: async () => {
          throw new Error("database died mid-teardown");
        },
      }),
      expected: { rejects: /database died mid-teardown/ },
    },
  ])("leaves the account whole when $name", async ({ arrange, env, db: wrap, verdict, expected }) => {
    const { raw, db } = await seeded();
    await arrange?.(raw);
    const run = tearDownAccount(wrap ? wrap(db) : db, env ? env(raw) : { TENANT_USAGE_GUARD: guard(), GLOBAL_USAGE_GUARD: guard() }, {
      tenantId: USER,
      nowMs: NOW_MS,
      prefixVerdict: async () => verdict ?? "empty",
    });
    if ("resolves" in expected) await expect(run).resolves.toEqual(expected.resolves);
    else await expect(run).rejects.toThrow(expected.rejects);

    expect(await count(raw, "users", "id")).toBe(1);
    for (const [table, column] of CHILD_TABLES) expect(await count(raw, table, column), table).toBeGreaterThan(0);
    expect(await count(raw, "account_deletions", "tenant_id")).toBe(1);
  });

  // A late R2 write during either guard purge or the address lookup must not
  // be torn down against an earlier `empty` verdict.
  it("checks the prefix after the guard purges and address lookup, immediately before the final transaction", async () => {
    const { raw, db } = await seeded();
    const order: string[] = [];
    const recording = (label: string) => guard({ during: async () => void order.push(label) });
    const wrapped: ControlPlaneDb = {
      first: (sql, ...params) => db.first(sql, ...params),
      all: (sql, ...params) => {
        order.push("addresses");
        return db.all(sql, ...params);
      },
      run: (sql, ...params) => db.run(sql, ...params),
      batch: (statements) => db.batch(statements),
      transaction: (work) => {
        order.push("rows");
        return db.transaction(work);
      },
    };
    await expect(
      tearDownAccount(
        wrapped,
        { TENANT_USAGE_GUARD: recording("purge_tenant"), GLOBAL_USAGE_GUARD: recording("purge_global") },
        {
          tenantId: USER,
          nowMs: NOW_MS,
          prefixVerdict: async () => {
            order.push("prefix");
            return "not_empty";
          },
        },
      ),
    ).resolves.toEqual({ kind: "prefix_not_empty", verdict: "not_empty" });
    expect(order).toEqual(["purge_tenant", "purge_global", "addresses", "prefix"]);
    expect(await count(raw, "users", "id")).toBe(1);
  });
});

describe("paid dispatch", () => {
  const url = "https://api.openai.com/v1/embeddings";
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
  };

  function fixture(overrides: Partial<Parameters<typeof createPaidFetch>[0]> = {}) {
    const kinds: unknown[] = [];
    const rpc: SpendRpc = async (body) => {
      kinds.push(body.kind);
      return { ok: true, state: body.kind === "reserve_spend" ? "reserved" : "dispatched", fresh: true };
    };
    let id = 0;
    const fetch = vi.fn(async () => Response.json({ data: [], usage: { prompt_tokens: 2, total_tokens: 2 } }));
    const wrapped = createPaidFetch({
      tenantId: "tenant",
      attemptId: "attempt",
      stage: "embed_source",
      fetch,
      now: () => 1000,
      newDispatchId: () => `dispatch-${++id}`,
      rpc,
      ...overrides,
    });
    return { kinds, fetch, wrapped };
  }

  it("never calls the provider without a clean admission", async () => {
    const cases = [
      ["unknown model", {}, { ...init, body: JSON.stringify({ model: "unknown", input: "hi" }) }],
      [
        "uncertain reservation",
        {
          rpc: async () => {
            throw new Error("lost response");
          },
        },
        init,
      ],
      [
        "replayed dispatch permission",
        { rpc: (async (body) => ({ ok: true, state: "dispatched", fresh: body.kind !== "mark_spend_dispatched" })) as SpendRpc },
        init,
      ],
      ["definitive denial", { rpc: (async () => ({ ok: false, reason: "daily_spend" })) as SpendRpc }, init],
    ] as const;
    for (const [label, overrides, request] of cases) {
      const f = fixture(overrides);
      await expect(f.wrapped(url, request), label).rejects.toBeInstanceOf(SpendAdmissionError);
      expect(f.fetch, label).not.toHaveBeenCalled();
    }
  });

  // Following a redirect could carry the provider key header to another host.
  it("refuses a 3xx or opaque redirect instead of following it, and settles nothing", async () => {
    const opaque = Object.create(Response.prototype, {
      status: { value: 0 },
      ok: { value: false },
      type: { value: "opaqueredirect" },
      body: { value: null },
    }) as Response;
    const responses = [
      ["302", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
      ["opaqueredirect", () => opaque],
    ] as const;
    for (const [label, respond] of responses) {
      const provider = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
        expect(request?.redirect).toBe("manual");
        return respond();
      });
      const f = fixture({ fetch: provider as typeof fetch });
      await expect(f.wrapped(url, init), label).rejects.toThrow(/refused redirect/);
      expect(provider, label).toHaveBeenCalledOnce();
      expect(f.kinds, label).not.toContain("settle_spend");
    }
  });

  // A tenant holding both keys: a deployment key an adapter set must never
  // ride along with the tenant's, and each request pays from the provider the
  // quote names.
  it("resolves the key for the quoted provider and strips the other provider's header", async () => {
    const sent: Array<[string | null, string | null]> = [];
    const f = fixture({
      authorization: {
        mode: "tenant",
        resolve: async (provider) => provider === "anthropic"
          ? { key: "sk-ant-tenant-7777", credentialVersion: 7 }
          : { key: "sk-openai-tenant-3333", credentialVersion: 3 },
        markInvalid: async () => {},
      },
      fetch: async (_url, request) => {
        const headers = new Headers(request?.headers);
        sent.push([headers.get("authorization"), headers.get("x-api-key")]);
        return Response.json({});
      },
    });
    const stale = { authorization: "Bearer sk-deployment-openai", "x-api-key": "sk-deployment-anthropic" };
    await f.wrapped(url, { ...init, headers: { ...init.headers, ...stale } });
    await f.wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...stale },
      body: JSON.stringify(buildAnthropicBody(
        { url: "https://example.com", extractedText: "article", similarReadings: [] }, "claude-sonnet-5-5", "low")),
    });
    expect(sent).toEqual([["Bearer sk-openai-tenant-3333", null], [null, "sk-ant-tenant-7777"]]);
  });
});

describe("provider key crypto", () => {
  it("decrypts only under the tenant and credential version it was sealed for", async () => {
    const providerKeyRoot = { secret: parseProviderKeySecret(ROOT_HEX), version: 1 };
    const sealed = await encryptProviderKey({ root: providerKeyRoot, tenantId: USER, credentialVersion: 1, plaintext: "sk-test-key-1234" });
    const open = (tenantId: string, credentialVersion: number) =>
      decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId,
        credentialVersion,
        keyVersion: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
      });
    await expect(open(USER, 1)).resolves.toBe("sk-test-key-1234");
    await expect(open(OTHER, 1)).rejects.toThrow("provider key ciphertext failed to decrypt");
    await expect(open(USER, 2)).rejects.toThrow("provider key ciphertext failed to decrypt");
  });
});
