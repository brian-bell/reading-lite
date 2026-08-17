import { describe, expect, it } from "vitest";
import { parsePresentedToken } from "../../../src/control-plane/bearer";

describe("parsePresentedToken", () => {
  it("treats a no-selector secret as legacy", () => {
    expect(parsePresentedToken("test-token")).toEqual({
      format: "legacy",
      secret: "test-token",
    });
  });

  it("parses selector.secret as the standard format", () => {
    expect(
      parsePresentedToken("tok_550e8400-e29b-41d4-a716-446655440000.secret-material"),
    ).toEqual({
      format: "standard",
      selector: "tok_550e8400-e29b-41d4-a716-446655440000",
      secret: "secret-material",
    });
  });

  it("rejects empty or whitespace-only bearers", () => {
    expect(parsePresentedToken("")).toBeNull();
    expect(parsePresentedToken("   ")).toBeNull();
  });

  it("does not treat a malformed selector as standard", () => {
    expect(parsePresentedToken("tok_not-a-uuid.secret")).toEqual({
      format: "legacy",
      secret: "tok_not-a-uuid.secret",
    });
  });
});
