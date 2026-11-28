export function retryableError(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: unknown }).status;
  if (e.name === "BadStatusError") {
    return typeof status === "number" && status >= 500;
  }
  if (e.name === "XApiError") {
    return typeof status === "number" && status >= 500;
  }
  if (e.name === "AnthropicError" || e.name === "OpenAIError") {
    return typeof status === "number" && (status === 429 || status >= 500);
  }
  if (e.name === "FetchTimeoutError") return true;
  if (e.name === "BadToolInputError" || e.name === "NoToolUseError") return true;
  if (e.name === "DestinationResolutionError") return true;
  if (e.name === "QueueRetriesExhaustedError") return true;
  if (e.name === "ProcessingDeferExpiredError") return true;
  if (e.name === "ReadingReservationExpiredError") return true;
  return false;
}
