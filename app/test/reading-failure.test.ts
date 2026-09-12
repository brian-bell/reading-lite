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
  "fail-key-problem": "key-problem",
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

  // BadStatusError is the site refusing us at fetch_source and the provider
  // refusing us at summarize. Neither the code nor the status alone decides.
  it("separates the same class by stage and by provider status", () => {
    const site: ReadingError = { code: "BadStatusError", message: "bad response status 403: https://x.example/a", stage: "fetch_source" };
    expect(categorize(site).category).toBe("source-unreachable");

    const key: ReadingError = { code: "BadStatusError", message: "bad response status 403: https://api.openai.com/v1/responses", stage: "summarize" };
    expect(categorize(key).category).toBe("key-problem");

    const provider: ReadingError = { code: "BadStatusError", message: "bad response status 500: https://api.openai.com/v1/responses", stage: "summarize" };
    expect(categorize(provider).category).toBe("provider-error");

    const limit: ReadingError = { code: "BadStatusError", message: "bad response status 429: https://api.openai.com/v1/responses", stage: "summarize" };
    expect(categorize(limit).category).toBe("provider-limit");
  });

  it("never reads a key problem out of a message with no status", () => {
    const vague: ReadingError = { code: "OpenAIError", message: "the provider connection dropped", stage: "summarize" };
    expect(categorize(vague).category).toBe("provider-error");
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
