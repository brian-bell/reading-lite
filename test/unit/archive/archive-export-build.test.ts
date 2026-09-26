import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_EXPORT_MAX_CONTINUATIONS,
  ArchiveExportContinuationBudgetError,
  buildArchiveExport,
  type ArchiveExportEnv,
  type ArchiveExportJobDeps,
} from "../../../src/archive-export";
import { beginAccountDeletion } from "../../../src/control-plane/account-delete";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { archiveExportEnvelopeV1 } from "../../../src/control-plane/export-envelope";
import { parseTenantId, parseUserId } from "../../../src/control-plane/ids";
import { toTimestamp } from "../../../src/control-plane/pg-time";
import type { Sql, SqlQuery, SqlRow } from "../../../src/modules/db/sql";
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
const SECOND_EXPORT_ID = "exp_00000000-0000-4000-8000-0000000000bb";

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
  await queueExport(db, EXPORT_ID);
  return { tenantId, bucket, env, readings };
}

async function queueExport(db: ControlPlaneDb, exportId: string): Promise<void> {
  const now = toTimestamp(NOW_MS);
  await db.run(
    `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?)`,
    exportId,
    parseUserId(TENANT_ID)!,
    now,
    now,
  );
}

function envelopeFor(exportId = EXPORT_ID) {
  return archiveExportEnvelopeV1({ tenantId: parseTenantId(TENANT_ID)!, exportId });
}

// Delivers the export until it settles, as the consumer's self-sends would.
async function settle(
  sql: Sql,
  env: ArchiveExportEnv,
  deps: ArchiveExportJobDeps,
  exportId = EXPORT_ID,
): Promise<string[]> {
  const outcomes: string[] = [];
  for (let delivery = 0; delivery < 50; delivery++) {
    const outcome = await buildArchiveExport(sql, envelopeFor(exportId), env, deps);
    outcomes.push(outcome);
    if (outcome !== "continue") return outcomes;
  }
  throw new Error("export did not settle");
}

// Object keys under the export's prefix, relative to it.
async function exportObjects(bucket: R2Bucket, env: { TENANT_DATA_PLANE: string }, exportId = EXPORT_ID) {
  const content = contentStoreFor(bucket, { tenantId: parseTenantId(TENANT_ID)! }, env);
  const marker = `exports/${exportId}/`;
  return (await content.list(`exports/${exportId}`)).map((object) => object.key.slice(object.key.indexOf(marker) + marker.length)).sort();
}

