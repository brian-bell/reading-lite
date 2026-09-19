import { describe, expect, it } from "vitest";
import {
  tokenHeading,
  tokenRevokeFromResponse,
  tokensFromResponse,
  tokenStatus,
  withRevokedTokens,
  type TokenListItem,
} from "../src/tokens";

const token = (over: Partial<TokenListItem> = {}): TokenListItem => ({
  id: "tok_1",
  name: "CI",
  format: "standard",
  scopes: ["readings:read"],
  created_at_ms: 1,
  expires_at_ms: 2,
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
