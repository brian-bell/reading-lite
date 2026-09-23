// The export adapter and emitted rows must agree with the runtime's actual
// PostgreSQL projection, including immutable keys and relationship flags.
import { describe, expect, it, vi } from "vitest";
import {
  readContextRows,
  withContextDatabases,
} from "../../../scripts/staging-lib/context-rows";
import {
  prepareContextCopy,
  copyHash,
  contextFingerprint,
  type CopyReaders,
} from "../../../scripts/staging-lib/context-copy";
import { operatorReadings } from "../../../scripts/pg-lib/operator-corpus";
import { writeReadingRows } from "../../../scripts/pg-lib/manifest-rows";
import type { Sql } from "../../../src/modules/db/sql";
import { pgSimilarityStoreFor } from "../../../src/modules/stores/postgres/similarity-store";
import {
  seedTenant,
  seedReading,
  seedSupersededRevision,
  seedCapturingAttempt,
  unitVector,
  useCorpusDatabase,
} from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase(),
  id = "rd_0000000001";
const vars = {
  PRODUCTION_DATABASE_URL: "postgres://test/source",
  STAGING_DATABASE_URL: "postgres://test/destination",
};
async function fixture() {
  const sql = sqlFor(),
    source = await seedTenant(sql),
    destination = await seedTenant(sql);
  await sql.execute(
    "INSERT INTO system_policy (id, signup_mode, catalog_version, policy_version, daily_spend_microdollars, paid_work_enabled, updated_at) VALUES (1, 'closed', 1, 1, 10000, false, now())",
  );
  const { keyPrefix } = await seedReading(sql, source, id, {
    embedding: unitVector(),
    connections: [
      { id: "rd_missing_z", reason: "first" },
      { id: "rd_missing_a", reason: "second" },
    ],
  });
  await sql.execute(
    "UPDATE readings SET content_sha256 = $3, content_bytes = 4, extracted_bytes = 4 WHERE tenant_id = $1 AND id = $2",
    [source.tenantId, id, copyHash("text")],
  );
  // Fixtures live in a rolled-back outer transaction. Its savepoints cannot
  // switch isolation/read-only modes; sql-transactions.test owns the real
  // connection contract. Here we exercise every export query against PG.
  const snapshotSql: Sql = {
    ...sql,
    transaction: (work, options) => {
      expect(options).toEqual({ readOnly: true, repeatableRead: true });
      return sql.transaction(work);
    },
  };
  const read = (ids = [id], seeds = [id]) =>
    readContextRows(
      snapshotSql,
      snapshotSql,
      source.tenantId,
      destination.tenantId,
      ids,
      seeds,
    );
  const reads = vi.fn(async (_key: string) => ({
    body: Buffer.from("text"),
    contentType: "text/html",
  }));
  const readers: CopyReaders = {
    source: { read: reads },
    destination: { list: async () => [] },
    rows: read,
  };
  const input = {
    sourceTenant: source.tenantId,
    destinationTenant: destination.tenantId,
    ids: [id],
    targets: [],
    now: "2026-09-21T00:00:00.000Z",
  };
  return { sql, source, destination, keyPrefix, read, readers, reads, input };
}

