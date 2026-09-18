import { describe, expect, it } from "vitest";
import { isPublicLegalPath, PUBLIC_LEGAL_PATHS } from "../src/legal";
import { LEGAL_PATHS } from "../src/legal-copy";

describe("isPublicLegalPath", () => {
  it("names the three public legal routes", () => {
    expect(PUBLIC_LEGAL_PATHS).toEqual([LEGAL_PATHS.terms, LEGAL_PATHS.privacy, LEGAL_PATHS.dmca]);
  });

  it.each(["/terms", "/privacy", "/dmca"])("accepts %s", (path) => {
    expect(isPublicLegalPath(path)).toBe(true);
  });

  it.each(["/", "/login", "/save", "/terms/", "/term", "/privacy-policy"])("rejects %s", (path) => {
    expect(isPublicLegalPath(path)).toBe(false);
  });
});
