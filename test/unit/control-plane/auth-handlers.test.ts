import { describe, expect, it } from "vitest";
import { rememberMailSentMarker } from "../../../src/control-plane/auth-handlers";

describe("rememberMailSentMarker", () => {
  it("retries once after the first write throws", async () => {
    let attempts = 0;
    await rememberMailSentMarker(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("d1 blip");
    });
    expect(attempts).toBe(2);
  });

  it("swallows a second failure so callers do not restore", async () => {
    let attempts = 0;
    await rememberMailSentMarker(async () => {
      attempts += 1;
      throw new Error("d1 down");
    });
    expect(attempts).toBe(2);
  });
});
