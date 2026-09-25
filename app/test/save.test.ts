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

  // 200 is the manifest of the reading that already owns this URL, and what it
  // says about itself is what the reading will tell the reader on arrival (#432).
  it("opens a ready reading a 200 returns, saying it is already in the library", () => {
    expect(submitFromResponse(200, { id: "rd_1", url: "https://example.com/a", status: "ready" })).toEqual({
      kind: "existing",
      id: "rd_1",
      notice: "already-saved",
    });
  });

  it("says a pending owner is still processing", () => {
    expect(
      submitFromResponse(200, {
        id: "rd_1",
        url: "https://example.com/a",
        status: "pending",
        active_attempt: { attempt_id: "att_1", status: "running", stage: "summarize" },
      }),
    ).toEqual({ kind: "existing", id: "rd_1", notice: "still-processing" });
  });

  // A reprocess keeps `status: "ready"` and adds the running attempt, and the
  // reading's own status card reads it the same way round.
  it("says a ready owner with an attempt running over it is still processing", () => {
    expect(
      submitFromResponse(200, {
        id: "rd_1",
        url: "https://example.com/a",
        status: "ready",
        active_attempt: { attempt_id: "att_2", status: "running" },
      }),
    ).toEqual({ kind: "existing", id: "rd_1", notice: "still-processing" });
  });

  // An attempt that is not running is not what the reader is looking at.
  it("ignores an attempt that is no longer running", () => {
    expect(
      submitFromResponse(200, {
        id: "rd_1",
        url: "https://example.com/a",
        status: "ready",
        active_attempt: null,
      }),
    ).toEqual({ kind: "existing", id: "rd_1", notice: "already-saved" });
  });

  it("says nothing about a 200 whose status it does not recognise", () => {
    expect(submitFromResponse(200, { id: "rd_1", url: "https://example.com/a" })).toEqual({
      kind: "existing",
      id: "rd_1",
      notice: undefined,
    });
    expect(submitFromResponse(200, { id: "rd_1", status: "archived" })).toEqual({
      kind: "existing",
      id: "rd_1",
      notice: undefined,
    });
  });

  // A body whose state is not the shape the manifest promises still names a
  // reading to open; it just says nothing about it.
  it("opens a 200 whose state is the wrong shape, without a notice", () => {
    expect(submitFromResponse(200, { id: "rd_1", status: 7, active_attempt: "running" })).toEqual({
      kind: "existing",
      id: "rd_1",
    });
    expect(submitFromResponse(200, { id: "rd_1", status: "ready", active_attempt: { status: 7 } })).toEqual({
      kind: "existing",
      id: "rd_1",
      notice: "already-saved",
    });
  });

  it("throws when a 200 names no reading", () => {
    expect(() => submitFromResponse(200, { status: "ready" })).toThrow(ApiError);
  });

  // No owner is ever half-written any more (the claim commits the reading, its
  // URL, and its attempt together), so a 409 is only an attempt already
  // running: a refusal with no reading to open.
  it("reports a 409 over a running attempt as already processing", () => {
    expect(submitFromResponse(409, { error: "reading already has an active attempt" })).toEqual({
      kind: "already-processing",
    });
  });

  // What the retired `initializing` 409 looked like: an id is no longer a
  // reason to open anything, and a 409 this app cannot explain is its error.
  it.each([
    { error: "reading owner is still initializing", id: "rd_2", poll: "/api/readings/rd_2" },
    { error: "markdown content not available" },
  ])("throws on a 409 it does not recognise (%#)", (body) => {
    expect(() => submitFromResponse(409, body)).toThrow(body.error);
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

  // 429 and 503 are values too (#433): the page keeps the form and offers the
  // way on, rather than replacing it with the retryable server error.
  it("names the request rate a 429 hit, and when it resets", () => {
    expect(
      submitFromResponse(429, {
        error: "rate limited",
        code: "rate_limited",
        limit: "request_rate",
        reset_at: "2026-09-16T12:00:00Z",
      }),
    ).toEqual({ kind: "limited", limit: "request_rate", resetAt: "2026-09-16T12:00:00Z" });
  });

  it.each(["hourly", "monthly"] as const)("names the %s quota a 429 exhausted", (limit) => {
    expect(
      submitFromResponse(429, {
        error: "quota exhausted",
        code: "quota_exhausted",
        limit,
        reset_at: "2026-10-01T00:00:00Z",
      }),
    ).toEqual({ kind: "limited", limit, resetAt: "2026-10-01T00:00:00Z" });
  });

  // The enum stays open, as the reading projection's do: a window added to the
  // backend later must not cost the reader the URL they typed. The page has a
  // sentence for a limit it does not recognize.
  it("carries a window it has never seen through", () => {
    expect(
      submitFromResponse(429, { error: "quota exhausted", code: "quota_exhausted", limit: "daily" }),
    ).toEqual({ kind: "limited", limit: "daily", resetAt: undefined });
  });

  // A reset the page cannot format is left out rather than thrown over: the
  // reader is told which limit they hit either way.
  it.each([{ reset_at: 1737000000 }, { reset_at: "" }, {}])("drops a reset_at it cannot read (%#)", (reset) => {
    expect(submitFromResponse(429, { error: "rate limited", code: "rate_limited", limit: "hourly", ...reset })).toEqual(
      { kind: "limited", limit: "hourly", resetAt: undefined },
    );
  });

  // The usage guard's own 429 names no limit at all.
  it("reports the usage guard's 429 as the state of its own", () => {
    expect(submitFromResponse(429, { error: "usage guard unavailable" })).toEqual({ kind: "guard-unavailable" });
  });

  it.each([{ error: "rate limited" }, { error: "rate limited", limit: "" }, null])(
    "throws on a 429 that names neither a limit nor the guard (%#)",
    (body) => {
      try {
        submitFromResponse(429, body);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(429);
        expect((error as ApiError).message).toBe(body === null ? "save returned 429" : "rate limited");
      }
    },
  );

  it("reports a 503 that names the reading it could not queue", () => {
    expect(submitFromResponse(503, { error: "queue unavailable", id: "rd_FXPENDNG01" })).toEqual({
      kind: "unavailable",
      id: "rd_FXPENDNG01",
    });
  });

  // The local `wrangler dev` body: no queue binding, and so no reading.
  it("reports a 503 that names no reading", () => {
    expect(submitFromResponse(503, { error: "queue binding READING_JOBS is not configured" })).toEqual({
      kind: "unavailable",
      id: undefined,
    });
  });

  it.each([401, 500])("throws an ApiError carrying %i", (status) => {
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
