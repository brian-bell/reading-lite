import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from "../../../src/control-plane/constants";
import { clearSessionCookieHeader, sessionCookieHeader } from "../../../src/control-plane/cookies";

describe("session cookie", () => {
  it("sets a durable host-only cookie with a 90-day Max-Age", () => {
    const header = sessionCookieHeader("ses_550e8400-e29b-41d4-a716-446655440000.ab");
    expect(header.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
    expect(header).not.toMatch(/Max-Age=0(?!\d)/);
    expect(header.includes("Domain=")).toBe(false);
  });

  it("clears the same host-only cookie", () => {
    const header = clearSessionCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/");
  });
});
