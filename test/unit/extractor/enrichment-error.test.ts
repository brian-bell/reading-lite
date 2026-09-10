import { describe, expect, it } from "vitest";
import {
  normalizeEnrichmentError,
  OversizedResponseError,
  redactDurableErrorText,
  redactUrlUserinfo,
} from "../../../src/modules/extractor";

describe("redactUrlUserinfo", () => {
  it("strips WHATWG username and password", () => {
    expect(redactUrlUserinfo("https://user:secret@evil.example/path?q=1")).toBe(
      "https://evil.example/path?q=1",
    );
  });

  it("leaves a URL without userinfo unchanged", () => {
    expect(redactUrlUserinfo("https://www.youtube.com/watch?v=abc")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });
});

describe("redactDurableErrorText", () => {
  it("strips query and hash from URLs in the message", () => {
    const raw =
      "response exceeded maxBytes=1000: https://www.youtube.com/api/timedtext?v=abc&lang=en&expire=9&signature=tok";
    expect(redactDurableErrorText(raw)).toBe(
      "response exceeded maxBytes=1000: https://www.youtube.com/api/timedtext",
    );
  });

  it("strips userinfo and query together", () => {
    expect(
      redactDurableErrorText("blocked: https://user:pass@evil.example/captions?token=abc#frag"),
    ).toBe("blocked: https://evil.example/captions");
  });
});

describe("normalizeEnrichmentError", () => {
  it("uses Error.name and a redacted message", () => {
    const err = new OversizedResponseError(
      "https://www.youtube.com/api/timedtext?v=abc&signature=tok",
      1000,
    );
    expect(normalizeEnrichmentError(err)).toEqual({
      code: "OversizedResponseError",
      message: "response exceeded maxBytes=1000: https://www.youtube.com/api/timedtext",
    });
  });

  it("falls back for a non-Error throw", () => {
    expect(normalizeEnrichmentError("boom")).toEqual({
      code: "unknown_error",
      message: "unknown error",
    });
  });

  it("falls back for an empty Error message", () => {
    const err = new Error("");
    err.name = "";
    expect(normalizeEnrichmentError(err)).toEqual({
      code: "unknown_error",
      message: "unknown error",
    });
  });
});
