import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_FIXTURE_PACK_COMMAND,
  APP_FIXTURE_PACK_PATH,
  buildAppFixturePack,
  serializeAppFixturePack,
} from "../../fixtures/app-fixture-pack";
import {
  GetReadingDiagnosticsResponseSchema,
  GetReadingResponseSchema,
  ListIndexItemSchema,
} from "../../../src/schemas/api";
import { ARCHIVE_ROW_COUNT, libraryItems } from "../../../app/e2e/library-page.js";

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
      "reprocess-failed",
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

  // Details (#373): diagnostics and the raw capture are served in the browser
  // from the pack, so each fixture carries what the backend's endpoints would
  // answer, projected through the backend's own response schema.
  it("serves a diagnostics body for every fixture, shaped like the endpoint's", () => {
    const pack = buildAppFixturePack();
    for (const fixture of pack.fixtures) {
      const body = GetReadingDiagnosticsResponseSchema.parse(pack.diagnostics[fixture.id]);
      expect(body.id, fixture.name).toBe(fixture.id);
      expect(body.manifest.status).toBe(fixture.status);
      // Computed from the seed's pointer objects the way the router computes
      // them; every seeded reading owns its own pointers.
      expect(body.pointers.by_id).toMatchObject({ exists: true, matches_manifest: true });
      expect(body.pointers.by_url).toMatchObject({ exists: true, matches_manifest: true });
      expect(body.pointers.by_url.pointer).toEqual({ id: fixture.id, key_prefix: body.key_prefix });
      expect(body.objects.length, fixture.name).toBeGreaterThan(0);
      expect(body.attempts.length, fixture.name).toBeGreaterThan(0);
      for (const object of body.objects) expect(object.key.startsWith(`${body.key_prefix}/`)).toBe(true);
    }
  });

  // The endpoint's final sort; its 20-attempt shortlist is not modelled.
  it("lists attempts newest first by started_at", () => {
    const pack = buildAppFixturePack();
    for (const body of Object.values(pack.diagnostics)) {
      const starts = body.attempts.map((a) => a.started_at);
      expect(starts).toEqual([...starts].sort().reverse());
    }
  });

  // The library's "Reprocess failed" badge (#415) reads the list row; the
  // Details section reads both attempts.
  it("serves the failed reprocess as a ready row with a failed reprocess attempt, and both its logs", () => {
    const pack = buildAppFixturePack();
    const fixture = pack.fixtures.find((f) => f.name === "reprocess-failed")!;
    expect(fixture.status).toBe("ready");
    const row = pack.list_index.items.find((item) => item.id === fixture.id)!;
    expect(row.error).toBeUndefined();
    expect(row.last_attempt).toMatchObject({ trigger: "reprocess", status: "failed" });
    expect(pack.diagnostics[fixture.id].attempts.map((a) => a.trigger)).toEqual(["reprocess", "submit"]);
  });

  it("serves each ready fixture's raw capture with its stored content type, and none for the rest", () => {
    const pack = buildAppFixturePack();
    for (const fixture of pack.fixtures) {
      const raw = pack.raws[fixture.id];
      if (fixture.status === "ready") {
        expect(raw, fixture.name).toBeDefined();
        expect(raw.content_type).toBe(pack.readings[fixture.id].content_type);
      } else {
        // The seed writes no capture for a pending or failed reading; the
        // endpoint 404s, and so does the browser stub.
        expect(raw, fixture.name).toBeUndefined();
      }
    }
    expect(pack.raws.rd_FXMDPAGE01.content_type).toMatch(/^text\/markdown/);
  });

  // Pages (#414): the browser-evidence stub serves the pack's list rows plus
  // generated ones, so every row it pages, generated or not, must be a row
  // the list endpoint could answer.
  it("generates library rows past the pack's that the list schema accepts", () => {
    const pack = buildAppFixturePack();
    const items = ListIndexItemSchema.array().parse(libraryItems(pack.list_index.items));
    expect(items).toHaveLength(pack.list_index.items.length + ARCHIVE_ROW_COUNT);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("omits the removed relationship target from the resolved targets", () => {
    const pack = buildAppFixturePack();
    const attention = pack.fixtures.find((f) => f.name === "attention");
    const body = pack.readings[attention!.id];
    expect(body.connections?.some((c) => c.id === pack.removed_target_id)).toBe(true);
    expect(body.relationship_targets[pack.removed_target_id]).toBeUndefined();
  });
});
