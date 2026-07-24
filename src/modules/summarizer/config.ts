export type SummarizerProvider = "openai" | "anthropic";

export class SummarizerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizerConfigError";
  }
}

export function parseSummarizerProvider(
  value: string | undefined,
): SummarizerProvider {
  const provider = value ?? "openai";
  if (provider === "openai" || provider === "anthropic") return provider;
  throw new SummarizerConfigError(`invalid SUMMARIZER_PROVIDER: ${provider}`);
}
