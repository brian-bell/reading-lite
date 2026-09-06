import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createPaidFetch, spendRpcFor, SpendAdmissionError } from "../../src/control-plane/paid-dispatch";
import { quotePaidRequest } from "../../src/modules/paid-pricing";
import { summarizeReading, buildSummarizeRequestBody } from "../../src/modules/openai-summarizer";
import type { Env } from "../../src/index";
import { FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";
import { GLOBAL_USAGE_GUARD_NAME } from "../../src/control-plane/constants";

const url = "https://api.openai.com/v1/embeddings";
const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({model: "text-embedding-3-small", input: "Hello"}) };
const now = Date.now();
const rpc = () => spendRpcFor(env as unknown as Env);
async function limitTenant(amount: number) {
  await env.CONTROL_PLANE.prepare("UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?").bind(amount, FOUNDER_TENANT_ID).run();
}
function paid(fetch: typeof globalThis.fetch, clock = now) {
  return createPaidFetch({ tenantId: FOUNDER_TENANT_ID, attemptId: crypto.randomUUID(), stage: "embed_source", fetch, rpc: rpc(), now: () => clock });
}
const response = () => Response.json({ data: [], usage: { prompt_tokens: 1, total_tokens: 1 } });

describe("hosted spend guards", () => {
  it("enforces a tenant maximum before the provider can be called", async () => {
    const quote = (await quotePaidRequest(url, init))!;
    await limitTenant(quote.maxMicrodollars - 1);
    const fetch = vi.fn(async () => response());
    await expect(paid(fetch)(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires an explicit global budget without consuming tenant admission", async () => {
    const quote = (await quotePaidRequest(url, init))!;
    await limitTenant(quote.maxMicrodollars);
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET daily_spend_microdollars = NULL WHERE id = 1").run();
    const fetch = vi.fn(async () => response());
    await expect(paid(fetch)(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET daily_spend_microdollars = 1000000 WHERE id = 1").run();
    expect((await paid(fetch)(url, init)).status).toBe(200);
  });
  it("retains a timeout maximum even after the queue would release concurrency", async () => {
    const quote = (await quotePaidRequest(url, init))!;
    await limitTenant(quote.maxMicrodollars);
    await expect(paid(async () => { throw new Error("timeout"); })(url, init)).rejects.toThrow("timeout");
    const fetch = vi.fn(async () => response());
    await expect(paid(fetch)(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains both charges and never calls the provider when dispatch authorization is lost", async () => {
    const quote = (await quotePaidRequest(url, init))!;
    const fetch = vi.fn(async () => response());
    const realRpc = rpc();
    const calls: string[] = [];
    const decisions: unknown[] = [];
    const wrapped = createPaidFetch({
      tenantId: FOUNDER_TENANT_ID,
      attemptId: "lost-dispatch-response",
      stage: "embed_source",
      fetch,
      now: () => now,
      newDispatchId: () => "dispatch-1",
      rpc: async (body) => {
        calls.push(body.kind as string);
        const result = await realRpc(body);
        decisions.push(result);
        if (body.kind === "mark_spend_dispatched") {
          throw new Error("dispatch recorded, response lost");
        }
        return result;
      },
    });

    await expect(wrapped(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls).toEqual(["reserve_spend", "mark_spend_dispatched", "release_spend"]);
    expect(decisions).toEqual([
      { ok: true, state: "reserved" },
      { ok: true, state: "dispatched", fresh: true },
      { ok: true, state: "dispatched" },
    ]);
    const ns = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
    const status = await ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME)).fetch("https://guard/", {
      method: "POST",
      body: JSON.stringify({ kind: "spend_status", tenantId: FOUNDER_TENANT_ID }),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      globalChargedMicrodollars: quote.maxMicrodollars,
      tenantChargedMicrodollars: quote.maxMicrodollars,
    });
  });
  it("reconciles billed usage before rejecting invalid summary output", async () => {
    const input = {url:"https://example.com", extractedText:"A complete article", similarReadings:[]};
    const body = buildSummarizeRequestBody(input, "gpt-5.6-terra", "low");
    const quote = (await quotePaidRequest("https://api.openai.com/v1/responses", {...init, body:JSON.stringify(body)}))!;
    // Leave one microdollar less than a second full reservation. Settlement of
    // the rejected response makes the second dispatch possible.
    await limitTenant(quote.maxMicrodollars * 2 - 1);
    const fetch = vi.fn(async () => Response.json({
      id:"resp_test", object:"response", status:"completed",
      output: [{type:"message", role:"assistant", content:[{type:"output_text", text:"invalid json"}]}],
      usage: {input_tokens:1, output_tokens:1},
    }));
    const deps = {fetch:paid(fetch), apiKey:"test", model:"gpt-5.6-terra", reasoningEffort:"low" as const};
    await expect(summarizeReading(input,deps)).rejects.toThrow("not a valid reading summary");
    await expect(summarizeReading(input,deps)).rejects.toThrow("not a valid reading summary");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("defers disabled paid work and resumes when re-enabled", async () => {
    const fetch = vi.fn(async () => response());
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET paid_work_enabled = 0 WHERE id = 1").run();
    await expect(paid(fetch)(url,init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET paid_work_enabled = 1 WHERE id = 1").run();
    expect((await paid(fetch)(url,init)).status).toBe(200);
  });
  it("honors disabling between reservation and dispatch and releases the unused hold", async () => {
    const quote = (await quotePaidRequest(url, init))!;
    await limitTenant(quote.maxMicrodollars);
    const fetch = vi.fn(async () => response());
    const wrapped = createPaidFetch({tenantId:FOUNDER_TENANT_ID,attemptId:crypto.randomUUID(),stage:"embed_source",
      fetch,now:() => now,rpc:async (body) => {
        if (body.kind === "mark_spend_dispatched") {
          await env.CONTROL_PLANE.prepare("UPDATE system_policy SET paid_work_enabled = 0 WHERE id = 1").run();
        }
        return rpc()(body);
      }});
    await expect(wrapped(url,init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET paid_work_enabled = 1 WHERE id = 1").run();
    expect((await paid(fetch)(url,init)).status).toBe(200);
  });
  it("blocks mismatched catalog versions before dispatch", async () => {
    await env.CONTROL_PLANE.prepare("UPDATE system_policy SET catalog_version = 999 WHERE id = 1").run();
    const fetch = vi.fn(async () => response());
    await expect(paid(fetch)(url, init)).rejects.toBeInstanceOf(SpendAdmissionError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