async function readArchive(
  db: ControlPlaneDb,
  bucket: R2Bucket,
  env: { TENANT_DATA_PLANE: string },
  exportId = EXPORT_ID,
) {
  const row = await db.first<{
    segments: { parts: Array<{ key: string; bytes: number }>; total_bytes: number };
    counts: { readings: number; pending: number; ready: number; failed: number };
  }>("SELECT segments, counts FROM archive_exports WHERE id = ?", exportId);
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

// Runs `before` ahead of each statement, including those inside a
// transaction, and `after` once it returns.
function watchSql(
  sql: Sql,
  hooks: {
    before?: (text: string, values: readonly unknown[]) => Promise<void>;
    after?: (text: string) => Promise<void>;
  },
): Sql {
  const watch = (handle: SqlQuery): SqlQuery => ({
    query: async <Row extends SqlRow = SqlRow>(text: string, values?: unknown[]) => {
      await hooks.before?.(text, values ?? []);
      const rows = await handle.query<Row>(text, values);
      await hooks.after?.(text);
      return rows;
    },
    execute: async (text, values) => {
      await hooks.before?.(text, values ?? []);
      const changes = await handle.execute(text, values);
      await hooks.after?.(text);
      return changes;
    },
  });
  return {
    ...watch(sql),
    transaction: (run, opts) => sql.transaction((tx) => run(watch(tx)), opts),
    end: () => sql.end(),
  };
}

function jsonEntry<T>(entries: Map<string, Uint8Array>, name: string): T {
  return JSON.parse(new TextDecoder().decode(entries.get(name))) as T;
}

describe("buildArchiveExport", () => {
  it("pages every status into one zip that unzip -t accepts", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    expect((await settle(sql, env, {
      nowMs: NOW_MS,
      pageSize: 1,
    })).at(-1)).toBe("ready");

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

  it("builds one segment per delivery, each resumed from the cursor the last one committed", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    const stored: string[][] = [];
    const outcomes: string[] = [];
    for (let delivery = 0; ; delivery++) {
      // Each delivery runs later than the last; the archive keeps the first's time.
      const nowMs = NOW_MS + delivery * 60_000;
      const outcome = await buildArchiveExport(sql, envelopeFor(), env, { nowMs, segmentReadings: 1 });
      outcomes.push(outcome);
      stored.push(await exportObjects(bucket, env));
      if (outcome !== "continue") break;
    }
    expect(outcomes).toEqual(["continue", "continue", "continue", "ready"]);
    // README.md rides with the first reading; the last delivery adds the
    // closing files, the joined central directory, and the EOCD.
    const segment = (number: string) => [`segments/segment-${number}`, `segments/state-${number}.json`];
    expect(stored).toEqual(
      [
        segment("0001"),
        [...segment("0001"), ...segment("0002")],
        [...segment("0001"), ...segment("0002"), ...segment("0003")],
        ["central", "eocd", ...segment("0001"), ...segment("0002"), ...segment("0003"), "segments/segment-0004"],
      ].map((keys) => keys.sort()),
    );
    const { row, entries } = await readArchive(db, bucket, env);
    expect(jsonEntry<{ generated_at: string }>(entries, "export.json").generated_at).toBe(new Date(NOW_MS).toISOString());
    expect(row.segments.parts.map((part) => part.key.slice(part.key.indexOf("exports/")))).toEqual([
      ...["0001", "0002", "0003", "0004"].map((number) => `exports/${EXPORT_ID}/segments/segment-${number}`),
      `exports/${EXPORT_ID}/central`,
      `exports/${EXPORT_ID}/eocd`,
    ]);
    const counted = await db.first<{ continuations: number }>(
      "SELECT continuations FROM archive_exports WHERE id = ?",
      EXPORT_ID,
    );
    expect(counted?.continuations).toBe(3);
  });

  it("writes the same archive in one-reading segments as in one segment", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    expect(await settle(sql, env, { nowMs: NOW_MS })).toEqual(["continue", "ready"]);
    const whole = await readArchive(db, bucket, env);

    await queueExport(db, SECOND_EXPORT_ID);
    expect((await settle(sql, env, { nowMs: NOW_MS, segmentReadings: 1 }, SECOND_EXPORT_ID)).at(-1)).toBe("ready");
    const split = await readArchive(db, bucket, env, SECOND_EXPORT_ID);

    expect(whole.row.segments.parts).toHaveLength(4);
    expect(split.row.segments.parts).toHaveLength(6);
    expect(split.entries).toEqual(whole.entries);
    const dir = mkdtempSync(join(tmpdir(), "archive-export-"));
    const path = join(dir, "archive.zip");
    writeFileSync(path, split.zip);
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toMatch(/No errors detected/);
  });

  it("resumes a delivery killed after its R2 write and before its commit, without duplicate entries", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    let commits = 0;
    const killing = watchSql(sql, {
      before: async (text) => {
        if (!/SET cursor = /.test(text)) return;
        commits += 1;
        if (commits === 2) throw new Error("delivery killed");
      },
    });
    const deps = { nowMs: NOW_MS, segmentReadings: 1 };
    expect(await buildArchiveExport(killing, envelopeFor(), env, deps)).toBe("continue");
    await expect(buildArchiveExport(killing, envelopeFor(), env, deps)).rejects.toThrow("delivery killed");
    // Its segment reached R2; the cursor still points before it.
    expect(await exportObjects(bucket, env)).toContain("segments/segment-0002");
    expect((await settle(killing, env, deps)).at(-1)).toBe("ready");

    const { row, zip, entries } = await readArchive(db, bucket, env);
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
    // The redelivery rewrote the same key; nothing is left beside the parts.
    const partKeys = row.segments.parts.map((part) => part.key.slice(part.key.indexOf(`${EXPORT_ID}/`) + EXPORT_ID.length + 1));
    const states = (await exportObjects(bucket, env)).filter((key) => key.startsWith("segments/state-"));
    expect(await exportObjects(bucket, env)).toEqual([...partKeys, ...states].sort());
    const dir = mkdtempSync(join(tmpdir(), "archive-export-"));
    const path = join(dir, "archive.zip");
    writeFileSync(path, zip);
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toMatch(/No errors detected/);
  });

  it("stands down when a later delivery took the lease, leaving the cursor where it was", async () => {
    const { db, sql } = openControlPlane();
    const { env } = await arrange(sql, db);
    let taken = false;
    const racing = watchSql(sql, {
      before: async (text) => {
        if (taken || !/SET cursor = /.test(text)) return;
        taken = true;
        await sql.query("UPDATE archive_exports SET lease_seq = lease_seq + 1 WHERE id = $1", [EXPORT_ID]);
      },
    });
    expect(await buildArchiveExport(racing, envelopeFor(), env, { nowMs: NOW_MS })).toBe("lease_held");
    const row = await db.first<{ status: string; cursor: unknown; continuations: number }>(
      "SELECT status, cursor, continuations FROM archive_exports WHERE id = ?",
      EXPORT_ID,
    );
    expect(row).toEqual({ status: "building", cursor: null, continuations: 0 });
    expect((await settle(sql, env, { nowMs: NOW_MS })).at(-1)).toBe("ready");
  });

  it("cancels a build whose account left active between deliveries and deletes the segments it wrote", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    expect(await buildArchiveExport(sql, envelopeFor(), env, { nowMs: NOW_MS, segmentReadings: 1 })).toBe("continue");
    expect(await exportObjects(bucket, env)).not.toEqual([]);
    await db.run("UPDATE users SET status = 'deleting' WHERE id = ?", TENANT_ID);

    expect(await buildArchiveExport(sql, envelopeFor(), env, { nowMs: NOW_MS, segmentReadings: 1 })).toBe("cancelled");
    expect(await exportObjects(bucket, env)).toEqual([]);
    const row = await db.first<{ status: string }>("SELECT status FROM archive_exports WHERE id = ?", EXPORT_ID);
    expect(row?.status).toBe("cancelled");
  });

  // Deletion starts while a delivery packs, after its claim saw the account
  // active: the recheck before its R2 writes stops it writing anything and
  // drops the segment an earlier delivery wrote.
  it("writes no segment when deletion starts while a delivery packs", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    const deps = { nowMs: NOW_MS, segmentReadings: 1 };
    expect(await buildArchiveExport(sql, envelopeFor(), env, deps)).toBe("continue");
    expect(await exportObjects(bucket, env)).not.toEqual([]);
    let armed = true;
    const deleting = watchSql(sql, {
      before: async (text) => {
        if (!armed || text !== "SELECT status FROM users WHERE id = $1") return;
        armed = false;
        await beginAccountDeletion(db, { userId: TENANT_ID, nowMs: NOW_MS + 1 });
      },
    });

    expect(await buildArchiveExport(deleting, envelopeFor(), env, deps)).toBe("cancelled");
    expect(armed).toBe(false);
    expect(await exportObjects(bucket, env)).toEqual([]);
    const row = await db.first<{ status: string }>("SELECT status FROM archive_exports WHERE id = ?", EXPORT_ID);
    expect(row?.status).toBe("cancelled");
  });

  it("keeps building past 600 continuations, which one-reading segments of compressible text reach inside ZIP32", async () => {
    const { db, sql } = openControlPlane();
    const { env } = await arrange(sql, db);
    const deps = { nowMs: NOW_MS, segmentReadings: 1 };
    expect(await buildArchiveExport(sql, envelopeFor(), env, deps)).toBe("continue");
    await db.run("UPDATE archive_exports SET continuations = 600 WHERE id = ?", EXPORT_ID);
    expect((await settle(sql, env, deps)).at(-1)).toBe("ready");
  });

  it("refuses to continue past the continuation budget", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env } = await arrange(sql, db);
    await db.run(
      "UPDATE archive_exports SET continuations = ? WHERE id = ?",
      ARCHIVE_EXPORT_MAX_CONTINUATIONS,
      EXPORT_ID,
    );
    await expect(buildArchiveExport(sql, envelopeFor(), env, { nowMs: NOW_MS })).rejects.toBeInstanceOf(
      ArchiveExportContinuationBudgetError,
    );
    expect(await exportObjects(bucket, env)).toEqual([]);
  });

  it("ships an unpublished attempt's raw bytes under their stored type, without comparing them to the placeholder", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env, readings } = await arrange(sql, db);
    // rd_pending carries the pending draft's empty-content placeholder,
    // application/octet-stream included; its running attempt has already
    // stored raw bytes with the type it fetched.
    await sql.query(
      "UPDATE readings SET content_type = 'application/octet-stream' WHERE tenant_id = $1 AND id = 'rd_pending'",
      [TENANT_ID],
    );
    const html = new TextEncoder().encode("<p>Captured mid-attempt.</p>");
    const rawKey = "readings/pending/revisions/at_running/raw.html";
    await readings.content.put(rawKey, html, "text/html; charset=utf-8");
    await sql.query(
      `INSERT INTO reading_attempts (tenant_id, reading_id, id, trigger, status, started_at, raw_key)
       VALUES ($1, 'rd_pending', 'at_running', 'submit', 'running', $2, $3)`,
      [TENANT_ID, toTimestamp(NOW_MS), rawKey],
    );

    expect((await settle(sql, env, {
      nowMs: NOW_MS,
    })).at(-1)).toBe("ready");
    const { entries } = await readArchive(db, bucket, env);
    expect(entries.get("readings/rd_pending/raw.html")).toEqual(html);
    const report = jsonEntry<{ warnings: Array<{ reading_id: string }> }>(entries, "report.json");
    expect(report.warnings.filter((warning) => warning.reading_id === "rd_pending")).toEqual([]);
  });

  it("fails a build the zip format cannot hold and deletes the parts already written", async () => {
    const { db, sql } = openControlPlane();
    const { tenantId, bucket, env } = await arrange(sql, db);
    const content = contentStoreFor(bucket, { tenantId }, env);
    // Left by an earlier delivery of the same export.
    await content.put(`exports/${EXPORT_ID}/segments/segment-0001`, new Uint8Array([1, 2, 3]), "application/octet-stream");

    // DOS timestamps start in 1980, so the first segment is refused.
    expect(await settle(sql, env, { nowMs: Date.parse("1979-12-31T00:00:00.000Z") })).toEqual(["failed"]);
    expect(await content.list(`exports/${EXPORT_ID}`)).toEqual([]);
    const row = await db.first<{ status: string; error: { code: string } }>(
      "SELECT status, error FROM archive_exports WHERE id = ?",
      EXPORT_ID,
    );
    expect(row).toMatchObject({ status: "failed", error: { code: "zip_limit" } });
  });

  it("keeps index.json and counts on the manifest a reading had when it was loaded", async () => {
    const { db, sql } = openControlPlane();
    const { bucket, env, readings } = await arrange(sql, db);
    // rd_pending publishes after the index pages were listed and before its
    // manifest is loaded.
    let published = false;
    const racing = watchSql(sql, {
      after: async (text) => {
        if (published || !/FROM readings\s+WHERE tenant_id = \$1\s+ORDER BY created_at DESC/.test(text)) return;
        published = true;
        await readings.restate({ id: "rd_pending", status: "ready", updated_at: "2026-09-01T00:00:00.000Z" });
      },
    });

    expect((await settle(racing, env, { nowMs: NOW_MS })).at(-1)).toBe("ready");
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
    const { bucket, env, readings } = await arrange(sql, db);
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

    expect((await settle(sql, env, {
      nowMs: NOW_MS,
    })).at(-1)).toBe("ready");
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
