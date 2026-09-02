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

  it("redacts every shape canonicalizeEmail accepts so they never appear in error strings", () => {
    const shapes = [
      "first/last@example.com",
      '"Foo Bar"@example.com',
      "user@exämple.com",
      "user@localhost",
      "a @ b",
    ];
    for (const address of shapes) {
      expect(() => canonicalizeEmail(address)).not.toThrow();
      const redacted = redactEmailsInText(`Invalid to: ${address}`);
      expect(redacted).not.toContain(address);
      expect(redacted).not.toContain(address.toLowerCase());
    }
  });

  it("redacts unquoted interior whitespace in free text without a known-recipient list", () => {
    const address = "a @ b";
    expect(() => canonicalizeEmail(address)).not.toThrow();
    const redacted = redactEmailsInText(`Resend: ${address}`);
    expect(redacted).not.toContain(address);
  });

  it("redacts EMAIL_FROM when it is passed as a known address", () => {
    const from = "Noreply @ Reading.test";
    const redacted = redactEmailsInText(`Invalid from: ${from}`, [from]);
    expect(redacted).not.toContain(from);
    expect(redacted).not.toContain(from.toLowerCase());
  });
});
