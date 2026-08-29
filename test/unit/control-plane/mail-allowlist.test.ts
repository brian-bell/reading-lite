import { describe, expect, it } from "vitest";
import { isAuthMailAllowed } from "../../../src/control-plane/mail-allowlist";

describe("isAuthMailAllowed", () => {
  it("does not extra-restrict production", () => {
    expect(isAuthMailAllowed({ APP_ENV: "production" }, "anyone@example.com")).toBe(true);
  });

  it("treats an unset staging list with no founder as unrestricted", () => {
    expect(isAuthMailAllowed({ APP_ENV: "staging" }, "anyone@example.com")).toBe(true);
  });

  it("uses empty-string staging allowlist mode plus FOUNDER_EMAIL", () => {
    const env = { APP_ENV: "staging", AUTH_MAIL_ALLOWLIST: "", FOUNDER_EMAIL: "Founder@Example.com" };
    expect(isAuthMailAllowed(env, "founder@example.com")).toBe(true);
    expect(isAuthMailAllowed(env, "other@example.com")).toBe(false);
  });

  it("allows listed staging recipients", () => {
    const env = { APP_ENV: "staging", AUTH_MAIL_ALLOWLIST: "allowed@example.com" };
    expect(isAuthMailAllowed(env, "allowed@example.com")).toBe(true);
    expect(isAuthMailAllowed(env, "denied@example.com")).toBe(false);
  });
});
