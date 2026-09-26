// `ops export inspect` and `ops export cancel` (reading-lite-mxwx.9) against
// the migrated schema, with an in-memory R2 inventory standing in for the
// bucket. Rows are real, so the lock, the lease bump, and the tenant scoping
// are what the database does.

import { describe, expect, it } from "vitest";
import { exportCancelCommand } from "../../../scripts/ops-lib/commands/export-cancel";
import { exportInspectCommand } from "../../../scripts/ops-lib/commands/export-inspect";
import type {
  ConnectExports,
  ConnectExportsArgs,
  ExportRemote,
  ExportStorage,
} from "../../../scripts/export-lib/exports";
import { fromSql } from "../../../src/control-plane/db";
import { toTimestamp } from "../../../src/control-plane/pg-time";
import type { Sql } from "../../../src/modules/db/sql";
import { captureIo, seedTenant, useCorpusDatabase } from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();

const NOW_MS = Date.parse("2026-09-26T12:00:00.000Z");
const EXPORT_ID = "exp_00000000-0000-4000-8000-0000000000aa";
const OTHER_EXPORT_ID = "exp_00000000-0000-4000-8000-0000000000bb";
const ORPHAN_EXPORT_ID = "exp_00000000-0000-4000-8000-0000000000cc";

interface MemoryStorage extends ExportStorage {
  objects: Map<string, number>;
  keys(): string[];
  onDelete?: (key: string) => Promise<void>;
}

function memoryStorage(): MemoryStorage {
  const objects = new Map<string, number>();
  const storage: MemoryStorage = {
    objects,
    keys: () => [...objects.keys()].sort(),
    listObjects: async (prefix) =>
      [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, size]) => ({ key, size })),
    delete: async (key) => {
      await storage.onDelete?.(key);
      objects.delete(key);
    },
  };
  return storage;
}

function putParts(storage: MemoryStorage, tenantId: string, exportId: string): void {
  const prefix = `u/${tenantId}/exports/${exportId}`;
  storage.objects.set(`${prefix}/segments/segment-0001`, 2048);
  storage.objects.set(`${prefix}/segments/state-0001.json`, 512);
}

