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
  APP_SAMPLE_FIXTURES,
  APP_SAMPLE_LIBRARY_PATH,
  buildAppSampleLibrary,
  serializeAppSampleLibrary,
} from "../../fixtures/app-sample-library";
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
      // Every seeded reading owns its URL, so the by-url check names the
      // reading itself, as the router's owner lookup would.
      expect(body.pointers.by_url).toMatchObject({ exists: true, matches_manifest: true });
      expect(body.pointers.by_url.pointer).toEqual({ id: fixture.id, key_prefix: body.key_prefix });
      // Objects are captured content, which only a ready reading has.
      expect(body.objects.length > 0, fixture.name).toBe(fixture.status === "ready");
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

// The public sample library app/ bundles (reading-lite-gh341.10), projected
// from the same pack. Its relationships must stay inside the set, since a
// sample page can only lead to another sample.
describe("app sample library", () => {
  it("matches the projection of the local fixture pack", () => {
    const committedSamples = readFileSync(path.join(repoRoot, APP_SAMPLE_LIBRARY_PATH), "utf8");
    expect(committedSamples, `stale ${APP_SAMPLE_LIBRARY_PATH}; run \`${APP_FIXTURE_PACK_COMMAND}\``).toBe(
      serializeAppSampleLibrary(buildAppSampleLibrary()),
    );
  });

  it("addresses every chosen fixture by a distinct slug, and relates only to other samples", () => {
    const { readings } = buildAppSampleLibrary();
    expect(readings).toHaveLength(APP_SAMPLE_FIXTURES.length);
    const slugs = new Set(readings.map((reading) => reading.id));
    expect(slugs.size).toBe(readings.length);
    for (const reading of readings) {
      expect(reading.id).toMatch(/^[a-z0-9-]+$/);
      const related = [...(reading.connections ?? []), ...(reading.tensions ?? [])].map((r) => r.id);
      for (const id of related) expect(slugs.has(id), `${reading.id} -> ${id}`).toBe(true);
      expect(Object.keys(reading.relationship_targets).sort()).toEqual([...new Set(related)].sort());
    }
  });

  it("shows at least one connection and one tension, and carries nothing an operator reads", () => {
    const { readings } = buildAppSampleLibrary();
    expect(readings.some((reading) => (reading.connections?.length ?? 0) > 0)).toBe(true);
    expect(readings.some((reading) => (reading.tensions?.length ?? 0) > 0)).toBe(true);
    for (const reading of readings) {
      for (const key of ["usage", "last_attempt", "active_attempt", "url_hash", "content_sha256", "created_at"]) {
        expect(reading, `${reading.id}.${key}`).not.toHaveProperty(key);
      }
    }
  });
});
