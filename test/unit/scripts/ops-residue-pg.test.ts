// Queries run against the migrated schema; mocks cannot catch a retired table
// or a timestamp/boolean mismatch in this deletion-observation surface.
import { describe, expect, it } from "vitest";
import {
  scanResidue,
  type ScanRemote,
} from "../../../scripts/account-lib/residue";
import { accountResidueScanCommand } from "../../../scripts/ops-lib/commands/account-residue-scan";
import { fromSql } from "../../../src/control-plane/db";
import { mintUserId } from "../../../src/control-plane/ids";
import {
  captureIo,
  seedReading,
  seedTenant,
  unitVector,
  useCorpusDatabase,
} from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();
function remote(): ScanRemote {
  return {
    db: fromSql(sqlFor()),
    storage: { listObjects: async () => [] },
  };
}

describe("PostgreSQL residue", () => {
  it("reports empty observable storage without certifying its visibility blind spots", async () => {
    const tenant = mintUserId();
    const other = await seedTenant(sqlFor());
    await seedReading(sqlFor(), other, "rd_other", { embedding: unitVector() });
    const r = remote();
    const result = await scanResidue(r, tenant);
    expect(result).toMatchObject({ residue: false, incomplete: true });
    const pg = result.findings.filter((f) => f.source.startsWith("pg."));
    expect(pg.length).toBeGreaterThan(10);
    expect(pg.every((f) => f.state === "clear")).toBe(true);
    expect(
      result.findings.find((f) => f.source === "ready_reading_embeddings")
        ?.state,
    ).toBe("clear");
    const io = captureIo();
    expect(
      await accountResidueScanCommand.run(["--tenant", tenant], {
        io: io.io,
        connect: () => r,
      }),
    ).toBe(1);
  });

  it("reports retained reading, embedding, inbox, refresh and export rows independently", async () => {
    const sql = sqlFor(),
      tenant = await seedTenant(sql);
    await seedReading(sql, tenant, "rd_seed", { embedding: unitVector() });
    await sql.execute(
      "INSERT INTO corpus_refresh_state (tenant_id, state, updated_at) VALUES ($1, '{}'::jsonb, now())",
      [tenant.tenantId],
    );
    await sql.execute(
      "INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at) VALUES ('exp_residue', $1, 'cancelled', now(), now())",
      [tenant.tenantId],
    );
    await sql.execute(
      `INSERT INTO tension_refresh_jobs (tenant_id, reading_a, reading_b, run_at, owner, a_version, b_version)
       VALUES ($1, 'rd_a', 'rd_b', now(), 'owner', 'va', 'vb')`,
      [tenant.tenantId],
    );
    await sql.execute(
      `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
       VALUES ($1, 'in_residue', 'https://example.com/residue', $2, '# staged', now(), now())`,
      [tenant.tenantId, "d".repeat(64)],
    );
    const result = await scanResidue(remote(), tenant.tenantId);
    for (const source of [
      "pg.readings",
      "pg.reading_embeddings",
      "pg.inbox_items",
      "pg.corpus_refresh_state",
      "pg.tension_refresh_jobs",
      "pg.archive_exports",
      "pg.users",
    ]) {
      expect(result.findings.find((f) => f.source === source)).toMatchObject({
        state: "residue",
        detail: { count: 1 },
      });
    }
    expect(result.residue).toBe(true);
  });

  it("reports missing ready embeddings as diagnostics, never inventing deletion residue", async () => {
    const tenant = await seedTenant(sqlFor());
    await seedReading(sqlFor(), tenant, "rd_missing", { ownsUrl: false });
    const result = await scanResidue(remote(), tenant.tenantId);
    expect(
      result.findings.find((f) => f.source === "ready_reading_embeddings"),
    ).toMatchObject({
      state: "unknown",
      detail: [{ id: "rd_missing" }],
    });
    expect(
      result.findings.find((f) => f.source === "pg.reading_embeddings")?.state,
    ).toBe("clear");
    expect(result.findings.find((f) => f.source === "pg.readings")?.state).toBe(
      "residue",
    );
  });
});
