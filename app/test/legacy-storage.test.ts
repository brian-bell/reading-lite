import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_BEARER_TOKEN_KEY, dropLegacyBearerToken } from "../src/auth/legacy-storage";

afterEach(() => {
  localStorage.clear();
});

// AGENTS.md: keep removing the legacy SPA entry until the old SPA is retired.
// This frontend takes over the same origin, so it removes it too (#369 review).
describe("dropLegacyBearerToken", () => {
  it("removes the legacy SPA's bearer token and leaves other entries alone", () => {
    localStorage.setItem(LEGACY_BEARER_TOKEN_KEY, "bearer-from-the-old-spa");
    localStorage.setItem("reading-lite.loginNext", "/save");
    dropLegacyBearerToken();
    expect(localStorage.getItem(LEGACY_BEARER_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("reading-lite.loginNext")).toBe("/save");
  });

  it("is quiet when there is nothing to remove", () => {
    expect(() => dropLegacyBearerToken()).not.toThrow();
  });

  it("keeps the key the SPA uses", () => {
    expect(LEGACY_BEARER_TOKEN_KEY).toBe("reading-lite.bearerToken");
  });
});
