import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { categorize, type FailureCategory } from "../src/reading-failure";
import type { Reading, ReadingError } from "../src/reading";

// The failure mapping, pinned against the fixture pack. The pack is generated
// at the repo root from the real backend error classes, so renaming one — or
// moving which stage raises it — fails here instead of quietly demoting a
// reading to "Unknown".

const readings = pack.readings as Record<string, Reading | undefined>;

/** Fixture name → the category the acceptance matrix gives it. */
const EXPECTED: Record<string, FailureCategory> = {
  "fail-source-unreachable": "source-unreachable",
  "fail-source-incomplete": "source-incomplete",
  "fail-provider-limit": "provider-limit",
  "fail-provider-error": "provider-error",
  "fail-key-invalid": "key-invalid",
  "fail-key-missing": "key-missing",
  "fail-billing": "billing",
  "fail-hosting-limit": "hosting-limit",
  "fail-stopped": "stopped",
  "fail-unknown": "unknown",
};

function errorOfFixture(name: string): ReadingError {
  const fixture = pack.fixtures.find((candidate) => candidate.name === name);
  expect(fixture, `fixture ${name} is in the pack`).toBeDefined();
  const error = readings[fixture!.id]?.error;
  expect(error, `fixture ${name} carries a manifest error`).toBeDefined();
  return error!;
}

