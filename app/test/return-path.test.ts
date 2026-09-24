import { afterEach, describe, expect, it } from "vitest";
import {
  LOGIN_NEXT_STORAGE_KEY,
  STEP_UP_LOGIN_HREF,
  clearReturnPath,
  consumeReturnPath,
  loginHref,
  rememberReturnPath,
  safeReturnPath,
} from "../src/auth/return-path";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

// Acceptance matrix, Return paths: same-origin /, /readings/:id, /save, and
// /account/security, each with only its own parameters.
describe("safeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/?q=forests", "/?q=forests"],
    ["/?q=a+b&tag=ai&offset=20", "/?q=a+b&tag=ai&offset=20"],
    ["/readings/rd_0123456789", "/readings/rd_0123456789"],
    ["/readings/rd_ONE?view=source", "/readings/rd_ONE?view=source"],
    ["/save", "/save"],
    ["/account/security", "/account/security"],
    ["  /save  ", "/save"],
  ])("accepts %j", (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it.each([
    ["/?q=x&evil=1&offset=40", "/?q=x&offset=40"],
    ["/?next=https://evil.example", "/"],
    ["/readings/rd_ONE?view=source&q=x", "/readings/rd_ONE?view=source"],
    ["/readings/rd_ONE?next=https://evil.example", "/readings/rd_ONE"],
    ["/save?url=https://example.com", "/save"],
    ["/account/security?next=https://evil.example", "/account/security"],
    ["/?q=a&q=b", "/?q=a"],
    ["/?q=&tag=ai", "/?tag=ai"],
    ["/readings/rd_ONE#section", "/readings/rd_ONE"],
  ])("drops unknown parameters and fragments from %j", (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it.each([
    // Other hosts and schemes.
    "https://evil.example/readings/rd_ONE",
    "http://evil.example/",
    "//evil.example/readings/rd_ONE",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "mailto:reader@example.com",
    // Absolute URLs are refused even for this origin: return paths are paths.
    `${window.location.origin}/readings/rd_ONE`,
    // Paths outside the allowlist, and look-alikes.
    "",
    "   ",
    "readings/rd_ONE",
    "/login",
    "/login?next=/readings/rd_ONE",
    "/login/verify",
    "/auth/verify",
    "/api/whoami",
    "/readings",
    "/readings/",
    "/readings/rd_ONE/extra",
    "/readings/%2F%2Fevil.example",
    "/readings/rd_ONE@evil.example",
    "/account/security/extra",
    "/account",
    "/save/extra",
  ])("rejects %j", (raw) => {
    expect(safeReturnPath(raw)).toBeUndefined();
  });

  it("rejects null and undefined", () => {
    expect(safeReturnPath(null)).toBeUndefined();
    expect(safeReturnPath(undefined)).toBeUndefined();
  });
});

describe("return path storage", () => {
  it("remembers only a safe path, normalized", () => {
    rememberReturnPath("https://evil.example");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
    rememberReturnPath("/readings/rd_ONE?view=source&evil=1");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBe("/readings/rd_ONE?view=source");
    // localStorage, so the tab that opens the emailed link can find it.
    expect(sessionStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("clears an earlier path when a later request has no safe path", () => {
    rememberReturnPath("/readings/rd_ONE");
    rememberReturnPath(undefined);
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
    rememberReturnPath("/readings/rd_ONE");
    rememberReturnPath("//evil.example");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("consumes the stored path once", () => {
    rememberReturnPath("/readings/rd_ONE");
    expect(consumeReturnPath(null)).toBe("/readings/rd_ONE");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
    expect(consumeReturnPath(null)).toBe("/");
  });

  it("prefers a safe query path over the stored one, and clears storage either way", () => {
    rememberReturnPath("/readings/rd_STORED");
    expect(consumeReturnPath("/readings/rd_QUERY")).toBe("/readings/rd_QUERY");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("falls back to the stored path when the query path is unsafe", () => {
    rememberReturnPath("/save");
    expect(consumeReturnPath("https://evil.example")).toBe("/save");
  });

  it("never returns a tampered stored value", () => {
    localStorage.setItem(LOGIN_NEXT_STORAGE_KEY, "https://evil.example");
    expect(consumeReturnPath(undefined)).toBe("/");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("clears on request", () => {
    rememberReturnPath("/save");
    clearReturnPath();
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });
});

describe("loginHref", () => {
  it("carries the current URL as next", () => {
    expect(loginHref("/readings/rd_ONE?view=source")).toBe("/login?next=%2Freadings%2Frd_ONE%3Fview%3Dsource");
  });

  it("omits next for the library root and for paths that cannot be returned to", () => {
    expect(loginHref("/")).toBe("/login");
    expect(loginHref("/login?next=%2Fsave")).toBe("/login");
  });

  it("has a step-up link back to the account page", () => {
    expect(STEP_UP_LOGIN_HREF).toBe("/login?step_up=1&next=%2Faccount%2Fsecurity");
  });
});
