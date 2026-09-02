import { describe, expect, it } from "vitest";
import {
  addUsage,
  emptyUsageTotals,
  formatUsage,
  formatUsageTotals,
} from "../../../scripts/ops-lib/judgement-usage";

const openai = {
  provider: "openai" as const,
  model: "gpt-5.6-terra",
  input_tokens: 100,
  output_tokens: 20,
  reasoning_tokens: 12,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
};

const anthropic = {
  provider: "anthropic" as const,
  model: "claude-opus-4-5",
  input_tokens: 300,
  output_tokens: 40,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

describe("judgement usage reporting", () => {
  it("shows reasoning tokens for OpenAI, which bills them as output", () => {
    expect(formatUsage(openai)).toBe("usage input=100 output=20 reasoning=12");
  });

  it("omits reasoning for Anthropic, which reports no separate figure", () => {
    expect(formatUsage(anthropic)).toBe("usage input=300 output=40");
  });

  it("sums a run and keeps the singular for one judgement", () => {
    const totals = emptyUsageTotals();
    addUsage(totals, openai);
    expect(formatUsageTotals(totals)).toBe(
      "Usage: 1 judgement; input=100 output=20 reasoning=12",
    );
    addUsage(totals, openai);
    expect(formatUsageTotals(totals)).toBe(
      "Usage: 2 judgements; input=200 output=40 reasoning=24",
    );
  });

  it("omits the reasoning total when no call reported reasoning tokens", () => {
    const totals = emptyUsageTotals();
    addUsage(totals, anthropic);
    expect(formatUsageTotals(totals)).toBe(
      "Usage: 1 judgement; input=300 output=40",
    );
  });

  it("reports a zero total for a run that made no provider call", () => {
    expect(formatUsageTotals(emptyUsageTotals())).toBe(
      "Usage: 0 judgements; input=0 output=0",
    );
  });
});