describe("failure categories", () => {
  it("covers every failed fixture in the pack", () => {
    const failed = pack.fixtures.filter((fixture) => fixture.status === "failed").map((fixture) => fixture.name);
    expect(failed.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, category] of Object.entries(EXPECTED)) {
    it(`puts ${name} in ${category}`, () => {
      expect(categorize(errorOfFixture(name)).category).toBe(category);
    });
  }

  it("keeps the backend's message, and uses it as the headline only when unknown", () => {
    const known = categorize(errorOfFixture("fail-source-unreachable"));
    expect(known.headline).toBe("The page couldn't be fetched.");
    expect(known.message).toBe(errorOfFixture("fail-source-unreachable").message);
    expect(known.stage).toBe("fetch_source");

    const unknown = categorize(errorOfFixture("fail-unknown"));
    expect(unknown.headline).toBe(unknown.message);
  });

  // The provider classes carry the provider's own message, so the status is a
  // field. A 403 at fetch_source is the site refusing us, whatever its status.
  // A 401 or 403 that reaches an adapter was sent with the hosted key (the
  // reader's own key fails with an account code first), so the reader has no
  // key to fix and it stays a provider error.
  it.each<[string, ReadingError, FailureCategory]>([
    ["a site 403", { code: "BadStatusError", message: "bad response status 403: https://x.example/a", stage: "fetch_source", http_status: 403 }, "source-unreachable"],
    ["a hosted-key 401", { code: "OpenAIError", message: "Incorrect API key provided", stage: "summarize", http_status: 401 }, "provider-error"],
    ["a hosted-key 403", { code: "AnthropicError", message: "permission denied", stage: "embed_source", http_status: 403 }, "provider-error"],
    ["a provider 429", { code: "AnthropicError", message: "slow down", stage: "summarize", http_status: 429 }, "provider-limit"],
    ["a provider 500", { code: "OpenAIError", message: "The server had an error", stage: "embed_summary", http_status: 500 }, "provider-error"],
  ])("categorizes %s by stage and HTTP status", (_label, error, category) => {
    expect(categorize(error).category).toBe(category);
  });

  // The provider-account codes (docs/openapi.yaml, ManifestError.code) decide
  // whatever the stage, and each names its own next step. Key and billing
  // failures are fixed in provider settings, so they carry the link's label;
  // their messages are the backend's fixed recovery sentences, which `next`
  // replaces, so they are not repeated as detail.
  it.each<[string, FailureCategory, string, string | undefined]>([
    ["provider_key_required", "key-missing", "No OpenAI key is connected.", "Connect key"],
    ["provider_key_invalid", "key-invalid", "Your OpenAI key needs replacing.", "Replace key"],
    ["provider_key_undecryptable", "key-invalid", "Your OpenAI key needs replacing.", "Replace key"],
    ["provider_model_access", "model-access", "Your OpenAI key can't use the models Reading Lite needs.", "Provider settings"],
    ["provider_insufficient_quota", "billing", "Your OpenAI account is out of credit.", "Provider settings"],
  ])("maps %s to %s with its own copy and a link to provider settings", (code, category, headline, settings) => {
    const failure = categorize({ code, message: "connect a key, then retry", stage: "summarize" });
    expect(failure).toMatchObject({ category, headline, settings });
    expect(failure.next).toMatch(/then retry\.$/);
    expect(failure.detail).toBeUndefined();
  });

  // The limits clear on their own, so their next step is to wait, and the
  // backend's message stays as detail: it names which limit.
  it.each<[string, ReadingError, FailureCategory, string]>([
    ["a provider rate limit", { code: "RateLimitedError", message: "rate limited (status 429)", stage: "summarize" }, "provider-limit", "Wait a few minutes, then retry."],
    ["a hosting limit", { code: "SpendAdmissionError", message: "paid spend admission: daily_spend", stage: "summarize" }, "hosting-limit", "Retry once the limit resets."],
  ])("tells %s to wait, with no settings link", (_label, error, category, next) => {
    expect(categorize(error)).toMatchObject({ category, next, detail: error.message });
    expect(categorize(error).settings).toBeUndefined();
  });

  // Failures recorded before the backend kept the status have none. The
  // message is the provider's prose, not a contract, and is never parsed.
  it("never reads a key problem out of the message text", () => {
    const prose: ReadingError = { code: "OpenAIError", message: "upstream said your API key status 401", stage: "summarize" };
    expect(categorize(prose)).toMatchObject({ category: "provider-error" });
    expect(categorize(prose).settings).toBeUndefined();
  });

  // stale_pending and stale_active_attempt are markers the backend writes
  // itself, not class names. stale_pending carries no stage; the backend's
  // expiredActiveAttempt keeps whatever stage the attempt had reached, so
  // stale_active_attempt arrives with one and must still read as stopped.
  it("recognises the staleness markers with or without a stage", () => {
    for (const code of ["stale_pending", "stale_active_attempt"]) {
      expect(categorize({ code, message: "pending > 900s" }).category).toBe("stopped");
    }
    const expiredWhileFetching: ReadingError = {
      code: "stale_active_attempt",
      message: "active attempt > 900s",
      stage: "fetch_source",
    };
    expect(categorize(expiredWhileFetching).category).toBe("stopped");
  });

  // These are all raised inside the backend's fetch_source stage, so the
  // generic "failed while fetching" fallback would swallow every one of them.
  // The class says more than the stage does: the page was reached, and what
  // came back cannot be summarized.
  it("keeps the source-incomplete classes ahead of the fetch-stage fallback", () => {
    const codes = [
      "RedditManualImportError",
      "XApiConfigError",
      "XThreadIncompleteError",
      "XThreadOutsideRecentWindowError",
    ];
    for (const code of codes) {
      const error: ReadingError = { code, message: "needs a manual import", stage: "fetch_source" };
      expect(categorize(error).category, code).toBe("source-incomplete");
    }
  });

  it("still reads an exhausted queue at fetch_source as stopped", () => {
    const error: ReadingError = {
      code: "QueueRetriesExhaustedError",
      message: "queue delivery retries exhausted",
      stage: "fetch_source",
    };
    expect(categorize(error).category).toBe("stopped");
  });

  it("falls back to unknown for a class it has never seen", () => {
    const surprise: ReadingError = { code: "SomethingNewError", message: "unheard of", stage: "write_indexes" };
    expect(categorize(surprise).category).toBe("unknown");
  });
});
