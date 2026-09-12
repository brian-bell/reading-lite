import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_FIXTURE_PACK_COMMAND,
  APP_FIXTURE_PACK_PATH,
  buildAppFixturePack,
  serializeAppFixturePack,
} from "../../fixtures/app-fixture-pack";
import { GetReadingResponseSchema } from "../../../src/schemas/api";

// The committed snapshot app/'s browser-evidence suite serves. It is generated,
// so this test is the drift guard: edit test/fixtures/local-seed.ts, run the
// regenerate command, commit both.

const repoRoot = path.join(import.meta.dirname, "..", "..", "..");
const committed = readFileSync(path.join(repoRoot, APP_FIXTURE_PACK_PATH), "utf8");

describe("app browser-evidence fixture pack", () => {
  it("matches the projection of the local fixture pack", () => {
    expect(committed, `stale ${APP_FIXTURE_PACK_PATH}; run \`${APP_FIXTURE_PACK_COMMAND}\``).toBe(
      serializeAppFixturePack(buildAppFixturePack()),
    );
  });

  it("serves every named state as a reading-detail body", () => {
    const pack = buildAppFixturePack();
    expect(pack.fixtures.length).toBeGreaterThan(0);
    for (const fixture of pack.fixtures) {
      const body = pack.readings[fixture.id];
      expect(body, fixture.name).toBeDefined();
      expect(GetReadingResponseSchema.parse(body).id).toBe(fixture.id);
      expect(body.status).toBe(fixture.status);
    }
  });

  it("names the states the acceptance matrix relies on", () => {
    const names = new Set(buildAppFixturePack().fixtures.map((f) => f.name));
    for (const name of [
      "attention",
      "gardens",
      "sparse-archive",
      "unavailable-source",
      "degraded-youtube",
      "old-manifest",
      "long-title",
      "imported-markdown",
      "pending",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("keeps the pending fixture pending at the pinned clock", () => {
    const pack = buildAppFixturePack();
    const pending = pack.fixtures.find((f) => f.name === "pending");
    expect(pending?.status).toBe("pending");
  });

  it("omits the removed relationship target from the resolved targets", () => {
    const pack = buildAppFixturePack();
    const attention = pack.fixtures.find((f) => f.name === "attention");
    const body = pack.readings[attention!.id];
    expect(body.connections?.some((c) => c.id === pack.removed_target_id)).toBe(true);
    expect(body.relationship_targets[pack.removed_target_id]).toBeUndefined();
  });
});
