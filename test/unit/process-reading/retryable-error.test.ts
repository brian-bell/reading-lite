import { describe, expect, it } from "vitest";
import { retryableError } from "../../../src/process-reading";

class TestError extends Error {
  status?: number;
  constructor(name: string, message = "boom", status?: number) {
    super(message);
    this.name = name;
    if (status !== undefined) this.status = status;
  }
}

describe("retryableError", () => {
  it("non-Error values are not retryable", () => {
    expect(retryableError("oops")).toBe(false);
    expect(retryableError(undefined)).toBe(false);
  });

  it("BadStatusError 5xx is retryable; 4xx is terminal", () => {
    expect(retryableError(new TestError("BadStatusError", "500", 500))).toBe(true);
    expect(retryableError(new TestError("BadStatusError", "404", 404))).toBe(false);
  });

  it("AnthropicError 429 and 5xx are retryable; other 4xx are terminal", () => {
    expect(retryableError(new TestError("AnthropicError", "rate", 429))).toBe(true);
    expect(retryableError(new TestError("AnthropicError", "down", 503))).toBe(true);
    expect(retryableError(new TestError("AnthropicError", "auth", 401))).toBe(false);
    expect(retryableError(new TestError("AnthropicError", "bad", 400))).toBe(false);
  });

  it("OpenAIError 429 and 5xx are retryable; other 4xx are terminal", () => {
    expect(retryableError(new TestError("OpenAIError", "rate", 429))).toBe(true);
    expect(retryableError(new TestError("OpenAIError", "down", 502))).toBe(true);
    expect(retryableError(new TestError("OpenAIError", "auth", 401))).toBe(false);
  });

  it("FetchTimeoutError is retryable", () => {
    expect(retryableError(new TestError("FetchTimeoutError"))).toBe(true);
  });

  it("XApiError 5xx is retryable; X domain and 4xx errors are terminal", () => {
    expect(retryableError(new TestError("XApiError", "down", 503))).toBe(true);
    expect(retryableError(new TestError("XApiError", "auth", 401))).toBe(false);
    expect(retryableError(new TestError("XApiConfigError"))).toBe(false);
    expect(retryableError(new TestError("XThreadOutsideRecentWindowError"))).toBe(false);
    expect(retryableError(new TestError("XThreadIncompleteError"))).toBe(false);
  });

  it("BlockedHostError and OversizedResponseError are terminal", () => {
    expect(retryableError(new TestError("BlockedHostError"))).toBe(false);
    expect(retryableError(new TestError("OversizedResponseError"))).toBe(false);
  });

  // A rejected destination is a verdict; an unresolvable one is a resolver
  // report that can differ on the next attempt, like FetchTimeoutError. The
  // in-process retry only covers a blip shorter than the attempt budget, so
  // the manifest flag is what keeps a longer one recoverable for triage.
  it("DestinationResolutionError is retryable; TooManyRedirectsError is terminal", () => {
    expect(retryableError(new TestError("DestinationResolutionError"))).toBe(true);
    expect(retryableError(new TestError("TooManyRedirectsError"))).toBe(false);
  });

  // A summarizer tool call that misses the schema is one bad sample, not a
  // verdict about the source: the next reprocess can succeed. A malformed
  // embedding response is a provider contract break and stays terminal.
  it("summarizer tool-shape slips are retryable; a bad embedding response is terminal", () => {
    expect(retryableError(new TestError("BadToolInputError"))).toBe(true);
    expect(retryableError(new TestError("NoToolUseError"))).toBe(true);
    expect(retryableError(new TestError("BadEmbeddingResponseError"))).toBe(false);
  });

  it("unknown errors default to terminal", () => {
    expect(retryableError(new TestError("MysteryError"))).toBe(false);
  });
});
