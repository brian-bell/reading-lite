import { describe, expect, it } from "vitest";
import type { ListIndexItem } from "../../../src/schemas/api";
import { classify, type Decision } from "../../../scripts/extract-agent-lib/policy";
import { makeRow } from "./helpers";

function failedRow(overrides: Partial<ListIndexItem> = {}): ListIndexItem {
  return makeRow({
    status: "failed",
    error: { code: "BadStatusError", message: "bad response status 403: https://x", stage: "fetch_source" },
    ...overrides,
  });
}

function badStatus(status: number, overrides: Partial<ListIndexItem> = {}): ListIndexItem {
  return failedRow({
    error: { code: "BadStatusError", message: `bad response status ${status}: https://x`, stage: "fetch_source" },
    ...overrides,
  });
}

const CASES: Array<{ name: string; row: ListIndexItem; expected: Partial<Decision> }> = [
  {
    name: "pending rows are ineligible",
    row: makeRow({ status: "pending" }),
    expected: { decision: "ineligible" },
  },
  {
    name: "ready rows are ineligible in Phase 1 (upgrades are Phase 6)",
    row: makeRow({ status: "ready" }),
    expected: { decision: "ineligible" },
  },
  {
    name: "a running active attempt is ineligible (never race the Worker)",
    row: failedRow({
      active_attempt: { id: "at_1", trigger: "reprocess", status: "running", started_at: "2026-07-02T00:00:00.000Z" },
    }),
    expected: { decision: "ineligible" },
  },
  {
    name: "stale-annotated / DLQ-marked rows (stage queued) are out_of_scope — do NOT widen the filter",
    row: failedRow({ error: { code: "FetchTimeoutError", message: "stranded", stage: "queued" } }),
    expected: { decision: "out_of_scope" },
  },
  {
    name: "failed rows with no error stage are out_of_scope",
    row: failedRow({ error: { code: "SomeError", message: "??" } }),
    expected: { decision: "out_of_scope" },
  },
  {
    name: "TooManyRedirectsError is never retried (SSRF redirect hop cap)",
    row: failedRow({
      error: {
        code: "TooManyRedirectsError",
        message: "redirect chain exceeded 5 hops: https://x",
        stage: "fetch_source",
      },
    }),
    expected: { decision: "never" },
  },
  {
    name: "404 is a dead link",
    row: badStatus(404),
    expected: { decision: "never" },
  },
  {
    name: "410 is a dead link",
    row: badStatus(410),
    expected: { decision: "never" },
  },
  {
    name: "401 is paywalled",
    row: badStatus(401),
    expected: { decision: "never" },
  },
  {
    name: "402 is paywalled",
    row: badStatus(402),
    expected: { decision: "never" },
  },
  {
    name: "451 is blocked (legal)",
    row: badStatus(451),
    expected: { decision: "never" },
  },
  {
    name: "'not an article' reasons are never attempted",
    row: failedRow({ error: { code: "SomeError", message: "Not an article — PDF", stage: "fetch_source" } }),
    expected: { decision: "never" },
  },
  {
    name: "a URL containing pdf is not itself a permanent PDF classification",
    row: failedRow({
      url: "https://example.test/guides/pdf-rendering",
      error: {
        code: "FetchTimeoutError",
        message: "fetch timed out after 15000ms: https://example.test/guides/pdf-rendering",
        stage: "fetch_source",
      },
    }),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "403 is a bot-block — attempt via the static tier",
    row: badStatus(403),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "429 is a rate-limit — attempt via the static tier",
    row: badStatus(429),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "fetch timeouts are attempted via the static tier",
    row: failedRow({ error: { code: "FetchTimeoutError", message: "fetch timed out after 15000ms", stage: "fetch_source" } }),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "5xx origin errors are attempted via the static tier",
    row: badStatus(503),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "oversized responses are attempted (agent has a raised byte cap)",
    row: failedRow({ error: { code: "OversizedResponseError", message: "response exceeded maxBytes=8388608", stage: "fetch_source" } }),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "unknown fetch_source failures are attempted via the static tier",
    row: failedRow({ error: { code: "WeirdNewError", message: "??", stage: "fetch_source" } }),
    expected: { decision: "attempt", route: "static" },
  },
  {
    name: "RedditManualImportError routes to the reddit path",
    row: failedRow({
      url: "https://www.reddit.com/r/programming/comments/abc/thread/",
      error: { code: "RedditManualImportError", message: "import locally", stage: "fetch_source" },
    }),
    expected: { decision: "attempt", route: "reddit" },
  },
  {
    name: "a reddit thread URL routes to the reddit path regardless of error code",
    row: failedRow({
      url: "https://www.reddit.com/r/programming/comments/abc/thread/",
      error: { code: "FetchTimeoutError", message: "fetch timed out", stage: "fetch_source" },
    }),
    expected: { decision: "attempt", route: "reddit" },
  },
  {
    name: "a failed YouTube watch URL routes to the youtube path",
    row: failedRow({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      error: { code: "BadStatusError", message: "bad response status 429: https://x", stage: "fetch_source" },
    }),
    expected: { decision: "attempt", route: "youtube" },
  },
  {
    name: "a dead YouTube video (404 oEmbed) is never attempted",
    row: badStatus(404, { url: "https://www.youtube.com/watch?v=gone" }),
    expected: { decision: "never" },
  },
];

describe("classify", () => {
  for (const { name, row, expected } of CASES) {
    it(name, () => {
      const decision = classify(row);
      expect(decision).toMatchObject(expected);
      expect(decision.why).toBeTruthy();
    });
  }
});
