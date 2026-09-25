import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArchiveExport } from "../../../src/archive-export";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { archiveExportEnvelopeV1 } from "../../../src/control-plane/export-envelope";
import { parseTenantId, parseUserId } from "../../../src/control-plane/ids";
import { toTimestamp } from "../../../src/control-plane/pg-time";
import type { Sql } from "../../../src/modules/db/sql";
import { contentStoreFor } from "../../../src/modules/stores/content-store";
import type { ListIndexItem } from "../../../src/schemas/api";
import { useControlPlane } from "../../helpers/control-plane-pg";
import { memoryBucket, NODE_HYPERDRIVE } from "../../helpers/node-readings";
import { readZipEntries } from "../../helpers/read-zip";
import { TestReadings } from "../../helpers/readings-facade";

const openControlPlane = useControlPlane();

const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const TENANT_ID = "usr_880e8400-e29b-41d4-a716-4466554400aa";
const EXPORT_ID = "exp_00000000-0000-4000-8000-0000000000aa";

function item(id: string, status: ListIndexItem["status"], createdAt: string): ListIndexItem {
  return {
    id,
    key_prefix: `readings/${createdAt.replace(/[-:]/g, "").replace(".000Z", "Z")}-${id}`,
    url: `https://example.com/${id}`,
    title: id,
    status,
    created_at: createdAt,
  };
}

async function arrange(sql: Sql, db: ControlPlaneDb) {
  const tenantId = parseTenantId(TENANT_ID)!;
  const userId = parseUserId(TENANT_ID)!;
  const now = toTimestamp(NOW_MS);
  await db.run(
    `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    userId,
    "export-build@test.example",
    "export-build@test.example",
    now,
    now,
  );
  const bucket = memoryBucket();
  const env = { HYPERDRIVE: NODE_HYPERDRIVE, READINGS_BUCKET: bucket, TENANT_DATA_PLANE: "1" };
  const readings = new TestReadings({ tenantId }, env, sql);
  await readings.seedListItems([
    item("rd_pending", "pending", "2026-01-01T00:00:00.000Z"),
    item("rd_ready", "ready", "2026-02-01T00:00:00.000Z"),
    item("rd_failed", "failed", "2026-03-01T00:00:00.000Z"),
  ]);
  await db.run(
    `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?)`,
    EXPORT_ID,
    userId,
    now,
    now,
  );
  return { tenantId, bucket, env, readings };
}

async function readArchive(db: ControlPlaneDb, bucket: R2Bucket, env: { TENANT_DATA_PLANE: string }) {
  const row = await db.first<{
    segments: { parts: Array<{ key: string; bytes: number }>; total_bytes: number };
    counts: { readings: number; pending: number; ready: number; failed: number };
  }>("SELECT segments, counts FROM archive_exports WHERE id = ?", EXPORT_ID);
  const content = contentStoreFor(bucket, { tenantId: parseTenantId(TENANT_ID)! }, env);
  const parts: Uint8Array[] = [];
  for (const part of row!.segments.parts) {
    const object = await content.get(part.key);
    expect(object?.size).toBe(part.bytes);
    parts.push(new Uint8Array(await object!.arrayBuffer()));
  }
  const zip = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    zip.set(part, offset);
    offset += part.byteLength;
  }
  expect(zip.byteLength).toBe(row!.segments.total_bytes);
  return { row: row!, zip, entries: await readZipEntries(zip) };
}

function jsonEntry<T>(entries: Map<string, Uint8Array>, name: string): T {
  return JSON.parse(new TextDecoder().decode(entries.get(name))) as T;
}

describe("buildArchiveExport", () => {
  it("pages every status into one zip that unzip -t accepts", async () => {
    const { db, sql } = openControlPlane();
    const { tenantId, bucket, env } = await arrange(sql, db);
    const outcome = await buildArchiveExport(sql, archiveExportEnvelopeV1({ tenantId, exportId: EXPORT_ID }), env, {
      nowMs: NOW_MS,
      pageSize: 1,
    });
    expect(outcome).toBe("ready");

    const { row, zip, entries } = await readArchive(db, bucket, env);
    expect(row.counts).toEqual({ readings: 3, pending: 1, ready: 1, failed: 1 });

    expect([...entries.keys()].sort()).toEqual([
      "export.json",
      "index.json",
      "readings/rd_failed/manifest.json",
      "readings/rd_pending/manifest.json",
      "readings/rd_ready/manifest.json",
    ]);
    expect(jsonEntry<{ counts: { readings: number } }>(entries, "export.json").counts.readings).toBe(3);
    const index = jsonEntry<{ items: Array<{ id: string; status: string }> }>(entries, "index.json");
    expect(index.items.map((entry) => entry.status).sort()).toEqual(["failed", "pending", "ready"]);
    for (const id of ["rd_pending", "rd_ready", "rd_failed"]) {
      expect(jsonEntry<{ id: string }>(entries, `readings/${id}/manifest.json`).id).toBe(id);
    }

    const dir = mkdtempSync(join(tmpdir(), "archive-export-"));
    const path = join(dir, "archive.zip");
    writeFileSync(path, zip);
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toMatch(/No errors detected/);
  });

  it("keeps index.json and counts on the manifest a reading had when it was loaded", async () => {
    const { db, sql } = openControlPlane();
    const { tenantId, bucket, env, readings } = await arrange(sql, db);
    // rd_pending publishes after the index pages were listed and before its
    // manifest is loaded.
    let published = false;
    const racing: Sql = {
      query: async (text, values) => {
        if (!published && /r\.xmin::text AS version/.test(text)) {
          published = true;
          await readings.restate({ id: "rd_pending", status: "ready", updated_at: "2026-09-01T00:00:00.000Z" });
        }
        return sql.query(text, values);
      },
      execute: (text, values) => sql.execute(text, values),
      transaction: (run, opts) => sql.transaction(run, opts),
      end: () => sql.end(),
    };

    const outcome = await buildArchiveExport(racing, archiveExportEnvelopeV1({ tenantId, exportId: EXPORT_ID }), env, {
      nowMs: NOW_MS,
    });
    expect(outcome).toBe("ready");
    expect(published).toBe(true);

    const { row, entries } = await readArchive(db, bucket, env);
    const index = jsonEntry<{ items: Array<{ id: string; status: string; updated_at: string }> }>(entries, "index.json");
    for (const entry of index.items) {
      const manifest = jsonEntry<{ status: string; updated_at: string }>(entries, `readings/${entry.id}/manifest.json`);
      expect({ status: entry.status, updated_at: entry.updated_at }).toEqual({
        status: manifest.status,
        updated_at: manifest.updated_at,
      });
    }
    expect(index.items.find((entry) => entry.id === "rd_pending")?.status).toBe("ready");
    expect(row.counts).toEqual({ readings: 3, pending: 0, ready: 2, failed: 1 });
  });
});
