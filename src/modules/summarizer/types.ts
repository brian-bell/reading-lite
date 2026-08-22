import type { ReadingSummary } from "../../schemas/reading-summary";

export interface SimilarContext {
  id: string;
  url: string;
  title?: string;
  tldr?: string;
  // Measured cosine similarity to the reading being summarized. Shown to the
  // model so closeness is read off the number that was actually computed
  // rather than inferred from how alike two titles look.
  score?: number;
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
