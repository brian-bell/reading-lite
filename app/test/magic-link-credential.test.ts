import { describe, expect, it } from "vitest";

import { captureMagicLinkCredential, clearMagicLinkCredential } from "../src/auth/magic-link-credential";

describe("captureMagicLinkCredential", () => {
  it("keeps a captured fragment after a later empty hash", () => {
    clearMagicLinkCredential();
    expect(captureMagicLinkCredential("#ml_secret")).toBe("ml_secret");
    expect(captureMagicLinkCredential("")).toBe("ml_secret");
    expect(captureMagicLinkCredential("#")).toBe("ml_secret");
    clearMagicLinkCredential();
    expect(captureMagicLinkCredential("")).toBe("");
  });
});
