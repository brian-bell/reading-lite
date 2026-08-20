import { describe, expect, it } from "vitest";
import {
  deriveHmacKey,
  hmacHex,
  parseAuthRootKeyVersion,
  parseAuthRootSecret,
  timingSafeEqualHex,
} from "../../../src/control-plane/crypto";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("auth crypto", () => {
  it("parses a 256-bit hex root secret and rejects shorter values", () => {
    const secret = parseAuthRootSecret(ROOT_HEX);
    expect(secret.byteLength).toBe(32);
    expect(() => parseAuthRootSecret("abcd")).toThrow(/256-bit/);
    expect(() => parseAuthRootSecret("")).toThrow(/256-bit/);
  });

  it("defaults auth-root key versions to 1 when unset", () => {
    expect(parseAuthRootKeyVersion(undefined)).toBe(1);
    expect(parseAuthRootKeyVersion("")).toBe(1);
    expect(parseAuthRootKeyVersion("2")).toBe(2);
    expect(parseAuthRootKeyVersion("0")).toBe(0);
    expect(() => parseAuthRootKeyVersion("1.5")).toThrow(/non-negative integer/);
    expect(() => parseAuthRootKeyVersion("-1")).toThrow(/non-negative integer/);
  });

  it("derives domain-separated HMAC keys from the same root", async () => {
    const root = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };
    const tokenKey = await deriveHmacKey(root, "api_token");
    const sessionKey = await deriveHmacKey(root, "session");
    const tokenMac = await hmacHex(tokenKey, "test-token");
    const sessionMac = await hmacHex(sessionKey, "test-token");
    expect(tokenMac).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionMac).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMac).not.toBe(sessionMac);
  });

  it("HMACs the complete legacy bearer value deterministically", async () => {
    const root = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };
    const key = await deriveHmacKey(root, "api_token");
    const a = await hmacHex(key, "test-token");
    const b = await hmacHex(key, "test-token");
    const other = await hmacHex(key, "wrong");
    expect(a).toBe(b);
    expect(timingSafeEqualHex(a, b)).toBe(true);
    expect(timingSafeEqualHex(a, other)).toBe(false);
  });

  it("compares HMAC hex in constant time and rejects length mismatch", () => {
    expect(timingSafeEqualHex("aa", "aa")).toBe(true);
    expect(timingSafeEqualHex("aa", "ab")).toBe(false);
    expect(timingSafeEqualHex("aa", "aaaa")).toBe(false);
  });
});
