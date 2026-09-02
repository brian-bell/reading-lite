// Formats the provider usage returned by a judgement call so execute runs show
// what was actually billed instead of only the pre-run estimate. OpenAI reports
// reasoning tokens separately (they are billed as output); Anthropic folds them
// into output_tokens and reports no separate figure, so the reasoning column is
// omitted for Anthropic rather than shown as a misleading zero.

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
