import { describe, expect, it } from "vitest";
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

// The account page's tests own the list read end to end: the list on 200, and
// 401, 403, 412, and a 5xx's message as the page shows them. These cover only
// what no page test reaches.

describe("sessionsFromResponse", () => {
  it("throws for an unexpected body", () => {
    expect(() => sessionsFromResponse(200, { sessions: "nope" })).toThrow(/unexpected body/);
  });
});

describe("revokeFromResponse", () => {
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
