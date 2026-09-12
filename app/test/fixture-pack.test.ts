import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };

// The fixture pack snapshot e2e/backend-stub.js serves. It is generated at the
// repo root (`npm run fixtures:app`) from test/fixtures/local-seed.ts, where a
// root test guards it against drift; this one keeps the app's own CI honest
// about the file being present and usable.

describe("fixture pack snapshot", () => {
  it("has a reading-detail body for every named state", () => {
    expect(pack.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack.fixtures) {
      const body = pack.readings[fixture.id as keyof typeof pack.readings];
      expect(body, fixture.name).toBeDefined();
      expect(body.id).toBe(fixture.id);
    }
  });

  it("carries the clock the browser suite pins", () => {
    expect(Number.isFinite(Date.parse(pack.generated_at))).toBe(true);
  });

  it("keeps the removed relationship target out of the pack", () => {
    expect(pack.readings[pack.removed_target_id as keyof typeof pack.readings]).toBeUndefined();
  });
});
