import type { SummarizationUsage } from "../../src/modules/summarizer";

export const SUMMARIZER_PRICE_DATE = "2026-07-23";

const OPENAI_PRICES: Record<
  string,
  { input: number; cached: number; cacheWrite: number; output: number }
> = {
  "gpt-5.6-sol": { input: 5, cached: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, cacheWrite: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cached: 0.1, cacheWrite: 1.25, output: 6 },
};

const ANTHROPIC_SONNET_PRICES: Record<
  string,
  { input: number; cacheWrite: number; cached: number; output: number }
> = {
  "claude-sonnet-5": { input: 3, cacheWrite: 3.75, cached: 0.3, output: 15 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cached: 0.3, output: 15 },
};

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function estimateSummarizationCostUsd(usage: SummarizationUsage): {
  synchronous: number;
  batch: number;
} {
  let synchronous: number;
  if (usage.provider === "openai") {
    const price = OPENAI_PRICES[usage.model];
    if (!price) throw new Error(`missing evaluation price for ${usage.model}`);
    const uncachedInput = Math.max(
      0,
      usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens,
    );
    synchronous =
      (uncachedInput * price.input +
        usage.cached_input_tokens * price.cached +
        usage.cache_write_tokens * price.cacheWrite +
        usage.output_tokens * price.output) /
      1_000_000;
  } else {
    const price = ANTHROPIC_SONNET_PRICES[usage.model];
    if (!price) throw new Error(`missing evaluation price for ${usage.model}`);
    synchronous =
      (usage.input_tokens * price.input +
        usage.cache_creation_input_tokens * price.cacheWrite +
        usage.cache_read_input_tokens * price.cached +
        usage.output_tokens * price.output) /
      1_000_000;
  }
  return {
    synchronous: roundCost(synchronous),
    batch: roundCost(synchronous / 2),
  };
}