describe("context PostgreSQL adapter", () => {
  it("round-trips emitted rows through the runtime reader and exact similarity, leaving the source alone", async () => {
    const f = await fixture();
    const before = await f.read();
    const artifact = await prepareContextCopy(f.input, f.readers);
    await f.sql.transaction(async (tx) => {
      for (const rows of artifact.rows) await writeReadingRows(tx, rows);
    });
    const source = await operatorReadings(f.sql, f.source).loadReadingById(id);
    const destination = await operatorReadings(
      f.sql,
      f.destination,
    ).loadReadingById(id);
    // Different rows carry different row versions; everything else is the copy.
    const { version: _sourceVersion, ...sourceRow } = source!;
    const { version: _destinationVersion, ...destinationRow } = destination!;
    expect(destinationRow).toEqual(sourceRow);
    expect(destination?.manifest.connections).toEqual([
      { id: "rd_missing_z", reason: "first" },
      { id: "rd_missing_a", reason: "second" },
    ]);
    expect(destination?.manifest.tensions).toBeUndefined();
    expect(
      await operatorReadings(f.sql, f.destination).findOwnerByUrl(
        source!.manifest.url,
      ),
    ).toEqual({ id, status: "ready" });
    expect(
      await pgSimilarityStoreFor(f.sql, f.destination).query(unitVector(), 10),
    ).toMatchObject([
      {
        id,
        score: 1,
        title: source!.manifest.title,
        tldr: source!.manifest.tldr,
      },
    ]);
    const [sourceEmbedding] = await f.sql.query<{ embedding: string }>(
      "SELECT embedding::text FROM reading_embeddings WHERE tenant_id = $1 AND reading_id = $2",
      [f.source.tenantId, id],
    );
    expect(JSON.parse(sourceEmbedding.embedding)).toEqual(before[0].embedding);
  });

  it.each(["revision", "attempt", "legacy"])(
    "resolves %s content keys under a stored imported prefix",
    async (tier) => {
      const f = await fixture(),
        imported = "readings/imported/" + id;
      await f.sql.execute(
        "UPDATE readings SET key_prefix = $3 WHERE tenant_id = $1 AND id = $2",
        [f.source.tenantId, id, imported],
      );
      const raw = imported + "/revisions/current/raw.html",
        extracted = imported + "/revisions/current/extracted.md";
      if (tier === "revision") {
        await f.sql.execute(
          "UPDATE reading_revisions SET raw_key = $3, extracted_key = $4 WHERE tenant_id = $1 AND reading_id = $2",
          [f.source.tenantId, id, raw, extracted],
        );
        await seedSupersededRevision(f.sql, f.source, id, {
          id: "old",
          rawKey: imported + "/revisions/old/raw.html",
          extractedKey: null,
        });
      } else {
        await f.sql.execute(
          "UPDATE readings SET current_revision_id = NULL WHERE tenant_id = $1 AND id = $2",
          [f.source.tenantId, id],
        );
        await f.sql.execute(
          "DELETE FROM reading_revisions WHERE tenant_id = $1 AND reading_id = $2",
          [f.source.tenantId, id],
        );
        if (tier === "attempt")
          await seedCapturingAttempt(f.sql, f.source, id, {
            rawKey: raw,
            extractedKey: extracted,
          });
      }
      const p = await prepareContextCopy(f.input, f.readers);
      const keys =
        tier === "legacy"
          ? [imported + "/raw.html", imported + "/extracted.md"]
          : [raw, extracted];
      expect(f.reads.mock.calls.map(([key]) => key).sort()).toEqual(
        keys.sort(),
      );
      expect(p.rows[0].revision).toMatchObject({
        raw_key: keys.find((k) => k.endsWith("raw.html")),
        extracted_key: keys.find((k) => k.endsWith("extracted.md")),
      });
    },
  );

  it.each(["id", "url", "hash claim", "prefix"])(
    "refuses an occupied destination %s even without R2 metadata",
    async (collision) => {
      const f = await fixture(),
        source = await operatorReadings(f.sql, f.source).loadReadingById(id);
      await seedReading(
        f.sql,
        f.destination,
        collision === "id" ? id : "rd_0000000002",
        {
          url:
            collision === "url"
              ? source!.manifest.url
              : "https://example.com/different",
          ownsUrl: collision !== "url",
        },
      );
      if (collision === "prefix")
        await f.sql.execute(
          "UPDATE readings SET key_prefix = $2 WHERE tenant_id = $1",
          [f.destination.tenantId, f.keyPrefix],
        );
      if (collision === "hash claim")
        await f.sql.execute(
          "UPDATE reading_urls SET url_hash = $2 WHERE tenant_id = $1",
          [f.destination.tenantId, source!.manifest.url_hash],
        );
      await expect(prepareContextCopy(f.input, f.readers)).rejects.toThrow(
        "Occupied destination",
      );
      expect(f.reads).not.toHaveBeenCalled();
    },
  );

  it.each(["inactive", "paid", "missing policy"])(
    "refuses %s staging state before reading content",
    async (state) => {
      const f = await fixture();
      if (state === "inactive")
        await f.sql.execute(
          "UPDATE users SET status = 'deleting' WHERE id = $1",
          [f.destination.tenantId],
        );
      if (state === "paid")
        await f.sql.execute(
          "UPDATE system_policy SET paid_work_enabled = true",
        );
      if (state === "missing policy")
        await f.sql.execute("DELETE FROM system_policy");
      await expect(prepareContextCopy(f.input, f.readers)).rejects.toThrow(
        "active and paid work disabled",
      );
      expect(f.reads).not.toHaveBeenCalled();
    },
  );

  it("never borrows another tenant embedding and binds row fingerprints to the selected vector", async () => {
    const f = await fixture();
    const original = (await f.read())[0];
    await f.sql.execute("DELETE FROM reading_embeddings WHERE tenant_id = $1", [
      f.source.tenantId,
    ]);
    const other = await seedTenant(f.sql);
    await seedReading(f.sql, other, id, { embedding: unitVector() });
    const changed = (await f.read())[0];
    expect(changed.embedding).toBeNull();
    expect(contextFingerprint(changed)).not.toBe(contextFingerprint(original));
    await expect(prepareContextCopy(f.input, f.readers)).rejects.toThrow(
      "Missing source embedding",
    );
    expect(f.reads).not.toHaveBeenCalled();
  });
});

describe("context session lifetime", () => {
  it.each(["success", "partial open", "callback failure"])(
    "closes all opened sessions on %s",
    async (outcome) => {
      const source = { ...sqlFor(), end: vi.fn().mockResolvedValue(undefined) };
      const destination = {
        ...sqlFor(),
        end: vi.fn().mockResolvedValue(undefined),
      };
      const open = vi.fn((url: string): Sql => {
        if (url === vars.PRODUCTION_DATABASE_URL) return source;
        if (outcome === "partial open") throw Error("open failed");
        return destination;
      });
      const work = vi.fn(async () => {
        if (outcome !== "success") throw Error(outcome);
        return 42;
      });
      const run = withContextDatabases(vars, work, open);
      if (outcome === "success") await expect(run).resolves.toBe(42);
      else await expect(run).rejects.toThrow();
      expect(source.end).toHaveBeenCalledOnce();
      expect(destination.end).toHaveBeenCalledTimes(
        outcome === "partial open" ? 0 : 1,
      );
      expect(open.mock.calls.map(([url]) => url)).toEqual([
        vars.PRODUCTION_DATABASE_URL,
        vars.STAGING_DATABASE_URL,
      ]);
    },
  );
  it("resolves both environment bindings before opening either session", async () => {
    const open = vi.fn();
    await expect(
      withContextDatabases(
        { PRODUCTION_DATABASE_URL: vars.PRODUCTION_DATABASE_URL },
        async () => undefined,
        open,
      ),
    ).rejects.toThrow("STAGING_DATABASE_URL");
    expect(open).not.toHaveBeenCalled();
  });
});
