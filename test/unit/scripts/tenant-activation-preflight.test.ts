import { describe, expect, it, vi } from "vitest";
import { inspectTenantActivation, type TenantDeployTarget } from "../../../scripts/ops-lib/tenant-activation-preflight";

const target: TenantDeployTarget = {
  enabled: true, worker: "reading-lite-staging", bucket: "staging-bucket", jurisdiction: "",
};
function fixture() {
  const bindings = [
    { name: "TENANT_DATA_PLANE", type: "plain_text", text: "1" },
    { name: "READINGS_BUCKET", type: "r2_bucket", bucket_name: target.bucket },
  ];
  const version = { metadata: { created_on: "2026-09-01T00:00:00Z" }, resources: { bindings } };
  const replies: Record<string, unknown> = {
    "workers/scripts/reading-lite-staging/deployments": { deployments: [{ versions: [{ version_id: "active", percentage: 100 }] }] },
    "workers/scripts/reading-lite-staging/versions/active": version,
    "r2/buckets/staging-bucket": { creation_date: "2026-08-01T00:00:00Z" },
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
    expect((await inspectTenantActivation(target, f.request)).ok).toBe(true);
    expect(f.calls.map(c => c.path)).toEqual([
      "workers/scripts/reading-lite-staging/deployments",
      "workers/scripts/reading-lite-staging/versions/active",
      "r2/buckets/staging-bucket",
    ]);
  });
  it("does no remote work when tenant mode is not requested", async () => {
    const f = fixture();
    expect((await inspectTenantActivation({ ...target, enabled: false }, f.request)).ok).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
  it("blocks activation and sends the operator to PostgreSQL for deletion eligibility", async () => {
    const f = fixture();
    f.bindings[0]!.text = "0";
    const result = await inspectTenantActivation(target, f.request);
    expect(result.ok).toBe(false);
    // The control plane moved to PostgreSQL, which this preflight cannot read.
    expect(result.message).toContain("PostgreSQL control plane");
    expect(f.calls.every(call => call.body === undefined)).toBe(true);
  });
  it("requires verification after changing the bucket", async () => {
    const f = fixture();
    (f.bindings[1] as Record<string, unknown>).bucket_name = "old-resource";
    expect((await inspectTenantActivation(target, f.request)).ok).toBe(false);
  });
  it("detects same-name recreation of the bucket", async () => {
    const f = fixture();
    f.replies["r2/buckets/staging-bucket"] = { creation_date: "2026-09-02T00:00:00Z" };
    expect((await inspectTenantActivation(target, f.request)).ok).toBe(false);
  });
  it.each([{}, { deployments: [] }, { deployments: [{ versions: [] }] }])("treats absent/unknown deployments as unverified", async reply => {
    const f = fixture();
    f.replies["workers/scripts/reading-lite-staging/deployments"] = reply;
    expect((await inspectTenantActivation(target, f.request)).ok).toBe(false);
  });
  it("does not accept a split deployment as established activation", async () => {
    const f = fixture();
    f.replies["workers/scripts/reading-lite-staging/deployments"] = { deployments: [{ versions: [
      { version_id: "active", percentage: 90 }, { version_id: "old", percentage: 10 },
    ] }] };
    expect((await inspectTenantActivation(target, f.request)).ok).toBe(false);
  });
  it("fails closed on API errors", async () => {
    const result = await inspectTenantActivation(target, async () => { throw new Error("HTTP 403"); });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 403");
  });
  it("does not accept missing resource creation metadata", async () => {
    const f = fixture();
    f.replies["r2/buckets/staging-bucket"] = {};
    expect((await inspectTenantActivation(target, f.request)).ok).toBe(false);
  });
});

describe("Cloudflare activation adapter", () => {
  it("uses metadata GETs with a scoped account and jurisdiction", async () => {
    const { cloudflareActivationRequest } = await import("../../../scripts/ops-lib/tenant-activation-preflight");
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = cloudflareActivationRequest("account", { authorization: "Bearer test-only" }, "eu", (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, result: [] }));
    }) as typeof fetch);
    await request("r2/buckets/bucket");
    await request("workers/scripts/worker/deployments");
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/bucket");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toMatchObject({ "cf-r2-jurisdiction": "eu", authorization: "Bearer test-only" });
    expect(calls[1]?.init?.method).toBe("GET");
    expect(calls[1]?.init?.headers).not.toHaveProperty("cf-r2-jurisdiction");
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
