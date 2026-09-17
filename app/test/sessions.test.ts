import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import {
  revokeFromResponse,
  sessionHeading,
  sessionsFromResponse,
  type SessionListItem,
} from "../src/sessions";

const session = (over: Partial<SessionListItem> = {}): SessionListItem => ({
  id: "ses_1",
  current: false,
  authenticated_at_ms: 1,
  last_seen_at_ms: 2,
  revoked_at_ms: null,
  revocation_reason: null,
  user_agent_label: "Firefox",
  usable: true,
  ...over,
});

const listed = {
  sessions: [session({ current: true })],
  session_cap_warning: null,
};

describe("sessionsFromResponse", () => {
  it("returns the list on 200", () => {
    expect(sessionsFromResponse(200, listed)).toEqual({ state: "ready", listed });
  });

  it("maps 403 and 412 to their states rather than a throw", () => {
    expect(sessionsFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(sessionsFromResponse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" })).toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  it("throws a 401 so the session-ended machinery sees it", () => {
    expect(() => sessionsFromResponse(401, { error: "unauthorized" })).toThrow(ApiError);
    try {
      sessionsFromResponse(401, { error: "unauthorized" });
    } catch (error) {
      expect(error).toMatchObject({ status: 401, message: "unauthorized" });
    }
  });

  it("throws the backend's message for a 5xx", () => {
    try {
      sessionsFromResponse(503, { error: "storage unavailable" });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 503, message: "storage unavailable" });
    }
  });

  it("throws for an unexpected body", () => {
    expect(() => sessionsFromResponse(200, { sessions: "nope" })).toThrow(/unexpected body/);
  });
});

describe("revokeFromResponse", () => {
  it("is revoked on 200", () => {
    expect(revokeFromResponse(200, { ok: true }, "failed to revoke session")).toEqual({ kind: "revoked" });
  });

  it("maps 403 and 412 to their states", () => {
    expect(revokeFromResponse(403, { error: "forbidden" }, "failed to revoke session")).toEqual({
      kind: "forbidden",
    });
    expect(revokeFromResponse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, "failed")).toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
  });

  it("throws the backend's message, or the SPA's fallback when the body is silent", () => {
    try {
      revokeFromResponse(500, { error: "boom" }, "failed to revoke session");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 500, message: "boom" });
    }
    try {
      revokeFromResponse(502, "<html>", "failed to revoke sessions");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 502, message: "failed to revoke sessions" });
    }
  });
});

describe("sessionHeading", () => {
  it("falls back to Unknown browser", () => {
    expect(sessionHeading(session({ user_agent_label: null }))).toBe("Unknown browser");
  });

  it("keeps expired and revoked sessions visible in the label", () => {
    expect(sessionHeading(session({ user_agent_label: "Old laptop", usable: false }))).toBe("Old laptop · expired");
    expect(
      sessionHeading(
        session({ user_agent_label: "Phone", usable: false, revoked_at_ms: 4, revocation_reason: "user" }),
      ),
    ).toBe("Phone · revoked (user)");
  });
});
