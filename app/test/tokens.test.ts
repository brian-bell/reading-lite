import { describe, expect, it } from "vitest";
import {
  datetimeLocalValue,
  TOKEN_MAX_TTL_MS,
  tokenCreateFromResponse,
  tokenExpiryFrom,
  tokenHeading,
  tokenRevokeFromResponse,
  tokensFromResponse,
  tokenStatus,
  nextUsableTokenExpiryMs,
  usableTokenCount,
  withRevokedTokens,
  type TokenListItem,
} from "../src/tokens";

const token = (over: Partial<TokenListItem> = {}): TokenListItem => ({
  id: "tok_1",
  name: "CI",
  format: "standard",
  scopes: ["readings:read"],
  created_at_ms: 1,
  expires_at_ms: 4_102_444_800_000,
  revoked_at_ms: null,
  last_used_at_ms: null,
  usable: true,
  ...over,
});

describe("tokensFromResponse", () => {
  it("returns the list on 200", () => {
    const listed = { tokens: [token()] };
    expect(tokensFromResponse(200, listed)).toEqual({ state: "ready", value: listed });
  });

  it("maps 403 and 412 to their states rather than a throw", () => {
    expect(tokensFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(tokensFromResponse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" })).toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [503, { error: "control plane unavailable" }, "control plane unavailable"],
    [502, null, "tokens returned 502"],
    [200, { tokens: [{ id: "tok_1" }] }, "tokens returned an unexpected body"],
  ])("throws status %i with its message", (status, body, message) => {
    expect(() => tokensFromResponse(status, body)).toThrow(expect.objectContaining({ status, message }));
  });
});

describe("tokenCreateFromResponse", () => {
  it.each([
    [
      201,
      { token: "tok_1.abc", id: "tok_1", name: "CI", scopes: ["readings:read"], created_at_ms: 1, expires_at_ms: 2 },
      { kind: "created", id: "tok_1", name: "CI", secret: "tok_1.abc" },
    ],
    [400, { error: "invalid body" }, { kind: "invalid" }],
    [409, { error: "too many active tokens" }, { kind: "limit" }],
    [403, { error: "recent authentication required" }, { kind: "step-up" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i %j to an outcome", (status, body, outcome) => {
    expect(tokenCreateFromResponse(status, body)).toEqual(outcome);
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [503, null, "failed to create token"],
    [201, { id: "tok_1" }, "token create returned an unexpected body"],
  ])("throws %i", (status, body, message) => {
    expect(() => tokenCreateFromResponse(status, body)).toThrow(expect.objectContaining({ status, message }));
  });
});

describe("tokenExpiryFrom", () => {
  const now = Date.parse("2026-09-18T12:00:00");

  it.each([
    ["", { kind: "default" }],
    ["   ", { kind: "default" }],
    ["2026-09-19T12:00", { kind: "at", ms: Date.parse("2026-09-19T12:00") }],
    ["not a date", { kind: "invalid" }],
    ["2026-09-18T12:00", { kind: "past" }],
    ["2026-09-01T09:00", { kind: "past" }],
    [datetimeLocalValue(now + TOKEN_MAX_TTL_MS), { kind: "at", ms: now + TOKEN_MAX_TTL_MS }],
    [datetimeLocalValue(now + TOKEN_MAX_TTL_MS + 60_000), { kind: "too-far" }],
  ])("reads %j", (value, expiry) => {
    expect(tokenExpiryFrom(value, now)).toEqual(expiry);
  });

  it("writes a time the field reads back as the same minute", () => {
    const ms = Date.parse("2026-12-31T23:59");
    expect(datetimeLocalValue(ms)).toBe("2026-12-31T23:59");
  });
});

describe("tokenRevokeFromResponse", () => {
  it.each([
    [200, { ok: true }, { kind: "revoked" }],
    [404, { error: "not found" }, { kind: "gone" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i to an outcome", (status, body, outcome) => {
    expect(tokenRevokeFromResponse(status, body)).toEqual(outcome);
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [503, null, "failed to revoke token"],
  ])("throws %i", (status, body, message) => {
    expect(() => tokenRevokeFromResponse(status, body)).toThrow(expect.objectContaining({ status, message }));
  });
});

describe("withRevokedTokens", () => {
  it("shows the named usable tokens revoked and leaves the rest alone", () => {
    const listed = {
      tokens: [
        token({ id: "tok_a" }),
        token({ id: "tok_b" }),
        token({ id: "tok_c", usable: false, revoked_at_ms: 3 }),
      ],
    };

    const shown = withRevokedTokens(listed, new Set(["tok_a", "tok_c"]), 7);

    expect(shown.tokens.map((row) => [row.id, row.usable, row.revoked_at_ms])).toEqual([
      ["tok_a", false, 7],
      ["tok_b", true, null],
      ["tok_c", false, 3],
    ]);
  });

  it("treats a cached usable token as expired once now reaches expires_at_ms", () => {
    const listed = { tokens: [token({ expires_at_ms: 10 })] };

    expect(withRevokedTokens(listed, new Set(), 9).tokens[0]).toMatchObject({ usable: true, revoked_at_ms: null });
    expect(withRevokedTokens(listed, new Set(), 10).tokens[0]).toMatchObject({ usable: false, revoked_at_ms: null });
  });
});

describe("usableTokenCount", () => {
  it("counts only tokens that still work", () => {
    const listed = {
      tokens: [token(), token({ usable: false }), token({ usable: false, revoked_at_ms: 1 }), token()],
    };
    expect(usableTokenCount(listed)).toBe(2);
  });

  it("drops a token from the cap once the overlay marks it expired", () => {
    const listed = {
      tokens: [token({ expires_at_ms: 10 }), token({ id: "tok_2", expires_at_ms: 20 })],
    };
    expect(usableTokenCount(withRevokedTokens(listed, new Set(), 10))).toBe(1);
  });
});

describe("nextUsableTokenExpiryMs", () => {
  it("is the soonest expiry among tokens that still count toward the cap", () => {
    const listed = {
      tokens: [
        token({ id: "tok_later", expires_at_ms: 30 }),
        token({ id: "tok_soon", expires_at_ms: 10 }),
        token({ id: "tok_gone", usable: false, expires_at_ms: 5 }),
      ],
    };
    expect(nextUsableTokenExpiryMs(listed)).toBe(10);
    expect(nextUsableTokenExpiryMs(withRevokedTokens(listed, new Set(), 10))).toBe(30);
    expect(nextUsableTokenExpiryMs({ tokens: [] })).toBeUndefined();
  });
});

describe("tokenStatus", () => {
  it.each([
    ["usable", token()],
    ["expired", token({ usable: false })],
    ["revoked", token({ usable: false, revoked_at_ms: 5 })],
  ])("is %s", (status, row) => {
    expect(tokenStatus(row)).toBe(status);
  });

  it("puts the status in the heading after the name and format", () => {
    expect(tokenHeading(token({ name: "Laptop", format: "legacy" }))).toBe("Laptop (legacy) · usable");
  });
});
