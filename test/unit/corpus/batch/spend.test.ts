// scripts/corpus-lib/batch/spend.ts — batch admission and settlement against
// the central spend authority (reading-lite-gh319.2). The pipeline tests own
// where these calls sit in the batch lifecycle; this file owns the bound, the
// verb order within admission, and what settles versus what stays held.
import { describe, expect, it, vi } from "vitest";
import { buildSummarizeRequestBody as anthropicBody } from "../../../../src/modules/anthropic";
import { buildSummarizeRequestBody as openAIBody } from "../../../../src/modules/openai-summarizer";
import { quotePaidRequest } from "../../../../src/modules/paid-pricing";
import type { SpendRpc } from "../../../../src/control-plane/paid-dispatch";
import { BILLING_TENANT as TENANT, batchSpendAuthority as authority } from "../../../helpers/operator-spend";
import {
  admitBatchSpend,
  boundAnthropicBatch,
  boundOpenAIBatch,
  cancelUnsentBatchSpend,
  settleBatchSpend,
  type BatchSpendIdentity,
} from "../../../../scripts/corpus-lib/batch/spend";

const NOW_MS = Date.parse("2026-09-19T12:00:00.000Z");
const ANTHROPIC_MODEL = "claude-opus-4-8";
const OPENAI_MODEL = "gpt-5.6-terra";
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };

const input = (id: string) => ({ url: `https://example.com/${id}`, extractedText: `# ${id}\n\nbody`, similarReadings: [] });
const anthropicRequests = (model = ANTHROPIC_MODEL) =>
  ["a", "b"].map((id) => ({ custom_id: id, params: anthropicBody(input(id), model, "low") }));
const openAILine = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ custom_id: id, method: "POST", url: "/v1/responses", body: openAIBody(input(id), OPENAI_MODEL, "low"), ...over });
const openAIJsonl = (...lines: string[]) => `${lines.join("\n")}\n`;

async function syncMax(url: string, bodies: object[]): Promise<number> {
  let sum = 0;
  for (const body of bodies) sum += (await quotePaidRequest(url, { ...JSON_POST, body: JSON.stringify(body) }))!.maxMicrodollars;
  return sum;
}

