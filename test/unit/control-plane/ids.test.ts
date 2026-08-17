import { describe, expect, it } from "vitest";
import {
  mintTokenId,
  mintUserId,
  parseSessionId,
  parseTenantId,
  parseTokenId,
  parseUserId,
} from "../../../src/control-plane/ids";

const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";

describe("control-plane IDs", () => {
  it("parses prefixed UUIDv4 user and tenant IDs", () => {
    expect(parseUserId(USER)).toBe(USER);
    expect(parseTenantId(USER)).toBe(USER);
  });

  it("parses prefixed UUIDv4 token and session IDs", () => {
    expect(parseTokenId(TOKEN)).toBe(TOKEN);
    expect(parseSessionId(SESSION)).toBe(SESSION);
    expect(parseSessionId(TOKEN)).toBeNull();
  });

  it("canonicalizes uppercase hex to lowercase", () => {
    expect(parseUserId(USER.toUpperCase())).toBe(USER);
  });

  it("rejects malformed, wrong-prefix, and non-UUIDv4 IDs", () => {
    const bad = [
      "",
      "usr_",
      "usr_not-a-uuid",
      "tok_550e8400-e29b-41d4-a716-446655440000",
      "usr_550e8400-e29b-41d4-a716-446655440000/../x",
      "usr_550e8400e29b41d4a716446655440000",
      "550e8400-e29b-41d4-a716-446655440000",
      "usr_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
      "usr_550e8400-e29b-11d4-a716-446655440000",
    ];
    for (const value of bad) {
      expect(parseUserId(value)).toBeNull();
      expect(parseTenantId(value)).toBeNull();
    }
    expect(parseTokenId(USER)).toBeNull();
    expect(parseTokenId("tok_not-a-uuid")).toBeNull();
    expect(parseSessionId(USER)).toBeNull();
  });

  it("mints user and token IDs that parse", () => {
    const userId = mintUserId(() => "550e8400-e29b-41d4-a716-446655440000");
    const tokenId = mintTokenId(() => "550e8400-e29b-41d4-a716-446655440000");
    expect(userId).toBe(USER);
    expect(tokenId).toBe(TOKEN);
  });
});
