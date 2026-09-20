import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OperatorSpend } from "../../src/control-plane/operator-spend";
import { createPaidFetch } from "../../src/control-plane/paid-dispatch";
import { quotePaidRequest } from "../../src/modules/paid-pricing";
import type { Env } from "../../src/index";
import { FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";
import { testControlPlane } from "../helpers/control-plane-db";

// reading-lite-gh319.1: operator commands reach the central spend authority
// through a service-binding-only entrypoint that forwards exactly the four
// spend verbs. Driven directly against the real test bindings, the same way
// operator-lease-clear.test.ts exercises OperatorLeaseClear.
function endpoint(bindings = env as unknown as Env) {
  return new OperatorSpend(createExecutionContext(), bindings);
}

function spendRequest(body: unknown): Request {
  return new Request("https://operator/spend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const quote = {
  dayKey: new Date().toISOString().slice(0, 10),
  catalogVersion: 1,
  requestFingerprint: "f".repeat(64),
  maxMicrodollars: 10,
};
const identity = { tenantId: FOUNDER_TENANT_ID, opId: "operator:test:operator:1", quote };

describe("operator spend entrypoint", () => {
  it.each([
    ["a lease verb", { kind: "acquire_lease", tenantId: FOUNDER_TENANT_ID, attemptId: "at_x", nowMs: 1 }],
    ["a purge verb", { kind: "purge_tenant", tenantId: FOUNDER_TENANT_ID }],
    ["a status verb", { kind: "spend_status" }],
    ["a missing quote", { kind: "release_spend", tenantId: FOUNDER_TENANT_ID, opId: "op" }],
    ["a non-tenant id", { ...identity, kind: "release_spend", tenantId: "global" }],
    ["an extra field", { ...identity, kind: "release_spend", attemptId: "at_x" }],
    ["a negative settlement", { ...identity, kind: "settle_spend", actualMicrodollars: -1 }],
    ["a reserve without a clock", { ...identity, kind: "reserve_spend" }],
    ["a non-object", "reserve_spend"],
  ])("rejects %s without reaching the guard", async (_label, body) => {
    expect((await endpoint({} as Env).fetch(spendRequest(body))).status).toBe(400);
  });

  it("rejects non-POST, unknown paths, and query strings", async () => {
    expect((await endpoint({} as Env).fetch(new Request("https://operator/spend"))).status).toBe(405);
    expect((await endpoint({} as Env).fetch(new Request("https://operator/nope", { method: "POST" }))).status).toBe(404);
    expect((await endpoint({} as Env).fetch(new Request("https://operator/spend?x=1", { method: "POST" }))).status).toBe(400);
  });

  it("answers a fail-closed decision when the authority is unbound", async () => {
    const response = await endpoint({} as Env).fetch(spendRequest({ ...identity, kind: "release_spend" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("carries a whole paid dispatch through to the central authority", async () => {
    const url = "https://api.openai.com/v1/embeddings";
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "Hello" }),
    };
    const max = (await quotePaidRequest(url, init))!.maxMicrodollars;
    await testControlPlane(env).run(
      "UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?", max, FOUNDER_TENANT_ID);
    const kinds: string[] = [];
    const paid = (fetch: typeof globalThis.fetch) => createPaidFetch({
      tenantId: FOUNDER_TENANT_ID,
      attemptId: "operator:test",
      stage: "operator",
      fetch,
      now: () => Date.now(),
      rpc: async (body) => {
        kinds.push(body.kind as string);
        return (await endpoint().fetch(spendRequest(body))).json();
      },
    });
    // An unusable usage envelope holds the maximum, which is the whole tenant
    // budget here: the second dispatch is denied by the same authority.
    expect((await paid(async () => Response.json({ data: [] }))(url, init)).status).toBe(200);
    expect(kinds).toEqual(["reserve_spend", "mark_spend_dispatched"]);
    await expect(paid(async () => Response.json({}))(url, init)).rejects.toThrow("daily_spend");
  });
});
