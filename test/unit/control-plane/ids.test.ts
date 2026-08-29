import { describe, expect, it } from "vitest";
import {
  mintChallengeId,
  mintSessionId,
  mintTokenId,
  mintUserId,
  parseChallengeId,
  parseSessionId,
  parseTenantId,
  parseTokenId,
  parseUserId,
} from "../../../src/control-plane/ids";

const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";
const CHALLENGE = "ml_550e8400-e29b-41d4-a716-446655440000";

describe("control-plane IDs", () => {
  it("parses prefixed UUIDv4 user and tenant IDs", () => {
    expect(parseUserId(USER)).toBe(USER);
    expect(parseTenantId(USER)).toBe(USER);
  });

  it("parses prefixed UUIDv4 token and session IDs", () => {
    expect(parseTokenId(TOKEN)).toBe(TOKEN);
    expect(parseSessionId(SESSION)).toBe(SESSION);
    expect(parseChallengeId(CHALLENGE)).toBe(CHALLENGE);
    expect(parseSessionId(TOKEN)).toBeNull();
    expect(parseChallengeId(SESSION)).toBeNull();
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

  it("mints user, token, session, and challenge IDs that parse", () => {
    const uuid = () => "550e8400-e29b-41d4-a716-446655440000";
    expect(mintUserId(uuid)).toBe(USER);
    expect(mintTokenId(uuid)).toBe(TOKEN);
    expect(mintSessionId(uuid)).toBe(SESSION);
    expect(mintChallengeId(uuid)).toBe(CHALLENGE);
  });
});
