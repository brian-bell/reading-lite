import { describe, expect, it, vi } from "vitest";
import { inspectTenantActivation, type TenantDeployTarget } from "../../../scripts/ops-lib/tenant-activation-preflight";

const target: TenantDeployTarget = {
  enabled: true, worker: "reading-lite-staging", bucket: "staging-bucket",
  jurisdiction: "", index: "staging-index", databaseId: "staging-db",
};
function fixture() {
  const bindings = [
    { name: "TENANT_DATA_PLANE", type: "plain_text", text: "1" },
    { name: "READINGS_BUCKET", type: "r2_bucket", bucket_name: target.bucket },
    { name: "READINGS_INDEX", type: "vectorize", index_name: target.index },
    { name: "CONTROL_PLANE", type: "d1", id: target.databaseId },
  ];
  const version = { metadata: { created_on: "2026-09-01T00:00:00Z" }, resources: { bindings } };
  const replies: Record<string, unknown> = {
    "workers/scripts/reading-lite-staging/deployments": { deployments: [{ versions: [{ version_id: "active", percentage: 100 }] }] },
    "workers/scripts/reading-lite-staging/versions/active": version,
    "r2/buckets/staging-bucket": { creation_date: "2026-08-01T00:00:00Z" },
    "vectorize/v2/indexes/staging-index": { created_on: "2026-08-01T00:00:00Z" },
    "d1/database/staging-db/query": [{ success: true, results: [{ id: "usr_due" }] }],
  };
  const calls: { path: string; body?: unknown }[] = [];
  const request = async (path: string, body?: unknown) => {
    calls.push({ path, body });
    if (!(path in replies)) throw new Error("unexpected request");
    return replies[path];
  };
  return { bindings, version, replies, calls, request };
}

