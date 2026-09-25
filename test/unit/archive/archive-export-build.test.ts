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

const FORBIDDEN_KEYS = new Set([
  "key_prefix",
  "raw_key",
  "extracted_key",
  "events",
  "checkpoint",
  "embedding",
  "vector",
  "credential",
  "credentials",
  "api_key",
  "secret",
  "secret_hmac",
  "session",
  "sessions",
  "token",
  "tokens",
  "spend",
  "quota",
]);

const FORBIDDEN_SEGMENT =
  /^(attempts|processing|checkpoints?|embeddings?|vectors?|credentials?|sessions?|tokens?|spend|quota|key_prefix)$/i;

function forbiddenKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeys(item, `${path}[${index}]`, found));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) found.push(`${path}.${key}`);
    forbiddenKeys(child, `${path}.${key}`, found);
  }
}
import { useControlPlane } from "../../helpers/control-plane-pg";
import { memoryBucket, NODE_HYPERDRIVE } from "../../helpers/node-readings";
import { expectChecksums, readZipEntries } from "../../helpers/read-zip";
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
      "README.md",
      "checksums.sha256",
      "export.json",
      "index.json",
      "readings/rd_failed/manifest.json",
      "readings/rd_pending/manifest.json",
      "readings/rd_ready/manifest.json",
      "report.json",
    ]);
    await expectChecksums(entries);
    expect(new TextDecoder().decode(entries.get("README.md"))).toContain("format_version: 1");
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

  it("leaves attempt logs, checkpoints, vectors, keys, credentials, sessions, tokens, and quota out", async () => {
    const { db, sql } = openControlPlane();
    const { tenantId, bucket, env, readings } = await arrange(sql, db);
    const now = toTimestamp(NOW_MS);
    const eventMarker = "mxwx2-attempt-event-7f3a9c1e";
    const checkpointMarker = "mxwx2-checkpoint-7f3a9c1e";
    const keyMarker = "mxwx2-internal-key-7f3a9c1e";
    const jobMarker = "mxwx2-job-payload-7f3a9c1e";
    const tokenMarker = "mxwx2-token-hmac-7f3a9c1e";
    const sessionMarker = "mxwx2-session-hmac-7f3a9c1e";
    const quotaMarker = "424242424242";
    await sql.query(
      `UPDATE readings SET last_attempt = $3::jsonb WHERE tenant_id = $1 AND id = $2`,
      [
        TENANT_ID,
        "rd_ready",
        JSON.stringify({
          id: "at_public",
          trigger: "submit",
          status: "succeeded",
          started_at: "2026-02-01T00:00:00.000Z",
        }),
      ],
    );
    await sql.query(
      `INSERT INTO reading_attempts (
         tenant_id, reading_id, id, trigger, status, started_at, events, checkpoint, raw_key, extracted_key
       ) VALUES ($1, 'rd_ready', 'at_mxwx2secret', 'submit', 'succeeded', $2, $3::jsonb, $4::jsonb, $5, $6)`,
      [
        TENANT_ID,
        now,
        JSON.stringify([{ stage: "fetch_source", status: "succeeded", at: "2026-02-01T00:00:01.000Z", note: eventMarker }]),
        JSON.stringify({ summarize: checkpointMarker }),
        `readings/hidden/${keyMarker}/raw.html`,
        `readings/hidden/${keyMarker}/extracted.md`,
      ],
    );
    await sql.query(
      `INSERT INTO reading_jobs (tenant_id, reading_id, attempt_id, state, payload, created_at, updated_at)
       VALUES ($1, 'rd_ready', 'at_mxwx2secret', 'done', $2::jsonb, $3, $3)`,
      [TENANT_ID, JSON.stringify({ leak: jobMarker }), now],
    );
    await readings.putEmbedding("rd_ready", Array.from({ length: 1536 }, (_, index) => (index === 0 ? 0.271828182845 : 0)));
    await db.run(
      `INSERT INTO api_tokens (id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at)
       VALUES ('tok_mxwx2excl', ?, 'ops', 'standard', ?, 1, ?, ?)`,
      TENANT_ID,
      tokenMarker,
      now,
      now,
    );
    await db.run(
      `INSERT INTO sessions (
         id, user_id, secret_hmac, hash_key_version, created_at, authenticated_at, last_seen_at,
         idle_expires_at, absolute_expires_at, created_from_claim_id
       ) VALUES ('ses_mxwx2excl', ?, ?, 1, ?, ?, ?, ?, ?, 'mxwx2-claim')`,
      TENANT_ID,
      sessionMarker,
      now,
      now,
      now,
      now,
      now,
    );
    await db.run(
      `INSERT INTO tenant_limits (
         tenant_id, policy_version, submissions_per_hour, monthly_readings, max_concurrent_work,
         daily_spend_microdollars, created_at, updated_at
       ) VALUES (?, 1, 3, 40, 1, ?, ?, ?)`,
      TENANT_ID,
      quotaMarker,
      now,
      now,
    );

    const outcome = await buildArchiveExport(sql, archiveExportEnvelopeV1({ tenantId, exportId: EXPORT_ID }), env, {
      nowMs: NOW_MS,
    });
    expect(outcome).toBe("ready");
    const { entries } = await readArchive(db, bucket, env);
    const archive = [...entries.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    for (const marker of [eventMarker, checkpointMarker, keyMarker, jobMarker, tokenMarker, sessionMarker, quotaMarker, "0.271828182845"]) {
      expect(archive, marker).not.toContain(marker);
    }
    for (const name of entries.keys()) {
      for (const segment of name.split("/")) expect(segment, name).not.toMatch(FORBIDDEN_SEGMENT);
    }

    const index = jsonEntry<{ items: Array<{ id: string; key_prefix: string }> }>(entries, "index.json");
    expect(index.items.map((item) => item.key_prefix).every((prefix) => prefix.length > 0)).toBe(true);
    const leaked: string[] = [];
    for (const [name, bytes] of entries) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      forbiddenKeys(JSON.parse(new TextDecoder().decode(bytes)) as unknown, name, leaked);
      for (const item of index.items) {
        expect(new TextDecoder().decode(bytes), name).not.toContain(item.key_prefix);
      }
    }
    expect(leaked).toEqual([]);
    const ready = jsonEntry<{ last_attempt?: { id: string }; events?: unknown }>(entries, "readings/rd_ready/manifest.json");
    expect(ready.last_attempt?.id).toBe("at_public");
    expect(ready.events).toBeUndefined();
  });
});
