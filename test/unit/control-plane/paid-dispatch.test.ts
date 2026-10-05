import { describe, expect, it, vi } from "vitest";
import { createPaidFetch, SpendAdmissionError, type SpendRpc } from "../../../src/control-plane/paid-dispatch";
import { TenantProviderKeyError } from "../../../src/control-plane/tenant-provider-keys";
import { buildSummarizeRequestBody as buildAnthropicBody } from "../../../src/modules/anthropic";
import { buildSummarizeRequestBody } from "../../../src/modules/openai-summarizer";
import { fetchWithRetry } from "../../../src/modules/http-retry";

const url = "https://api.openai.com/v1/embeddings";
const init = { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }) };
const response = () => Response.json({ data: [], usage: { prompt_tokens: 2, total_tokens: 2 } });
const tenantKey = (resolve: () => Promise<string>) => ({
  mode: "tenant" as const,
  resolve: async () => ({ key: await resolve(), credentialVersion: 1 }),
  markInvalid: async () => {},
});
const anthropicUrl = "https://api.anthropic.com/v1/messages";
const anthropicInit = (headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
  body: JSON.stringify(buildAnthropicBody(
    { url: "https://example.com", extractedText: "article", similarReadings: [] }, "claude-sonnet-5-5", "low")),
});
// A tenant holding both keys, at different credential versions.
const twoKeys = (resolved: string[] = []) => ({
  mode: "tenant" as const,
  resolve: async (provider: "openai" | "anthropic") => {
    resolved.push(provider);
    return provider === "anthropic"
      ? { key: "sk-ant-tenant-7777", credentialVersion: 7 }
      : { key: "sk-openai-tenant-3333", credentialVersion: 3 };
  },
  markInvalid: vi.fn(async (_provider: "openai" | "anthropic", _version: number, _nowMs: number) => {}),
});
const anthropicError = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
function fixture(overrides: Partial<Parameters<typeof createPaidFetch>[0]> = {}) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const rpc: SpendRpc = async (body) => {
    calls.push({ body });
    return { ok: true, state: body.kind === "reserve_spend" ? "reserved" : "dispatched", fresh: true };
  };
  let id = 0;
  const fetch = vi.fn(async () => response());
  const wrapped = createPaidFetch({ tenantId: "tenant", attemptId: "attempt", stage: "embed_source", fetch,
    now: () => 1000, newDispatchId: () => `dispatch-${++id}`, rpc, ...overrides });
  return { calls, fetch, wrapped };
}

