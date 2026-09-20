// Slice 1a's end-to-end proof in place of router wiring (ADR 0005): the local
// fixture pack is seeded into R2 and into PostgreSQL through the shared
// mapping, and the old and new stores must agree. It fails if the pack drifts
// from what the rows can carry.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSeedRows } from "../../../scripts/pg-lib/local-seed-rows";
import { writeReadingRows } from "../../../scripts/pg-lib/manifest-rows";
import type { Sql } from "../../../src/modules/db/sql";
import { projectRelationshipTargets, relationshipTargetIds } from "../../../src/modules/relationship-targets";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import { PgReadingStore, pgReadingStoreFor } from "../../../src/modules/stores/postgres/reading-store";
import { pgSimilarityStoreFor } from "../../../src/modules/stores/postgres/similarity-store";
import { ReadingStore } from "../../../src/modules/stores/reading-store";
import { sha256Hex } from "../../../src/services";
import { buildLocalSeed } from "../../fixtures/local-seed";
import { mintTenant, testSql } from "../../helpers/pg-fixtures";

const NOW = "2026-09-19T12:00:00.000Z";
const plan = buildLocalSeed(NOW);
const tenant = await mintTenant();
const rows = localSeedRows(plan, String(tenant.tenantId));

let sql: Sql;
let r2: ReadingStore;
let postgres: PgReadingStore;

// The pack sits at the global root, as it does in local dev. Isolated storage
// resets R2 per test, so it is written in beforeAll and only ever read.
beforeAll(async () => {
  for (const object of plan.objects) {
    await env.READINGS_BUCKET.put(object.key, object.body, { httpMetadata: { contentType: object.contentType } });
  }
  sql = testSql();
  await sql.transaction(async (tx) => {
    for (const reading of rows) await writeReadingRows(tx, reading);
  });
  r2 = new ReadingStore(env.READINGS_BUCKET);
  postgres = pgReadingStoreFor(sql, tenant);
});
afterAll(() => sql.end());

const ready = plan.fixtures.filter((fixture) => fixture.manifest.status === "ready");
const someTag = ready.find((fixture) => (fixture.manifest.tags ?? []).length > 0)!.manifest.tags![0]!;
const someKeyword = ready.find((fixture) => (fixture.manifest.keywords ?? []).length > 0)!.manifest.keywords![0]!;

describe("fixture pack parity: R2 stores vs PostgreSQL stores", () => {
  it("maps every fixture without dropping anything", () => {
    expect(rows.flatMap((reading) => reading.notes.map((note) => `${reading.reading.id}: ${note}`))).toEqual([]);
  });

  it.each([
    ["the whole library", { offset: 0, limit: 100 }],
    ["a middle page", { offset: 3, limit: 4 }],
    ["a page past the end", { offset: 500, limit: 10 }],
    ["a keyword, upper-cased", { q: someKeyword.toUpperCase(), offset: 0, limit: 100 }],
    ["a host substring", { q: "example/", offset: 0, limit: 100 }],
    ["a query that matches nothing", { q: "zzz-no-such-text", offset: 0, limit: 100 }],
    ["a tag, upper-cased", { tag: someTag.toUpperCase(), offset: 0, limit: 100 }],
    ["a tag and a query together", { tag: someTag, q: "e", offset: 0, limit: 2 }],
  ])("lists %s identically", async (_label, params) => {
    const expected = await r2.listManifests(params);
    expect(await postgres.listManifests(params)).toEqual(expected);
    if (!("q" in params && params.q.startsWith("zzz")) && params.offset === 0) {
      expect(expected.readings.length).toBeGreaterThan(0);
    }
  });

  it.each(plan.fixtures.map((fixture) => [fixture.name, fixture.id]))("loads %s identically", async (_name, id) => {
    const expected = await r2.loadReadingById(id);
    expect(expected).not.toBeNull();
    expect(await postgres.loadReadingById(id)).toEqual(expected);
  });

  it("resolves relationship targets identically, removed target included", async () => {
    const index = await r2.readListIndex();
    const ids = [...new Set(ready.flatMap((fixture) => relationshipTargetIds(fixture.manifest)))];
    expect(ids).toContain(plan.removedTargetId);
    const expected = projectRelationshipTargets(ids, index, 900, NOW);
    const items = await postgres.relationshipTargets(ids);
    expect(projectRelationshipTargets(ids, { version: 1, items }, 900, NOW)).toEqual(expected);
  });

  it("resolves URL ownership identically", async () => {
    // R2's read-only owner resolution: the by-url pointer, honoured only when
    // the manifest it names really is that URL's reading.
    const r2Owner = async (url: string): Promise<string | null> => {
      const pointer = await r2.readByUrlPointer(await sha256Hex(url));
      if (!pointer) return null;
      const manifest = await r2.readManifest(pointer.key_prefix);
      return manifest?.id === pointer.id && manifest.url === url ? pointer.id : null;
    };
    const urls = [...plan.fixtures.map((fixture) => fixture.manifest.url), "https://unclaimed.example/nothing-here"];
    for (const url of urls) {
      expect((await postgres.findOwnerByUrl(url))?.id ?? null, url).toBe(await r2Owner(url));
    }
  });

  it("serves content through the keys PostgreSQL hands out", async () => {
    // head only: an unread R2 body breaks the pool's isolated-storage pop.
    const layout = r2KeyLayout("");
    let served = 0;
    for (const fixture of plan.fixtures) {
      const keys = (await postgres.contentKeys(fixture.id))!;
      const listed = (await r2.listReadingObjects(fixture.keyPrefix)).map((object) => object.key);
      if (listed.includes(layout.extractedKey(fixture.keyPrefix))) {
        expect(keys.extractedKey, fixture.name).toBe(layout.extractedKey(fixture.keyPrefix));
        served++;
      }
      const raw = listed.find((key) => key.includes("/raw."));
      if (raw !== undefined) expect(keys.rawKey, fixture.name).toBe(raw);
    }
    expect(served).toBeGreaterThan(0);
  });

  it("finds every other ready fixture as a neighbour, nearest first, and nothing unready", async () => {
    const similarity = pgSimilarityStoreFor(sql, tenant);
    const matches = (await similarity.queryByVectorId(ready[0]!.id, 50))!;
    expect(matches[0]!.id).toBe(ready[0]!.id);
    expect(matches.map((match) => match.id).sort()).toEqual(ready.map((fixture) => fixture.id).sort());
    const scores = matches.map((match) => match.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
