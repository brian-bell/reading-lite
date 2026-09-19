import { describe, expect, it } from "vitest";
import { tokenHeading, tokensFromResponse, tokenStatus, type TokenListItem } from "../src/tokens";

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
