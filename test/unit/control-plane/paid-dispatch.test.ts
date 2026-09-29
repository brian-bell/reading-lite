import { describe, expect, it, vi } from "vitest";
import { createPaidFetch, SpendAdmissionError, type SpendRpc } from "../../../src/control-plane/paid-dispatch";
import { TenantProviderKeyError } from "../../../src/control-plane/tenant-provider-keys";
import { buildSummarizeRequestBody } from "../../../src/modules/openai-summarizer";
import { fetchWithRetry } from "../../../src/modules/http-retry";

const url = "https://api.openai.com/v1/embeddings";
const init = { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }) };
const response = () => Response.json({ data: [], usage: { prompt_tokens: 2, total_tokens: 2 } });
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

  it("sets the tenant key after admission and before quota commit, overwriting any adapter header", async () => {
    const order: string[] = [];
    const sent: string[] = [];
    const f = fixture({
      authorization: { mode: "tenant", resolve: async () => { order.push("resolve"); return "sk-tenant-live"; } },
      onAuthorizedDispatch: async () => { order.push("commit"); },
      fetch: async (_url, request) => {
        order.push("fetch");
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        return response();
      },
    });
    await f.wrapped(url, { ...init, headers: { ...init.headers, authorization: "Bearer sk-deployment-key" } });
    expect(f.calls.map(c => c.body.kind)).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(order).toEqual(["resolve", "commit", "fetch"]);
    expect(sent).toEqual(["Bearer sk-tenant-live"]);
    expect(JSON.stringify(f.calls)).not.toContain("sk-tenant-live");
  });

  it("settles zero and does not call the provider when the tenant key is missing", async () => {
    const commit = vi.fn(async () => {});
    const f = fixture({
      authorization: { mode: "tenant", resolve: async () => { throw new TenantProviderKeyError("provider_key_required"); } },
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
      authorization: { mode: "tenant", resolve: async () => { resolves += 1; throw new TenantProviderKeyError("provider_key_required"); } },
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
      authorization: { mode: "tenant", resolve: async () => `sk-retry-${++resolves}` },
      fetch: vi.fn(async (_url, request) => {
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        if (sent.length === 1) throw new Error("timeout");
        return response();
      }) as typeof fetch,
    });
    await fetchWithRetry(f.wrapped, url, init, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
    expect(sent).toEqual(["Bearer sk-retry-1", "Bearer sk-retry-2"]);
    const deployment = fixture({
      fetch: async (_url, request) => {
        sent.push(new Headers(request?.headers).get("authorization") ?? "");
        return response();
      },
    });
    await deployment.wrapped(url, { ...init, headers: { ...init.headers, authorization: "Bearer sk-deployment-key" } });
    expect(sent.at(-1)).toBe("Bearer sk-deployment-key");
  });
});
