import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { saveUrlProblem, submitFromResponse } from "../src/save";

// The save rule and the response mapping, without a DOM. The rule mirrors the
// backend's webUrl() in src/schemas/api.ts; these are the cases where the two
// have to agree.

describe("saveUrlProblem", () => {
  it.each([
    "https://example.com/article",
    "http://example.com",
    "https://example.com:8443/a?b=c#d",
    "HTTPS://EXAMPLE.COM/A",
  ])("accepts %s", (url) => {
    expect(saveUrlProblem(url)).toBeUndefined();
  });

  it("accepts a URL with surrounding whitespace, as a paste carries", () => {
    expect(saveUrlProblem("  https://example.com/a\n")).toBeUndefined();
  });

  it("asks for a URL when the field is empty", () => {
    expect(saveUrlProblem("")).toBe("Enter the URL of the page you want to save.");
    expect(saveUrlProblem("   ")).toBe("Enter the URL of the page you want to save.");
  });

  it.each(["example.com", "not a url", "/readings/rd_1", "www.example.com/a"])(
    "rejects %s, which is not a URL at all",
    (raw) => {
      expect(saveUrlProblem(raw)).toBe("Enter a full URL, like https://example.com/article.");
    },
  );

  // The backend's refinement: parseable is not enough, it has to be a web URL.
  it.each(["ftp://example.com/a", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi"])(
    "rejects %s, which parses but is not http(s)",
    (raw) => {
      expect(saveUrlProblem(raw)).toBe("Only http and https links can be saved.");
    },
  );
});

describe("submitFromResponse", () => {
  const ACCEPTED = {
    id: "rd_FXPENDNG01",
    status: "pending",
    poll: "/api/readings/rd_FXPENDNG01",
    attempt_id: "att_1",
  };

  it("takes the id out of a 202", () => {
    expect(submitFromResponse(202, ACCEPTED)).toEqual({ kind: "accepted", id: "rd_FXPENDNG01" });
  });

  it("lets a field the backend adds later through", () => {
    expect(submitFromResponse(202, { ...ACCEPTED, queued_at: "2026-09-16T00:00:00Z" })).toEqual({
      kind: "accepted",
      id: "rd_FXPENDNG01",
    });
  });

  // Only the id is read: the reading's own page reads its status and attempt.
  it("accepts a 202 that carries nothing but the id", () => {
    expect(submitFromResponse(202, { id: "rd_FXPENDNG01" })).toEqual({
      kind: "accepted",
      id: "rd_FXPENDNG01",
    });
  });

  it("throws when a 202 names no reading", () => {
    expect(() => submitFromResponse(202, { status: "pending" })).toThrow(ApiError);
  });

  it("renders a 400 in the backend's own words", () => {
    expect(submitFromResponse(400, { error: "url rejected: host is not allowed", code: "unsupported_url" })).toEqual({
      kind: "invalid",
      message: "url rejected: host is not allowed",
    });
  });

  it("falls back to its own words when a 400 says nothing", () => {
    expect(submitFromResponse(400, null)).toEqual({ kind: "invalid", message: "That URL can't be saved." });
  });

  // 200 is the manifest of the reading that already owns this URL.
  it("opens the existing reading a 200 returns", () => {
    expect(submitFromResponse(200, { id: "rd_1", url: "https://example.com/a", status: "ready" })).toEqual({
      kind: "existing",
      id: "rd_1",
    });
  });

  // 409 `initializing` names the id to poll.
  it("opens the reading a 409 names", () => {
    expect(
      submitFromResponse(409, {
        error: "reading owner is still initializing",
        id: "rd_2",
        poll: "/api/readings/rd_2",
      }),
    ).toEqual({ kind: "existing", id: "rd_2" });
  });

  // 409 `conflict` names no reading, so there is nothing to open.
  it("throws on a 409 with no reading to open", () => {
    expect(() => submitFromResponse(409, { error: "reading already has an active attempt" })).toThrow(
      "reading already has an active attempt",
    );
  });

  // 403 and 412 are values, as in readingFromResponse and libraryFromResponse:
  // the page renders the shared state rather than the retryable server error.
  it("reports a 403 as the forbidden state", () => {
    expect(submitFromResponse(403, { error: "forbidden" })).toEqual({ kind: "forbidden" });
  });

  it("reports a 412 with the account it is actually signed in as", () => {
    expect(submitFromResponse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" })).toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
  });

  it("reports a 412 that names no account", () => {
    expect(submitFromResponse(412, { error: "expected tenant mismatch" })).toEqual({
      kind: "account-changed",
      actingTenant: undefined,
    });
  });

  it.each([401, 429, 503, 500])("throws an ApiError carrying %i", (status) => {
    try {
      submitFromResponse(status, { error: "nope" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
      expect((error as ApiError).message).toBe("nope");
    }
  });

  it("names the status when the body says nothing", () => {
    expect(() => submitFromResponse(502, "<html>gateway</html>")).toThrow("save returned 502");
  });
});