describe("batch spend bound", () => {
  it("sums the synchronous quote of every Anthropic request and fingerprints the exact collection", async () => {
    const requests = anthropicRequests();
    const bound = await boundAnthropicBatch(requests, ANTHROPIC_MODEL);
    expect(bound.maxMicrodollars).toBe(await syncMax("https://api.anthropic.com/v1/messages", requests.map((r) => r.params)));
    expect(bound.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const changed = [...requests.slice(0, 1), { ...requests[1]!, custom_id: "c" }];
    expect((await boundAnthropicBatch(changed, ANTHROPIC_MODEL)).requestFingerprint).not.toBe(bound.requestFingerprint);
  });

  it("sums the synchronous quote of every OpenAI JSONL body", async () => {
    const jsonl = openAIJsonl(openAILine("a"), openAILine("b"));
    const bodies = jsonl.trim().split("\n").map((line) => JSON.parse(line).body);
    const bound = await boundOpenAIBatch(jsonl, OPENAI_MODEL);
    expect(bound.maxMicrodollars).toBe(await syncMax("https://api.openai.com/v1/responses", bodies));
    expect(bound.requestFingerprint).not.toBe((await boundOpenAIBatch(openAIJsonl(openAILine("a")), OPENAI_MODEL)).requestFingerprint);
  });

  it.each([
    ["an unpriced model on one line", () => boundAnthropicBatch([...anthropicRequests(), { custom_id: "x", params: anthropicBody(input("x"), "claude-unpriced", "low") }], ANTHROPIC_MODEL)],
    ["a line for a different model than the batch", () => boundAnthropicBatch(anthropicRequests("claude-opus-5"), ANTHROPIC_MODEL)],
    ["a line for another endpoint", () => boundOpenAIBatch(openAIJsonl(openAILine("a"), openAILine("b", { url: "/v1/chat/completions" })), OPENAI_MODEL)],
    ["a line that is not JSON", () => boundOpenAIBatch(openAIJsonl(openAILine("a"), "{"), OPENAI_MODEL)],
    ["an empty batch", () => boundOpenAIBatch("", OPENAI_MODEL)],
  ])("refuses the whole batch for %s", async (_label, bound) => {
    await expect(bound()).rejects.toMatchObject({ name: "SpendAdmissionError", reason: "unbounded_request" });
  });
});

describe("batch spend admission", () => {
  const bound = { catalogVersion: 1, requestFingerprint: "f".repeat(64), maxMicrodollars: 900 };
  const admit = (rpc: SpendRpc) =>
    admitBatchSpend(bound, { tenantId: TENANT, rpc, nowMs: NOW_MS, opId: "op-1" });

  it("reserves then marks one operator-funded operation for the whole batch, and returns the identity to persist", async () => {
    const a = authority();
    const identity = await admit(a.rpc);
    expect(a.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched"]);
    expect(identity).toEqual({
      tenantId: TENANT,
      opId: "op-1",
      quote: { dayKey: "2026-09-19", catalogVersion: 1, requestFingerprint: "f".repeat(64), maxMicrodollars: 900 },
    });
    expect(a.calls[0]).toMatchObject({ ...identity, nowMs: NOW_MS, payer: "operator" });
  });

  it.each([
    ["a budget denial", { reserve_spend: { ok: false, reason: "daily_spend" } }, "daily_spend", ["reserve_spend"]],
    ["an authority outage", { reserve_spend: { ok: false, reason: "unavailable" } }, "unavailable", ["reserve_spend"]],
    ["a replayed mark", { mark_spend_dispatched: { ok: true, state: "dispatched", fresh: false } }, "dispatch_uncertain", ["reserve_spend", "mark_spend_dispatched", "release_spend"]],
  ] as const)("refuses on %s", async (_label, answers, reason, kinds) => {
    const a = authority(answers);
    await expect(admit(a.rpc)).rejects.toMatchObject({ name: "SpendAdmissionError", reason });
    expect(a.kinds()).toEqual(kinds);
  });
});

describe("batch spend settlement", () => {
  const spend: BatchSpendIdentity = {
    tenantId: TENANT,
    opId: "op-1",
    quote: { dayKey: "2026-09-19", catalogVersion: 1, requestFingerprint: "f".repeat(64), maxMicrodollars: 1_000_000 },
  };
  const targets = [{ customId: "a" }, { customId: "b" }];
  const message = (input_tokens: number) => ({ model: ANTHROPIC_MODEL, usage: { input_tokens, output_tokens: 10 } });
  const sidecar = { provider: "anthropic" as const, model: ANTHROPIC_MODEL, targets, spend };
  const settle = (lines: Array<{ customId: string; body: unknown }>, rpc: SpendRpc, over: object = {}) =>
    settleBatchSpend({ ...sidecar, ...over }, lines, { rpc });

  it("settles the summed actual cost of every line under the persisted identity", async () => {
    const a = authority();
    const outcome = await settle([{ customId: "a", body: message(100) }, { customId: "b", body: message(200) }], a.rpc);
    // (300 input × 500 + 20 output × 2500) hundredths × 1.1 geography = 2,200 µ$.
    expect(outcome).toEqual({ state: "settled", actualMicrodollars: 2_200, maxMicrodollars: 1_000_000 });
    expect(a.calls).toEqual([{ kind: "settle_spend", ...spend, actualMicrodollars: 2_200 }]);
  });

  it.each([
    ["a line with no result", [{ customId: "a", body: message(100) }]],
    ["a line whose usage is invalid", [{ customId: "a", body: message(100) }, { customId: "b", body: { usage: { input_tokens: -1 } } }]],
    ["a line that failed", [{ customId: "a", body: message(100) }, { customId: "b", body: null }]],
    ["a duplicated line", [{ customId: "a", body: message(100) }, { customId: "b", body: message(1) }, { customId: "b", body: message(1) }]],
    ["a line for no target", [{ customId: "a", body: message(100) }, { customId: "b", body: message(1) }, { customId: "z", body: message(1) }]],
  ])("keeps the maximum charged for %s instead of settling a partial sum", async (_label, lines) => {
    const a = authority();
    expect(await settle(lines, a.rpc)).toMatchObject({ state: "held", maxMicrodollars: 1_000_000 });
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("reports the maximum permanently held when the authority refuses settlement, without throwing", async () => {
    // Operation records are discarded a day after the admission day ends.
    const a = authority({ settle_spend: { ok: false, reason: "operation_state" } });
    const log = vi.fn();
    const outcome = await settleBatchSpend(sidecar, [{ customId: "a", body: message(1) }, { customId: "b", body: message(1) }], { rpc: a.rpc, log });
    expect(outcome).toEqual({ state: "held", maxMicrodollars: 1_000_000, reason: "operation_state" });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/maximum .* permanently held .*operation_state/));
  });

  it("settles nothing for a batch submitted before spend accounting", async () => {
    const a = authority();
    expect(await settle([], a.rpc, { spend: undefined })).toEqual({ state: "unmetered" });
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("settles a batch that was never created at zero", async () => {
    const a = authority();
    await expect(cancelUnsentBatchSpend(spend, { rpc: a.rpc })).resolves.toEqual({ settled: true });
    expect(a.calls).toEqual([{ kind: "settle_spend", ...spend, actualMicrodollars: 0 }]);
  });

  it("reports a refused zero settlement so the sidecar can be retained", async () => {
    const a = authority({ settle_spend: { ok: false, reason: "unavailable" } });
    await expect(cancelUnsentBatchSpend(spend, { rpc: a.rpc })).resolves.toEqual({
      settled: false,
      reason: "unavailable",
    });
  });
});
