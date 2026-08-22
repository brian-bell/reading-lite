import { describe, expect, it } from "vitest";
import { httpStatusFromMessage, reasonForFailure } from "../../../scripts/corpus-lib/reason";

describe("httpStatusFromMessage", () => {
  it("pulls the 3-digit status out of a BadStatusError message", () => {
    expect(httpStatusFromMessage("bad response status 403: https://x")).toBe(403);
    expect(httpStatusFromMessage("no status here")).toBe(0);
    expect(httpStatusFromMessage(undefined)).toBe(0);
  });
});

describe("reasonForFailure", () => {
  it("labels known HTTP statuses from BadStatusError", () => {
    const r = (s: number) => reasonForFailure("BadStatusError", `bad response status ${s}: u`, "https://a.com/x");
    expect(r(403)).toMatch(/403.*Forbidden/);
    expect(r(404)).toMatch(/404.*dead link/);
    expect(r(402)).toMatch(/402.*paywall/i);
    expect(r(429)).toMatch(/429.*Rate limited/);
    expect(r(526)).toMatch(/526.*server\/origin/);
  });

  it("describes non-status error codes", () => {
    expect(reasonForFailure("OversizedResponseError", "", "https://a.com/x")).toMatch(/byte cap/);
    expect(reasonForFailure("BadToolInputError", "", "https://a.com/x")).toMatch(/Summarization failed/);
    expect(reasonForFailure("FetchTimeoutError", "", "https://a.com/x")).toMatch(/timed out/);
    expect(
      reasonForFailure("SourceRejectedError", "teaser of the URL", "https://a.com/x"),
    ).toMatch(/Thin extraction — not a full article or transcript/);
    expect(
      reasonForFailure(
        "OpenAISourceRejectedError",
        "metadata-only YouTube floor, no transcript",
        "https://www.youtube.com/watch?v=YtTWNzOtkxU",
      ),
    ).toMatch(/youtube-import/);
    expect(
      reasonForFailure("SourceRejectedError", "no transcript", "https://youtu.be/YtTWNzOtkxU"),
    ).toMatch(/youtube-import/);
  });

  it("honors the per-url override map and reddit special-case", () => {
    expect(
      reasonForFailure(
        "BadStatusError",
        "status 403",
        "https://www.thebestideasforkids.com/wp-content/uploads/2024/11/Thanksgiving-Bingo-Cards-The-Best-Ideas-for-Kids.pdf",
      ),
    ).toMatch(/Not an article/);
    expect(reasonForFailure("BadStatusError", "status 403", "https://www.reddit.com/r/x/comments/1")).toMatch(/Reddit/);
    expect(reasonForFailure("BadStatusError", "status 403", "https://redd.it/d0zpsh")).toMatch(/Reddit/);
  });

  it("no longer overrides YouTube watch URLs (now supported by the extractor)", () => {
    // Issue #17: YouTube watch pages are extractable, so a failed YouTube reading
    // derives its reason from the manifest error and stays recoverable.
    expect(
      reasonForFailure("BadStatusError", "status 503", "https://www.youtube.com/watch?v=YtTWNzOtkxU"),
    ).toMatch(/HTTP 503/);
  });
});
