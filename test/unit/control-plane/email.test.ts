import { describe, expect, it } from "vitest";
import { canonicalizeEmail, redactEmail, redactEmailsInText } from "../../../src/control-plane/email";

describe("canonicalizeEmail", () => {
  it("trims and lowercases the complete address", () => {
    expect(canonicalizeEmail("  Founder@Example.COM ")).toBe("founder@example.com");
  });

  it("does not strip dots or plus tags", () => {
    expect(canonicalizeEmail("first.last+tag@example.com")).toBe("first.last+tag@example.com");
  });

  it("rejects empty addresses", () => {
    expect(() => canonicalizeEmail("")).toThrow(/email/);
    expect(() => canonicalizeEmail("   ")).toThrow(/email/);
  });
});

describe("redactEmail", () => {
  it("keeps the first local character and the domain", () => {
    expect(redactEmail("  Founder@Example.COM ")).toBe("f***@example.com");
  });
});

describe("redactEmailsInText", () => {
  it("redacts mailbox addresses and leaves the rest", () => {
    expect(redactEmailsInText("Invalid `to`: Founder@Example.COM")).toBe("Invalid `to`: f***@example.com");
    expect(redactEmailsInText("no address here")).toBe("no address here");
  });
});