async function seedExport(
  sql: Sql,
  tenantId: string,
  exportId: string,
  status: string,
  opts: { updatedAtMs?: number; leaseSeq?: number } = {},
): Promise<void> {
  const updated = toTimestamp(opts.updatedAtMs ?? NOW_MS - 60_000);
  await sql.execute(
    `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at, lease_seq)
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [exportId, tenantId, status, updated, opts.leaseSeq ?? 3],
  );
}

async function exportRow(sql: Sql, exportId: string) {
  const [row] = await sql.query<{ status: string; lease_seq: number; error: unknown; updated_at: string }>(
    "SELECT status, lease_seq, error, updated_at::text FROM archive_exports WHERE id = $1",
    [exportId],
  );
  return row;
}

async function arrange() {
  const sql = sqlFor();
  const tenantId = String((await seedTenant(sql)).tenantId);
  const storage = memoryStorage();
  const remote: ExportRemote = { db: fromSql(sql), storage };
  const connected: ConnectExportsArgs[] = [];
  const connect: ConnectExports = (args, work) => {
    connected.push(args);
    return work(remote);
  };
  const deps = (io: ReturnType<typeof captureIo>) => ({ io: io.io, now: () => NOW_MS, connect });
  return { sql, tenantId, storage, deps, connected };
}

function cancel(tenantId: string, ...extra: string[]): string[] {
  return ["--tenant", tenantId, "--export", EXPORT_ID, ...extra];
}

describe("ops export inspect", () => {
  it("shows every row with its lease, idle time, and parts, and the parts no row owns", async () => {
    const { sql, tenantId, storage, deps } = await arrange();
    const other = String((await seedTenant(sql)).tenantId);
    await seedExport(sql, tenantId, EXPORT_ID, "building", { updatedAtMs: NOW_MS - 42 * 60_000, leaseSeq: 7 });
    await seedExport(sql, tenantId, OTHER_EXPORT_ID, "cancelled");
    await seedExport(sql, other, ORPHAN_EXPORT_ID, "queued");
    putParts(storage, tenantId, EXPORT_ID);
    putParts(storage, tenantId, OTHER_EXPORT_ID);
    storage.objects.set(`u/${tenantId}/exports/${ORPHAN_EXPORT_ID}/eocd`, 22);

    const io = captureIo();
    expect(await exportInspectCommand.run(["--tenant", tenantId], deps(io))).toBe(0);
    const out = io.all();
    expect(out).toContain(`${EXPORT_ID}  building`);
    expect(out).toContain("lease_seq 7");
    expect(out).toContain("idle 42m: past the 30m lease; the */15 cron should have resent it by 45m");
    expect(out).toContain("parts: 2 objects (2.5 KiB)");
    expect(out).toContain(`leftover parts: npm run ops -- export cancel --tenant ${tenantId} --export ${OTHER_EXPORT_ID}`);
    expect(out).not.toContain(`leftover parts: npm run ops -- export cancel --tenant ${tenantId} --export ${EXPORT_ID}`);
    // The other tenant's queued row is not this tenant's; its id only shows
    // up because this tenant's prefix holds parts under it.
    expect(out).not.toContain(`${ORPHAN_EXPORT_ID}  queued`);
    expect(out).toContain(`Parts with no archive_exports row:\n  ${ORPHAN_EXPORT_ID}: 1 objects (22 B)`);
  });

  it("exits 1 for an export the tenant does not have", async () => {
    const { tenantId, deps } = await arrange();
    const io = captureIo();
    expect(await exportInspectCommand.run(["--tenant", tenantId, "--export", EXPORT_ID], deps(io))).toBe(1);
    expect(io.err.join("\n")).toContain(`has no export ${EXPORT_ID}`);
  });

  it("refuses --tenant global before connecting", async () => {
    const { deps, connected } = await arrange();
    await expect(exportInspectCommand.run(["--tenant", "global"], deps(captureIo()))).rejects.toThrow(
      "--tenant global has no archive exports",
    );
    expect(connected).toEqual([]);
  });
});

describe("ops export cancel", () => {
  it.each([
    { status: "queued", code: 0, after: "cancelled", bumped: true, deleted: true },
    { status: "building", code: 0, after: "cancelled", bumped: true, deleted: true },
    { status: "cancelled", code: 0, after: "cancelled", bumped: false, deleted: true },
    { status: "failed", code: 0, after: "failed", bumped: false, deleted: true },
    { status: "ready", code: 1, after: "ready", bumped: false, deleted: false },
    { status: "expired", code: 1, after: "expired", bumped: false, deleted: false },
  ])("--execute on a $status export", async ({ status, code, after, bumped, deleted }) => {
    const { sql, tenantId, storage, deps } = await arrange();
    await seedExport(sql, tenantId, EXPORT_ID, status);
    putParts(storage, tenantId, EXPORT_ID);
    putParts(storage, tenantId, OTHER_EXPORT_ID);
    const before = await exportRow(sql, EXPORT_ID);

    const io = captureIo();
    expect(await exportCancelCommand.run(cancel(tenantId, "--execute"), deps(io))).toBe(code);

    const row = await exportRow(sql, EXPORT_ID);
    expect(row?.status).toBe(after);
    expect(row?.lease_seq).toBe(bumped ? before!.lease_seq + 1 : before!.lease_seq);
    if (bumped) expect(row?.error).toEqual({ code: "operator_cancelled" });
    else expect(row?.updated_at).toBe(before!.updated_at);
    const own = storage.keys().filter((key) => key.includes(EXPORT_ID));
    expect(own).toHaveLength(deleted ? 0 : 2);
    // Only the named export's prefix.
    expect(storage.keys().filter((key) => key.includes(OTHER_EXPORT_ID))).toHaveLength(2);
  });

  it("refuses another tenant's export and changes nothing", async () => {
    const { sql, tenantId, storage, deps } = await arrange();
    const other = String((await seedTenant(sql)).tenantId);
    await seedExport(sql, other, EXPORT_ID, "building");
    putParts(storage, other, EXPORT_ID);

    const io = captureIo();
    expect(await exportCancelCommand.run(cancel(tenantId, "--execute"), deps(io))).toBe(1);
    expect(io.err.join("\n")).toContain(`has no export ${EXPORT_ID}`);
    expect((await exportRow(sql, EXPORT_ID))?.status).toBe("building");
    expect(storage.keys()).toHaveLength(2);
  });

  it("plans without changing the row or the parts", async () => {
    const { sql, tenantId, storage, deps } = await arrange();
    await seedExport(sql, tenantId, EXPORT_ID, "building");
    putParts(storage, tenantId, EXPORT_ID);
    const before = await exportRow(sql, EXPORT_ID);

    const io = captureIo();
    expect(await exportCancelCommand.run(cancel(tenantId), deps(io))).toBe(0);
    expect(io.all()).toContain(`Would cancel ${EXPORT_ID} (building → cancelled`);
    expect(io.all()).toContain(`Would delete 2 objects under u/${tenantId}/exports/${EXPORT_ID}/.`);
    expect(await exportRow(sql, EXPORT_ID)).toEqual(before);
    expect(storage.keys()).toHaveLength(2);
  });

  // Row before R2: a delivery that loses the lease cannot re-mark the row,
  // and a delete that fails leaves an ended row a rerun can finish.
  it("commits the cancel before deleting, and a rerun finishes a delete that failed", async () => {
    const { sql, tenantId, storage, deps } = await arrange();
    await seedExport(sql, tenantId, EXPORT_ID, "building");
    putParts(storage, tenantId, EXPORT_ID);
    const seen: string[] = [];
    storage.onDelete = async () => {
      seen.push((await exportRow(sql, EXPORT_ID))!.status);
      throw new Error("R2 DELETE failed: 500");
    };

    const failed = captureIo();
    expect(await exportCancelCommand.run(cancel(tenantId, "--execute"), deps(failed))).toBe(1);
    expect(seen).toEqual(["cancelled"]);
    expect(failed.err.join("\n")).toContain("The row is cancelled. Re-run the same command with --execute");
    expect(storage.keys()).toHaveLength(2);
    const cancelled = await exportRow(sql, EXPORT_ID);

    storage.onDelete = undefined;
    const rerun = captureIo();
    expect(await exportCancelCommand.run(cancel(tenantId, "--execute"), deps(rerun))).toBe(0);
    expect(rerun.all()).toContain(`deleted 2 objects under u/${tenantId}/exports/${EXPORT_ID}/`);
    expect(storage.keys()).toEqual([]);
    expect(await exportRow(sql, EXPORT_ID)).toEqual(cancelled);
  });
});
