// The local fixture pack as seed:local writes it to PostgreSQL: every fixture,
// read back through the runtime stores, is the reading, list row, URL owner,
// content keys and attempt log the pack describes. It fails if the pack drifts
// from what the rows can carry.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSeedAttempts, localSeedRows } from "../../../scripts/pg-lib/local-seed-rows";
import { upsertAttempt, writeReadingRows } from "../../../scripts/pg-lib/manifest-rows";
import type { Sql } from "../../../src/modules/db/sql";
import { projectRelationshipTargets, relationshipTargetIds } from "../../../src/modules/relationship-targets";
import { PgReadingStore, pgReadingStoreFor } from "../../../src/modules/stores/postgres/reading-store";
import { pgReadingWriterFor } from "../../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor } from "../../../src/modules/stores/postgres/similarity-store";
import { buildLocalSeed } from "../../fixtures/local-seed";
import { mintTenant, testSql } from "../../helpers/pg-fixtures";

const NOW = "2026-09-19T12:00:00.000Z";
const plan = buildLocalSeed(NOW);
const tenant = await mintTenant();
const tenantId = String(tenant.tenantId);
const rows = localSeedRows(plan, tenantId);

let sql: Sql;
let postgres: PgReadingStore;

beforeAll(async () => {
  sql = testSql();
  await sql.transaction(async (tx) => {
    for (const reading of rows) await writeReadingRows(tx, reading);
    for (const attempt of localSeedAttempts(plan)) await upsertAttempt(tx, tenantId, attempt);
  });
  postgres = pgReadingStoreFor(sql, tenant);
});
afterAll(() => sql.end());

const ready = plan.fixtures.filter((fixture) => fixture.manifest.status === "ready");

describe("the local fixture pack as PostgreSQL rows", () => {
  it("maps every fixture without dropping anything", () => {
    expect(rows.flatMap((reading) => reading.notes.map((note) => `${reading.reading.id}: ${note}`))).toEqual([]);
  });

  it("lists the library as the pack's rows, newest first", async () => {
    const page = await postgres.listManifests({ offset: 0, limit: 100 });
    expect(page).toEqual({ readings: plan.listIndex.items, total_filtered: plan.fixtures.length });
  });

  it.each(plan.fixtures.map((fixture) => [fixture.name, fixture]))("loads %s as its manifest", async (_name, fixture) => {
    expect(await postgres.loadReadingById(fixture.id)).toEqual({ keyPrefix: fixture.keyPrefix, manifest: fixture.manifest, version: expect.any(String) });
  });

  it.each(plan.fixtures.map((fixture) => [fixture.name, fixture]))("lists %s's attempt log, newest first", async (_name, fixture) => {
    expect(await pgReadingWriterFor(sql, tenant).listAttempts(fixture.id)).toEqual([...fixture.attempts].reverse());
  });

  it("resolves relationship targets as the pack's rows, removed target included", async () => {
    const ids = [...new Set(ready.flatMap((fixture) => relationshipTargetIds(fixture.manifest)))];
    expect(ids).toContain(plan.removedTargetId);
    const items = await postgres.relationshipTargets(ids);
    expect(projectRelationshipTargets(ids, { version: 1, items }, 900, NOW)).toEqual(
      projectRelationshipTargets(ids, plan.listIndex, 900, NOW),
    );
  });

  it("gives each URL the owner the pack names", async () => {
    const owners = new Map(plan.fixtures.filter((f) => f.ownsUrl).map((f) => [f.manifest.url, f.id]));
    for (const fixture of plan.fixtures) {
      expect((await postgres.findOwnerByUrl(fixture.manifest.url))?.id, fixture.name).toBe(owners.get(fixture.manifest.url));
    }
    expect(await postgres.findOwnerByUrl("https://unclaimed.example/nothing-here")).toBeNull();
  });

  it("hands out exactly the content keys the seed writes to R2", async () => {
    const seeded = new Set(plan.objects.map((object) => object.key));
    let extracted = 0;
    // Only a ready reading has captured anything; the others name placeholders.
    for (const fixture of ready) {
      const keys = (await postgres.contentKeys(fixture.id))!;
      expect(seeded.has(keys.rawKey), `${fixture.name} ${keys.rawKey}`).toBe(true);
      if (keys.extractedKey !== null) {
        expect(seeded.has(keys.extractedKey), `${fixture.name} ${keys.extractedKey}`).toBe(true);
        extracted++;
      }
    }
    expect(extracted).toBeGreaterThan(0);
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
