import { describe, expect, it } from "vitest";
import {
  cookieCsrfRequired,
  mintCsrfToken,
  verifyCsrfToken,
} from "../../../src/control-plane/csrf";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../../src/control-plane/crypto";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_HEX = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };
const previousAuthRoot = { secret: parseAuthRootSecret(OTHER_HEX), version: 0 };
const SESSION_A = "ses_550e8400-e29b-41d4-a716-446655440000";
const SESSION_B = "ses_11111111-1111-4111-8111-111111111111";

describe("cookieCsrfRequired", () => {
  it("applies only to cookie POST/DELETE", () => {
    expect(cookieCsrfRequired("POST")).toBe(true);
    expect(cookieCsrfRequired("DELETE")).toBe(true);
    expect(cookieCsrfRequired("delete")).toBe(true);
    expect(cookieCsrfRequired("GET")).toBe(false);
    expect(cookieCsrfRequired("HEAD")).toBe(false);
    expect(cookieCsrfRequired("OPTIONS")).toBe(false);
    expect(cookieCsrfRequired("PUT")).toBe(false);
  });
});

describe("csrf HMAC", () => {
  it("mints a 256-bit hex HMAC over the session id and verifies it", async () => {
    const token = await mintCsrfToken(authRoot, SESSION_A);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await verifyCsrfToken({ token, sessionId: SESSION_A, authRoot }),
    ).toBe(true);
  });

  it("is domain-separated from the session HMAC key", async () => {
    const csrfMac = await mintCsrfToken(authRoot, SESSION_A);
    const sessionMac = await hmacHex(await deriveHmacKey(authRoot, "session"), SESSION_A);
    expect(csrfMac).not.toBe(sessionMac);
  });

  it("rejects a missing, malformed, or wrong token", async () => {
    const token = await mintCsrfToken(authRoot, SESSION_A);
    expect(await verifyCsrfToken({ token: undefined, sessionId: SESSION_A, authRoot })).toBe(false);
    expect(await verifyCsrfToken({ token: "", sessionId: SESSION_A, authRoot })).toBe(false);
    expect(await verifyCsrfToken({ token: "not-hex", sessionId: SESSION_A, authRoot })).toBe(false);
    expect(await verifyCsrfToken({ token: "0".repeat(64), sessionId: SESSION_A, authRoot })).toBe(false);
    expect(await verifyCsrfToken({ token, sessionId: SESSION_B, authRoot })).toBe(false);
  });

  it("rejects a token minted for a different session", async () => {
    const other = await mintCsrfToken(authRoot, SESSION_B);
    expect(await verifyCsrfToken({ token: other, sessionId: SESSION_A, authRoot })).toBe(false);
  });

  it("accepts a token minted under the previous auth root during rotation", async () => {
    const previousToken = await mintCsrfToken(previousAuthRoot, SESSION_A);
    expect(
      await verifyCsrfToken({
        token: previousToken,
        sessionId: SESSION_A,
        authRoot,
        previousAuthRoot,
      }),
    ).toBe(true);
    expect(
      await verifyCsrfToken({
        token: previousToken,
        sessionId: SESSION_A,
        authRoot,
      }),
    ).toBe(false);
  });
});
