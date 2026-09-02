// Formats the provider usage returned by a judgement call so execute runs show
// the tokens the provider actually reported instead of only the pre-run
// estimate, whose output assumption ignores reasoning entirely.
//
// The reasoning column is the reasoning share of the output count, not an
// extra charge on top of it: OpenAI breaks that share out, so it is shown;
// Anthropic does not, so the column is omitted rather than shown as a
// misleading zero.
//
// The counts here are the plain input and output figures. Cache tokens are
// deliberately left out: for OpenAI cached_input_tokens is already a subset of
// input_tokens, but for Anthropic cache reads and writes are billed on top of
// input_tokens at their own rates, so an Anthropic run's input column is the
// uncached input only and understates the billed input.

import type { SummarizationUsage } from "../../src/schemas/manifest";

export interface JudgementUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null until a provider reports reasoning tokens separately. */
  reasoningTokens: number | null;
}

export function emptyUsageTotals(): JudgementUsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: null };
}

export function addUsage(
  totals: JudgementUsageTotals,
  usage: SummarizationUsage,
): void {
  totals.calls++;
  totals.inputTokens += usage.input_tokens;
  totals.outputTokens += usage.output_tokens;
  if (usage.provider === "openai") {
    totals.reasoningTokens = (totals.reasoningTokens ?? 0) + usage.reasoning_tokens;
  }
}

export function formatUsage(usage: SummarizationUsage): string {
  const reasoning =
    usage.provider === "openai" ? ` reasoning=${usage.reasoning_tokens}` : "";
  return `usage input=${usage.input_tokens} output=${usage.output_tokens}${reasoning}`;
}

export function formatUsageTotals(totals: JudgementUsageTotals): string {
  const reasoning =
    totals.reasoningTokens === null ? "" : ` reasoning=${totals.reasoningTokens}`;
  return (
    `Usage: ${totals.calls} judgement${totals.calls === 1 ? "" : "s"}; ` +
    `input=${totals.inputTokens} output=${totals.outputTokens}${reasoning}`
  );
}
