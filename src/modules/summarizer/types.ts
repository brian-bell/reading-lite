import type { ReadingSummary } from "../../schemas/reading-summary";

export interface SimilarContext {
  id: string;
  url: string;
  title?: string;
  tldr?: string;
}

export interface SummarizeReadingInput {
  url: string;
  extractedText: string;
  title?: string;
  similarReadings: SimilarContext[];
}

export type OpenAIReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ProviderSummarizeResult<TUsage> {
  reading: ReadingSummary;
  usage: TUsage;
}
