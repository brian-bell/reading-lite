import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { meaningOutcomeFromResponse } from "../src/similar-readings";

describe("meaningOutcomeFromResponse", () => {
  it.each([
    [0.55, "Faint"],
    [0.5999, "Faint"],
    [0.6, "Near"],
    [0.6499, "Near"],
    [0.65, "Close"],
    [1, "Close"],
  ])("bands a score of %s as %s, and drops the score", (score, closeness) => {
    expect(meaningOutcomeFromResponse(200, { items: [{ id: "rd_a", url: "https://a.example/", score }] })).toEqual({
      kind: "results",
      items: [{ id: "rd_a", url: "https://a.example/", title: "https://a.example/", closeness }],
    });
  });

  it.each([
    [
      "a missing key is the capture refusal, never categorize's",
      409,
      { error: "connect a key, then retry", code: "provider_key_required" },
      { kind: "refusal", refusal: { kind: "key-required" } },
    ],
    [
      "a rejected key sends the reader to provider settings",
      409,
      { error: "replace the key", code: "provider_key_invalid" },
      {
        kind: "failure",
        failure: {
          category: "key-invalid",
          headline: "Your OpenAI key needs replacing.",
          message: "replace the key",
          next: "Replace your key, then retry.",
          settings: "Replace key",
        },
      },
    ],
    [
      "the daily cap is a limit to wait out",
      429,
      { error: "daily spend cap reached", code: "SpendAdmissionError" },
      {
        kind: "failure",
        failure: {
          category: "hosting-limit",
          headline: "Reading Lite's processing limit was reached.",
          message: "daily spend cap reached",
          detail: "daily spend cap reached",
          next: "Retry once the limit resets.",
        },
      },
    ],
    [
      "a provider that did not answer",
      503,
      { error: "meaning search unavailable; retry" },
      { kind: "refusal", refusal: { kind: "unavailable" } },
    ],
  ])("%s", (_name, status, body, outcome) => {
    expect(meaningOutcomeFromResponse(status, body)).toEqual(outcome);
  });

  it.each([
    [409, { error: "processing stopped", code: "stale_pending" }],
    [429, { error: "slow down", limit: "hourly" }],
    [500, { error: "internal error" }],
  ])("leaves %s %j to the server error", (status, body) => {
    expect(() => meaningOutcomeFromResponse(status, body)).toThrow(ApiError);
  });
});
