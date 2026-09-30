import { describe, expect, it } from "vitest";
import { isPublicPath } from "../src/public-paths";

// Pages whose server render carries no identity and may be cached (ADR 0003).
describe("isPublicPath", () => {
  it.each(["/terms", "/privacy", "/dmca", "/samples", "/samples/", "/samples/a-quieter-internet"])("accepts %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each(["/", "/login", "/save", "/readings/rd_1", "/sample", "/samplesx", "/samples-a", "/account/security"])(
    "rejects %s",
    (path) => {
      expect(isPublicPath(path)).toBe(false);
    },
  );
});
