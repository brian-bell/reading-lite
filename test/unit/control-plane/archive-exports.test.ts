import { describe, expect, it } from "vitest";
import { isExportDlq, isExportQueue } from "../../../src/archive-export";
import {
  ARCHIVE_EXPORT_DAILY_WINDOW_MS,
  requestArchiveExport,
} from "../../../src/control-plane/archive-exports";
import { parseUserId } from "../../../src/control-plane/ids";
import { toTimestamp } from "../../../src/control-plane/pg-time";
import { useControlPlane } from "../../helpers/control-plane-pg";

const openControlPlane = useControlPlane();

const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const USER = parseUserId("usr_770e8400-e29b-41d4-a716-446655440000")!;
const EMAIL = "export-admission@test.example";

function uuidAt(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

async function seeded(status: "active" | "deleting" = "active") {
  const { db } = openControlPlane();
  const now = toTimestamp(NOW_MS);
  await db.run(
    `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    USER,
    EMAIL,
    EMAIL,
    status,
    now,
    now,
  );
  return db;
}

describe("requestArchiveExport", () => {
  it("refuses a user who is not active and writes no row", async () => {
    const db = await seeded("deleting");
    await expect(requestArchiveExport(db, { userId: USER, nowMs: NOW_MS, newUuid: () => uuidAt(1) })).resolves.toEqual({
      kind: "inactive",
    });
    expect(await db.first("SELECT id FROM archive_exports WHERE tenant_id = ?", USER)).toBeNull();
  });

  it("returns 409's active id while a queued or building export holds the slot", async () => {
    const db = await seeded();
    const queued = await requestArchiveExport(db, { userId: USER, nowMs: NOW_MS, newUuid: () => uuidAt(1) });
    expect(queued).toEqual({ kind: "queued", id: `exp_${uuidAt(1)}` });
    const again = await requestArchiveExport(db, { userId: USER, nowMs: NOW_MS + 1, newUuid: () => uuidAt(2) });
    expect(again).toEqual({ kind: "active", id: `exp_${uuidAt(1)}` });

    await db.run("UPDATE archive_exports SET status = 'building' WHERE id = ?", `exp_${uuidAt(1)}`);
    const building = await requestArchiveExport(db, { userId: USER, nowMs: NOW_MS + 2, newUuid: () => uuidAt(3) });
    expect(building).toEqual({ kind: "active", id: `exp_${uuidAt(1)}` });
  });

  it("returns the daily reset when a counted request is inside the rolling day", async () => {
    const db = await seeded();
    await requestArchiveExport(db, { userId: USER, nowMs: NOW_MS, newUuid: () => uuidAt(1) });
    await db.run("UPDATE archive_exports SET status = 'ready' WHERE id = ?", `exp_${uuidAt(1)}`);
    const limited = await requestArchiveExport(db, {
      userId: USER,
      nowMs: NOW_MS + 60_000,
      newUuid: () => uuidAt(2),
    });
    expect(limited).toEqual({ kind: "daily", resetAtMs: NOW_MS + ARCHIVE_EXPORT_DAILY_WINDOW_MS });
  });

  it.each(["failed", "cancelled", "expired"] as const)("allows another request after a %s export", async (status) => {
    const db = await seeded();
    await requestArchiveExport(db, { userId: USER, nowMs: NOW_MS, newUuid: () => uuidAt(1) });
    await db.run("UPDATE archive_exports SET status = ? WHERE id = ?", status, `exp_${uuidAt(1)}`);
    const next = await requestArchiveExport(db, {
      userId: USER,
      nowMs: NOW_MS + 60_000,
      newUuid: () => uuidAt(2),
    });
    expect(next).toEqual({ kind: "queued", id: `exp_${uuidAt(2)}` });
  });

  it("allows another counted request once the rolling day has passed", async () => {
    const db = await seeded();
    await requestArchiveExport(db, { userId: USER, nowMs: NOW_MS, newUuid: () => uuidAt(1) });
    await db.run("UPDATE archive_exports SET status = 'ready' WHERE id = ?", `exp_${uuidAt(1)}`);
    const next = await requestArchiveExport(db, {
      userId: USER,
      nowMs: NOW_MS + ARCHIVE_EXPORT_DAILY_WINDOW_MS,
      newUuid: () => uuidAt(2),
    });
    expect(next).toEqual({ kind: "queued", id: `exp_${uuidAt(2)}` });
  });
});

describe("export queue names", () => {
  it("matches the staging and production queues and nothing else", () => {
    expect(isExportQueue("reading-lite-export")).toBe(true);
    expect(isExportQueue("reading-lite-staging-export")).toBe(true);
    expect(isExportQueue("reading-lite")).toBe(false);
    expect(isExportDlq("reading-lite-export-dlq")).toBe(true);
    expect(isExportDlq("reading-lite-staging-export-dlq")).toBe(true);
    expect(isExportDlq("reading-lite-export")).toBe(false);
  });
});
