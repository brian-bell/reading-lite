import { describe, expect, it } from "vitest";
import { parseTokenId, parseUserId } from "../../../src/control-plane/ids";
import {
  API_SCOPES,
  createApiTokenPrincipal,
  createSessionPrincipal,
  principalHasScope,
} from "../../../src/control-plane/principal";

const USER = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!;
const OTHER = parseUserId("usr_11111111-1111-4111-8111-111111111111")!;
const TOKEN = parseTokenId("tok_550e8400-e29b-41d4-a716-446655440000")!;

describe("AuthenticatedPrincipal", () => {
  it("constructs an api_token principal when tenantId equals userId", () => {
    const principal = createApiTokenPrincipal({
      tenantId: USER,
      userId: USER,
      tokenId: TOKEN,
      scopes: [...API_SCOPES],
    });
    expect(principal).toEqual({
      kind: "api_token",
      tenantId: USER,
      userId: USER,
      tokenId: TOKEN,
      scopes: new Set(API_SCOPES),
    });
    expect(principal.scopes).toBeInstanceOf(Set);
  });

  it("constructs a session principal when tenantId equals userId", () => {
    const principal = createSessionPrincipal({
      tenantId: USER,
      userId: USER,
      sessionId: "ses_550e8400-e29b-41d4-a716-446655440000",
      authenticatedAtMs: 1_700_000_000_000,
    });
    expect(principal.kind).toBe("session");
    expect(principal.tenantId).toBe(USER);
    expect(principal.userId).toBe(USER);
  });

  it("rejects tenantId !== userId at construction", () => {
    expect(() =>
      createApiTokenPrincipal({
        tenantId: USER,
        userId: OTHER,
        tokenId: TOKEN,
        scopes: ["readings:read"],
      }),
    ).toThrow(/tenantId === userId/);
    expect(() =>
      createSessionPrincipal({
        tenantId: USER,
        userId: OTHER,
        sessionId: "ses_550e8400-e29b-41d4-a716-446655440000",
        authenticatedAtMs: 1,
      }),
    ).toThrow(/tenantId === userId/);
  });

  it("rejects malformed IDs at construction", () => {
    expect(() =>
      createApiTokenPrincipal({
        tenantId: "not-an-id",
        userId: USER,
        tokenId: TOKEN,
        scopes: ["readings:read"],
      }),
    ).toThrow(/malformed/);
  });

  it("rejects unknown scopes", () => {
    expect(() =>
      createApiTokenPrincipal({
        tenantId: USER,
        userId: USER,
        tokenId: TOKEN,
        scopes: ["readings:read", "admin:*"],
      }),
    ).toThrow(/scope/);
  });

  it("treats sessions as having every API scope", () => {
    const principal = createSessionPrincipal({
      tenantId: USER,
      userId: USER,
      sessionId: "ses_550e8400-e29b-41d4-a716-446655440000",
      authenticatedAtMs: 1,
    });
    for (const scope of API_SCOPES) {
      expect(principalHasScope(principal, scope)).toBe(true);
    }
  });

  it("checks exact scopes on api_token principals", () => {
    const principal = createApiTokenPrincipal({
      tenantId: USER,
      userId: USER,
      tokenId: TOKEN,
      scopes: ["readings:read"],
    });
    expect(principalHasScope(principal, "readings:read")).toBe(true);
    expect(principalHasScope(principal, "readings:write")).toBe(false);
    expect(principalHasScope(principal, "readings:import")).toBe(false);
  });
});
