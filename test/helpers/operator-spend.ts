import { vi } from "vitest";
import type { SpendRpc } from "../../src/control-plane/paid-dispatch";
import type { OpenOperatorSpend } from "../../scripts/system-lib/spend";

// reading-lite-gh319.1: a stand-in spend authority for operator command tests.
// `fetch` is the PROVIDER transport the command would bill through; every
// fail-closed case asserts it was never called.

export const BILLING_TENANT = "usr_22222222-2222-4222-8222-222222222222";

export const EMBED_URL = "https://api.openai.com/v1/embeddings";
const json = { "content-type": "application/json" };
export const PRICED_REQUEST: RequestInit = {
  method: "POST",
  headers: json,
  body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
};
const UNPRICED_REQUEST: RequestInit = {
  method: "POST",
  headers: json,
  body: JSON.stringify({ model: "not-in-the-catalog", input: "hello" }),
};

type Authority = "allow" | "deny" | "outage";

export function spendHarness(authority: Authority = "allow") {
  const calls: Array<{ kind: string; opId: string; tenantId: string }> = [];
  const dispose = vi.fn(async () => {});
  const rpc: SpendRpc = async (body) => {
    calls.push({ kind: String(body.kind), opId: String(body.opId), tenantId: String(body.tenantId) });
    if (authority === "outage") return { ok: false, reason: "unavailable" };
    if (authority === "deny") return { ok: false, reason: "daily_spend" };
    if (body.kind === "reserve_spend") return { ok: true, state: "reserved" };
    if (body.kind === "mark_spend_dispatched") return { ok: true, fresh: true };
    return { ok: true };
  };
  const openSpend = vi.fn<OpenOperatorSpend>(async () => ({ rpc, dispose }));
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ model: "text-embedding-3-small", data: [], usage: { prompt_tokens: 1, total_tokens: 1 } }),
  );
  return { openSpend, fetch, calls, dispose };
}

/** [label, authority, request the command's paid client sends, refusal]. */
export const FAIL_CLOSED_CASES: Array<[string, Authority, RequestInit, RegExp]> = [
  ["a budget denial", "deny", PRICED_REQUEST, /daily_spend/],
  ["a spend authority outage", "outage", PRICED_REQUEST, /unavailable/],
  ["a payload the price catalog cannot bound", "allow", UNPRICED_REQUEST, /unbounded_request/],
];
