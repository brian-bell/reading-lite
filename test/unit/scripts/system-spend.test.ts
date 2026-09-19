// scripts/system-lib/spend.ts — the operator's RPC to the OperatorSpend
// binding (reading-lite-gh319.1). Anything short of a well-formed decision is
// a refusal: the caller's paid fetch has nothing else it can safely act on.
import { describe, expect, it, vi } from "vitest";
import { spendRpcOver } from "../../../scripts/system-lib/spend";

const body = { kind: "release_spend", tenantId: "usr_x", opId: "op" };
const UNAVAILABLE = { ok: false, reason: "unavailable" };

describe("operator spend rpc", () => {
  it("posts the verb to the binding and returns its decision", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, state: "reserved" }));
    expect(await spendRpcOver({ fetch } as never)(body)).toEqual({ ok: true, state: "reserved" });
    expect(fetch).toHaveBeenCalledWith("https://operator/spend", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(body),
    }));
  });

  it.each([
    ["a rejected body", async () => new Response(null, { status: 400 })],
    ["an undeployed entrypoint", async () => new Response("not found", { status: 404 })],
    ["an answer that is not a decision", async () => Response.json({ state: "reserved" })],
    ["a non-JSON answer", async () => new Response("<html>")],
    ["a transport failure", async () => { throw new Error("proxy session closed"); }],
  ])("fails closed on %s", async (_label, fetch) => {
    expect(await spendRpcOver({ fetch } as never)(body)).toEqual(UNAVAILABLE);
  });
});