describe("paid dispatch", () => {
  it("reserves both budgets atomically, marks before fetch, and settles usage", async () => {
    const f = fixture();
    await f.wrapped(url, init);
    expect(f.calls.map(c => c.body.kind)).toEqual([
      "reserve_spend", "mark_spend_dispatched", "settle_spend",
    ]);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(new Set(f.calls.map(c => c.body.opId)).size).toBe(1);
  });
  it.each([
    ["deployment keys", undefined, "operator"],
    ["the tenant's key", tenantKey(async () => "sk-tenant"), "tenant"],
  ])("tags the reservation and every paid_spend line with who pays for %s", async (_label, authorization, payer) => {
    const lines: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((line: string) => void lines.push(line));
    try {
      const f = fixture(authorization ? { authorization } : {});
      await f.wrapped(url, init);
      expect(f.calls[0]!.body).toMatchObject({ kind: "reserve_spend", payer });
      const events = lines.map((line) => JSON.parse(line)).filter((line) => line.event === "paid_spend");
      expect(events.map((event) => event.state)).toEqual(["reserved", "settled"]);
      expect(events.every((event) => event.payer === payer)).toBe(true);
    } finally {
      info.mockRestore();
    }
  });
  it("pins OpenAI standard pricing in the request actually sent", async () => {
    const requests: RequestInit[] = [];
    const f = fixture({fetch: async (_url,init) => {requests.push(init!); return Response.json({});}});
    const body = buildSummarizeRequestBody({url:"https://example.com",extractedText:"article",similarReadings:[]},"gpt-5.6-terra","low");
    await f.wrapped("https://api.openai.com/v1/responses",{...init,body:JSON.stringify(body)});
    expect(JSON.parse(requests[0]!.body as string).service_tier).toBe("default");
    expect(requests[0]!.redirect).toBe("manual");
    expect(body).not.toHaveProperty("service_tier");
  });
  it("asks workerd for manual redirects and refuses 3xx instead of following", async () => {
    const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    });
    const f = fixture({ fetch: provider as typeof fetch });
    await expect(f.wrapped(url, init)).rejects.toThrow(/refused redirect/);
    expect(provider).toHaveBeenCalledOnce();
    expect(f.calls.some(c => c.body.kind === "settle_spend")).toBe(false);
  });
  it("refuses opaque redirects the same way as a 3xx", async () => {
    const opaque = Object.create(Response.prototype, {
      status: { value: 0 },
      ok: { value: false },
      type: { value: "opaqueredirect" },
      body: { value: null },
    }) as Response;
    const f = fixture({ fetch: async () => opaque });
    await expect(f.wrapped(url, init)).rejects.toThrow(/refused redirect/);
    expect(f.calls.some(c => c.body.kind === "settle_spend")).toBe(false);
  });
  it("rejects unknown models before guards or provider", async () => {
    const f = fixture();
    await expect(f.wrapped(url, { ...init, body: JSON.stringify({model: "unknown", input: "hi"}) })).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(f.calls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not dispatch or compensate after an uncertain reservation", async () => {
    const rpc = vi.fn(async () => { throw new Error("lost response"); });
    const f = fixture({ rpc });
    await expect(f.wrapped(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("does not create release tombstones after definitive admission denials", async () => {
    const rpc = vi.fn(async () => ({ok:false, reason:"daily_spend"}));
    const f = fixture({rpc});
    await expect(f.wrapped(url,init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("never sends again on replayed dispatch permission", async () => {
    const f = fixture({ rpc: async (body) => ({ ok: true, state: "dispatched", fresh: body.kind !== "mark_spend_dispatched" }) });
    await expect(f.wrapped(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("gives every network retry a different operation and retains unknown first cost", async () => {
    let count = 0;
    const f = fixture({ fetch: vi.fn(async () => { if (++count === 1) throw new Error("timeout"); return response(); }) as typeof fetch });
    await fetchWithRetry(f.wrapped, url, init, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
    const reservations = f.calls.filter(c => c.body.kind === "reserve_spend");
    expect(reservations).toHaveLength(2);
    expect(reservations[0]!.body.opId).not.toBe(reservations[1]!.body.opId);
    const settled = f.calls.filter(c => c.body.kind === "settle_spend");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.body.opId).toBe(reservations[1]!.body.opId);
    expect(f.calls.some(c => c.body.kind === "release_spend")).toBe(false);
  });
  it("does not retry admission errors as provider transport failures", async () => {
    const f = fixture({ rpc: async () => ({ ok: false, reason: "daily_spend" }) });
    const sleep = vi.fn(async () => {});
    await expect(fetchWithRetry(f.wrapped, url, init, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep })).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("returns the provider response if settlement is unavailable", async () => {
    const f = fixture({ rpc: async (body) => {
      if (body.kind === "settle_spend") throw new Error("unavailable");
      return {ok:true, state:"reserved", fresh:true};
    }});
    expect((await f.wrapped(url, init)).status).toBe(200);
  });
  it("commits reading quota only after cost authorization", async () => {
    const commit = vi.fn(async () => {});
    const blocked = fixture({onAuthorizedDispatch:commit, rpc: async (body) => body.kind === "reserve_spend"
      ? {ok:true,state:"reserved"} : {ok:false, reason:"paid_work_disabled"}});
    await expect(blocked.wrapped(url,init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(commit).not.toHaveBeenCalled();
    const allowed = fixture({onAuthorizedDispatch:commit});
    await allowed.wrapped(url,init);
    expect(commit).toHaveBeenCalledOnce();
  });
  it("settles zero for known unused dispatch permission when reading quota commit fails", async () => {
    const f = fixture({onAuthorizedDispatch:async () => {throw new Error("quota unavailable");}});
    await expect(f.wrapped(url,init)).rejects.toThrow("quota unavailable");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.calls.map(c => c.body.kind)).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(f.calls.at(-1)!.body.actualMicrodollars).toBe(0);
  });
  it("retains maximum for error responses even if they include a usage-shaped object", async () => {
    const f = fixture({fetch: async () => Response.json({error:"partial",usage:{prompt_tokens:0,total_tokens:0}},{status:500})});
    await f.wrapped(url,init);
    expect(f.calls.some(c => c.body.kind === "settle_spend")).toBe(false);
  });
  it("does not refund malformed or missing usage", async () => {
    const f = fixture({ fetch: async () => Response.json({error: "unknown"}, {status:500}) });
    await f.wrapped(url, init);
    expect(f.calls.some(c => c.body.kind === "settle_spend" || c.body.kind === "release_spend")).toBe(false);
  });

  it("sets the tenant key after admission and again after quota commit, overwriting any adapter header", async () => {
    const order: string[] = [];
    const sent: string[] = [];
    const f = fixture({
      authorization: tenantKey(async () => { order.push("resolve"); return "sk-tenant-live"; }),
      onAuthorizedDispatch: async () => { order.push("commit"); },
      fetch: async (_url, request) => {
        order.push("fetch");
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        return response();
      },
    });
    await f.wrapped(url, { ...init, headers: { ...init.headers, authorization: "Bearer sk-deployment-key" } });
    expect(f.calls.map(c => c.body.kind)).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(order).toEqual(["resolve", "commit", "resolve", "fetch"]);
    expect(sent).toEqual(["Bearer sk-tenant-live"]);
    expect(JSON.stringify(f.calls)).not.toContain("sk-tenant-live");
  });

  it("sends the key resolved after quota commit when the credential changes during that wait", async () => {
    const keys = ["sk-before-commit", "sk-after-commit"];
    let n = 0;
    const sent: string[] = [];
    const f = fixture({
      authorization: tenantKey(async () => {
        const key = keys[n];
        if (key === undefined) throw new TenantProviderKeyError("provider_key_required");
        n += 1;
        return key;
      }),
      onAuthorizedDispatch: async () => { keys[1] = "sk-replaced-during-commit"; },
      fetch: async (_url, request) => {
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        return response();
      },
    });
    await f.wrapped(url, { ...init, headers: { ...init.headers, authorization: "Bearer sk-deployment-key" } });
    expect(sent).toEqual(["Bearer sk-replaced-during-commit"]);
    expect(JSON.stringify(f.calls)).not.toContain("sk-before-commit");
    expect(JSON.stringify(f.calls)).not.toContain("sk-replaced-during-commit");
  });

  it("does not send a key removed while quota commit is in flight", async () => {
    let n = 0;
    const f = fixture({
      authorization: tenantKey(async () => {
        n += 1;
        if (n > 1) throw new TenantProviderKeyError("provider_key_required");
        return "sk-removed-during-commit";
      }),
      onAuthorizedDispatch: async () => {},
    });
    await expect(f.wrapped(url, init)).rejects.toMatchObject({
      name: "provider_key_required",
      message: "connect a key, then retry",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.calls.map(c => c.body.kind)).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(f.calls.at(-1)!.body.actualMicrodollars).toBe(0);
    expect(JSON.stringify(f.calls)).not.toContain("sk-removed-during-commit");
  });

  it("settles zero and does not call the provider when the tenant key is missing", async () => {
    const commit = vi.fn(async () => {});
    const f = fixture({
      authorization: tenantKey(async () => { throw new TenantProviderKeyError("provider_key_required"); }),
      onAuthorizedDispatch: commit,
    });
    await expect(f.wrapped(url, init)).rejects.toMatchObject({ name: "provider_key_required", message: "connect a key, then retry" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(f.calls.map(c => c.body.kind)).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(f.calls.at(-1)!.body.actualMicrodollars).toBe(0);
  });

  it("does not retry a missing tenant key as a transport failure", async () => {
    let resolves = 0;
    const f = fixture({
      authorization: tenantKey(async () => { resolves += 1; throw new TenantProviderKeyError("provider_key_required"); }),
    });
    const sleep = vi.fn(async () => {});
    await expect(fetchWithRetry(f.wrapped, url, init, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep })).rejects.toMatchObject({
      name: "provider_key_required",
    });
    expect(resolves).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("resolves again on an HTTP retry and keeps the deployment header when tenant keys are off", async () => {
    let resolves = 0;
    const sent: string[] = [];
    const f = fixture({
      authorization: tenantKey(async () => `sk-retry-${++resolves}`),
      fetch: vi.fn(async (_url, request) => {
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        if (sent.length === 1) throw new Error("timeout");
        return response();
      }) as typeof fetch,
    });
    await fetchWithRetry(f.wrapped, url, init, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
    expect(sent).toEqual(["Bearer sk-retry-2", "Bearer sk-retry-4"]);
    const deployment = fixture({
      fetch: async (_url, request) => {
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        return response();
      },
    });
    await deployment.wrapped(url, { ...init, headers: { ...init.headers, authorization: "Bearer sk-deployment-key" } });
    expect(sent.at(-1)).toBe("Bearer sk-deployment-key");
  });

  // The operator's account, not the reader's: its own code, so the reader is
  // not told to fix billing they do not hold.
  it("fails an insufficient_quota 429 now on deployment keys too, as the hosted quota, and leaves a deployment-key 401 to the adapter", async () => {
    const provider = vi.fn(async () => Response.json({ error: { type: "insufficient_quota", code: "insufficient_quota" } }, { status: 429 }));
    const quota = fixture({ fetch: provider as typeof fetch });
    const sleep = vi.fn(async () => {});
    await expect(fetchWithRetry(quota.wrapped, url, init, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep })).rejects.toMatchObject({
      name: "hosted_provider_quota", status: 429,
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    const rejected = fixture({ fetch: async () => new Response("bad key", { status: 401 }) });
    expect((await rejected.wrapped(url, init)).status).toBe(401);
  });

  it("resolves the key for the quoted provider and sends only that provider's header", async () => {
    const resolved: string[] = [];
    const sent: Array<[string | null, string | null]> = [];
    const f = fixture({
      authorization: twoKeys(resolved),
      fetch: async (_url, request) => {
        const headers = new Headers(request?.headers);
        sent.push([headers.get("authorization"), headers.get("x-api-key")]);
        return Response.json({});
      },
    });
    const stale = { authorization: "Bearer sk-deployment-openai", "x-api-key": "sk-deployment-anthropic" };
    await f.wrapped(url, { ...init, headers: { ...init.headers, ...stale } });
    await f.wrapped(anthropicUrl, anthropicInit(stale));
    expect(resolved).toEqual(["openai", "openai", "anthropic", "anthropic"]);
    expect(sent).toEqual([["Bearer sk-openai-tenant-3333", null], [null, "sk-ant-tenant-7777"]]);
  });

  // ADR 0004's Anthropic table. The credit-balance and spend-limit messages
  // are provisional until a real key confirms them (reading-lite-gh341.15.8).
  it.each([
    { status: 401, type: "authentication_error", message: "invalid x-api-key",
      tenant: "provider_key_invalid", deployment: null },
    { status: 403, type: "permission_error", message: "Your API key does not have permission to use the specified resource.",
      tenant: "provider_model_access", deployment: null },
    { status: 404, type: "not_found_error", message: "model: claude-sonnet-5-5",
      tenant: "provider_model_access", deployment: null },
    { status: 402, type: "billing_error", message: "Your account has a billing issue.",
      tenant: "provider_insufficient_quota", deployment: "hosted_provider_quota" },
    { status: 400, type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      tenant: "provider_insufficient_quota", deployment: "hosted_provider_quota" },
    { status: 429, type: "rate_limit_error",
      message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      tenant: "provider_insufficient_quota", deployment: "hosted_provider_quota" },
    { status: 429, type: "rate_limit_error",
      message: "This request would exceed the rate limit for your organization of 50 requests per minute.",
      tenant: null, deployment: null },
    { status: 400, type: "invalid_request_error", message: "max_tokens: Field required",
      tenant: null, deployment: null },
    { status: 529, type: "overloaded_error", message: "Overloaded", tenant: null, deployment: null },
  ])("classifies an Anthropic $status $type as $tenant on the tenant's key and $deployment on deployment keys", async (row) => {
    const reply = async () => new Response(anthropicError(row.type, row.message), { status: row.status });
    const authorization = twoKeys();
    const tenant = fixture({ authorization, fetch: reply });
    const deployment = fixture({ fetch: reply });
    for (const [f, code] of [[tenant, row.tenant], [deployment, row.deployment]] as const) {
      if (code === null) expect((await f.wrapped(anthropicUrl, anthropicInit())).status).toBe(row.status);
      else await expect(f.wrapped(anthropicUrl, anthropicInit())).rejects.toMatchObject({
        name: code, status: row.status, provider: "anthropic",
      });
    }
    if (row.tenant === "provider_key_invalid") expect(authorization.markInvalid.mock.calls).toEqual([["anthropic", 7, 1000]]);
    else expect(authorization.markInvalid).not.toHaveBeenCalled();
  });
});
