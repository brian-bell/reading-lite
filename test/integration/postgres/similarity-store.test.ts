import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../../../src/modules/db/sql";
import { pgSimilarityStoreFor } from "../../../src/modules/stores/postgres/similarity-store";
import { WrongEmbeddingDimensionError } from "../../../src/modules/stores/similarity-store";
import { axisVector, mintTenant, readyManifest, seedManifest, testSql } from "../../helpers/pg-fixtures";

let sql: Sql;
beforeEach(() => {
  sql = testSql();
});
afterEach(() => sql.end());

describe("PgSimilarityStore", () => {
  it("returns ready neighbours nearest first with cosine scores and reading metadata", async () => {
    const tenant = await mintTenant();
    const near = await readyManifest("rd_near", { tags: ["Near"] });
    await seedManifest(sql, tenant, near, { embedding: axisVector(1, 0.9) });
    await seedManifest(sql, tenant, await readyManifest("rd_far"), { embedding: axisVector(2, 0.1) });
    const matches = await pgSimilarityStoreFor(sql, tenant).query(axisVector(0), 5);
    expect(matches.map((match) => match.id)).toEqual(["rd_near", "rd_far"]);
    expect(matches[0]).toEqual({
      id: "rd_near",
      score: expect.closeTo(0.9 / Math.hypot(0.9, 1), 6),
      url: near.url,
      title: near.title,
      tldr: near.tldr,
      tags: ["Near"],
      created_at: near.created_at,
    });
  });

  it("caps results at topK", async () => {
    const tenant = await mintTenant();
    for (let axis = 1; axis <= 3; axis++) {
      await seedManifest(sql, tenant, await readyManifest(`rd_${axis}`), { embedding: axisVector(axis, axis / 10) });
    }
    const matches = await pgSimilarityStoreFor(sql, tenant).query(axisVector(0), 2);
    expect(matches.map((match) => match.id)).toEqual(["rd_3", "rd_2"]);
  });

  it("skips a reading that stopped being ready", async () => {
    const tenant = await mintTenant();
    await seedManifest(sql, tenant, await readyManifest("rd_was_ready"), { embedding: axisVector(1, 0.5) });
    await sql.query("UPDATE readings SET status = 'failed' WHERE tenant_id = $1", [String(tenant.tenantId)]);
    expect(await pgSimilarityStoreFor(sql, tenant).query(axisVector(0), 5)).toEqual([]);
  });

  it("queries by a stored vector, self included, and returns null without one", async () => {
    const tenant = await mintTenant();
    await seedManifest(sql, tenant, await readyManifest("rd_self"), { embedding: axisVector(1, 0.5) });
    await seedManifest(sql, tenant, await readyManifest("rd_peer"), { embedding: axisVector(1, 0.4) });
    await seedManifest(sql, tenant, await readyManifest("rd_vectorless"));
    const store = pgSimilarityStoreFor(sql, tenant);
    const matches = await store.queryByVectorId("rd_self", 5);
    expect(matches!.map((match) => match.id)).toEqual(["rd_self", "rd_peer"]);
    expect(matches![0]!.score).toBeCloseTo(1, 6);
    expect(await store.queryByVectorId("rd_vectorless", 5)).toBeNull();
  });

  it("rejects a wrong-dimension embedding before any SQL runs", async () => {
    const query = vi.fn();
    const fake = { query, transaction: vi.fn(), end: vi.fn() } as unknown as Sql;
    const store = pgSimilarityStoreFor(fake, await mintTenant());
    await expect(store.query([1, 2, 3], 5)).rejects.toBeInstanceOf(WrongEmbeddingDimensionError);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a malformed tenant id", () => {
    const fake = { query: vi.fn(), transaction: vi.fn(), end: vi.fn() } as unknown as Sql;
    expect(() => pgSimilarityStoreFor(fake, { tenantId: "global" as never })).toThrow("malformed tenant id");
  });

  it("gives a small tenant its full k beside a larger tenant that sits closer to the query", async () => {
    // The case a shared HNSW index got wrong (ADR 0005): the scan is exact.
    const large = await mintTenant();
    const small = await mintTenant();
    const largeId = String(large.tenantId);
    await sql.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO readings (tenant_id, id, key_prefix, url, url_hash, status, created_at, updated_at,
           content_type, content_status, content_bytes, content_sha256)
         SELECT $1, 'rd_big_' || n, 'readings/big/' || n, 'https://example.com/big/' || n, repeat('a', 64),
           'ready', now(), now(), 'text/html', 'captured', 0, repeat('0', 64)
         FROM generate_series(1, 60) AS n`,
        [largeId],
      );
      await tx.query(
        `INSERT INTO reading_embeddings (tenant_id, reading_id, embedding)
         SELECT $1, 'rd_big_' || n,
           (SELECT array_agg(CASE WHEN i = 1 THEN 1 WHEN i = n + 1 THEN 0.05 ELSE 0 END ORDER BY i)
            FROM generate_series(1, 1536) AS i)::vector
         FROM generate_series(1, 60) AS n`,
        [largeId],
      );
    });
    for (let axis = 1; axis <= 5; axis++) {
      await seedManifest(sql, small, await readyManifest(`rd_small_${axis}`), { embedding: axisVector(1000 + axis, 0.01 * axis) });
    }
    const matches = await pgSimilarityStoreFor(sql, small).query(axisVector(0), 5);
    expect(matches.map((match) => match.id)).toEqual([
      "rd_small_5", "rd_small_4", "rd_small_3", "rd_small_2", "rd_small_1",
    ]);
    // Isolation in the other direction: the large tenant never sees the small one's rows.
    const theirs = await pgSimilarityStoreFor(sql, large).query(axisVector(1001), 50);
    expect(theirs).toHaveLength(50);
    expect(theirs.every((match) => match.id.startsWith("rd_big_"))).toBe(true);
  });
});