describe("tenant activation preflight", () => {
  it("allows an already-enabled deployment without reading or comparing corpus contents", async () => {
    const f = fixture();
    expect((await inspectTenantActivation(target, f.request, 0)).ok).toBe(true);
    expect(f.calls.map(c => c.path)).toEqual([
      "workers/scripts/reading-lite-staging/deployments",
      "workers/scripts/reading-lite-staging/versions/active",
      "r2/buckets/staging-bucket", "vectorize/v2/indexes/staging-index",
    ]);
  });
  it("does no remote work when tenant mode is not requested", async () => {
    const f = fixture();
    expect((await inspectTenantActivation({ ...target, enabled: false }, f.request, 0)).ok).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
  it("blocks activation and reports tenants eligible under the seven-day grace rule", async () => {
    const f = fixture();
    f.bindings[0]!.text = "0";
    const now = Date.parse("2026-09-05T00:00:00Z");
    const result = await inspectTenantActivation(target, f.request, now);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("usr_due");
    expect(f.calls.at(-1)?.body).toEqual({
      sql: "SELECT id FROM users WHERE status = 'deleting' AND deleting_at_ms IS NOT NULL AND deleting_at_ms <= ? ORDER BY id",
      params: [now - 7 * 24 * 60 * 60 * 1000],
    });
  });
  it.each(["bucket_name", "index_name", "id"])("requires verification after changing %s", async field => {
    const f = fixture();
    const binding = f.bindings.find(b => field in b)!;
    (binding as Record<string, unknown>)[field] = "old-resource";
    expect((await inspectTenantActivation(target, f.request, 0)).ok).toBe(false);
  });
  it.each(["r2/buckets/staging-bucket", "vectorize/v2/indexes/staging-index"])("detects same-name recreation of %s", async path => {
    const f = fixture();
    f.replies[path] = { creation_date: "2026-09-02T00:00:00Z", created_on: "2026-09-02T00:00:00Z" };
    expect((await inspectTenantActivation(target, f.request, 0)).ok).toBe(false);
  });
  it.each([{}, { deployments: [] }, { deployments: [{ versions: [] }] }])("treats absent/unknown deployments as unverified", async reply => {
    const f = fixture();
    f.replies["workers/scripts/reading-lite-staging/deployments"] = reply;
    expect((await inspectTenantActivation(target, f.request, 0)).ok).toBe(false);
  });
  it("does not accept a split deployment as established activation", async () => {
    const f = fixture();
    f.replies["workers/scripts/reading-lite-staging/deployments"] = { deployments: [{ versions: [
      { version_id: "active", percentage: 90 }, { version_id: "old", percentage: 10 },
    ] }] };
    expect((await inspectTenantActivation(target, f.request, 0)).ok).toBe(false);
  });
  it("fails closed on API errors and reports that deletion eligibility is unknown", async () => {
    const result = await inspectTenantActivation(target, async () => { throw new Error("HTTP 403"); }, 0);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 403");
    expect(result.message).toContain("deletion eligibility unavailable");
  });
  it("does not accept missing resource creation metadata", async () => {
    const f = fixture();
    f.replies["r2/buckets/staging-bucket"] = {};
    expect((await inspectTenantActivation(target, f.request, 0)).ok).toBe(false);
  });
});

describe("Cloudflare activation adapter", () => {
  it("uses only metadata GETs and the read-only D1 SELECT, with scoped account and jurisdiction", async () => {
    const { cloudflareActivationRequest } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = cloudflareActivationRequest("account", { authorization: "Bearer test-only" }, "eu", (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, result: [] }));
    }) as typeof fetch);
    await request("r2/buckets/bucket");
    await request("d1/database/db/query", { sql: "SELECT id FROM users" });
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/bucket");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toMatchObject({ "cf-r2-jurisdiction": "eu", authorization: "Bearer test-only" });
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.headers).not.toHaveProperty("cf-r2-jurisdiction");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ sql: "SELECT id FROM users" });
  });
  it.each([403, 429, 500])("rejects HTTP %s without exposing response contents", async status => {
    const { cloudflareActivationRequest } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    const request = cloudflareActivationRequest("account", {}, "", (async () => new Response("private response", { status })) as typeof fetch);
    await expect(request("workers/scripts/worker/deployments")).rejects.toThrow(`Cloudflare activation inspection HTTP ${status}`);
  });
  it("rejects an unsuccessful API envelope even with HTTP 200", async () => {
    const { cloudflareActivationRequest } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    const request = cloudflareActivationRequest("account", {}, "", (async () => new Response(JSON.stringify({ success: false, result: {} }))) as typeof fetch);
    await expect(request("workers/scripts/worker/deployments")).rejects.toThrow();
  });
});

describe("activation authentication", () => {
  it("uses configured CI credentials without invoking Wrangler", async () => {
    const { resolveActivationAuth } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    const auth = await resolveActivationAuth("ci-account", async () => { throw new Error("unexpected CLI"); }, { CLOUDFLARE_API_TOKEN: "ci-token" });
    expect(auth).toEqual({ accountId: "ci-account", auth: { authorization: "Bearer ci-token" } });
  });
  it("supports a single-account Wrangler OAuth login", async () => {
    const { resolveActivationAuth } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    const auth = await resolveActivationAuth("", async args => args[0] === "whoami" ?
      { loggedIn: true, accounts: [{ id: "local-account" }] } : { type: "oauth", token: "test-oauth" }, {});
    expect(auth).toEqual({ accountId: "local-account", auth: { authorization: "Bearer test-oauth" } });
  });
  it("refuses ambiguous account selection", async () => {
    const { resolveActivationAuth } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    await expect(resolveActivationAuth("", async () => ({ loggedIn: true, accounts: [{ id: "a" }, { id: "b" }] }), {})).rejects.toThrow();
  });
});


it("captures actual Wrangler auth JSON without logging the token", async () => {
  const { resolveActivationAuth } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "preflight-test-token-not-a-real-credential");
  try {
    // Empty injected vars forces the installed CLI path; its environment holds
    // a fake credential so this check needs neither login nor network access.
    const result = await resolveActivationAuth("test-account", undefined, {});
    expect(result.auth.authorization).toBe("Bearer preflight-test-token-not-a-real-credential");
  } finally {
    vi.unstubAllEnvs();
  }
}, 10_000);
