/**
 * The digest_deliveries ledger. Unique (user_id, cadence, period_key) is the
 * idempotency key: the cron inserts pending, the consumer flips pending to
 * sent or skipped, and a redelivered job seeing sent/skipped/failed acks.
 */
import { periodDeliveryForStatus } from "../modules/digest-schedule";
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";

export type DigestDeliveryStatus = "pending" | "sent" | "skipped" | "failed";

export type DigestSkipReason =
  | "cadence_off"
  | "schedule_mismatch"
  | "invalid_time_zone"
  | "inactive_user"
  | "unverified_email"
  | "missing_user"
  | "missing_settings"
  | "allowlist"
  | "empty_from"
  | "empty_window";

export interface DigestDeliveryKey {
  userId: string;
  cadence: "daily" | "weekly";
  periodKey: string;
}

export interface DigestDeliveryRow {
  user_id: string;
  cadence: "daily" | "weekly";
  period_key: string;
  status: DigestDeliveryStatus;
  skip_reason: string | null;
  resend_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export type DigestClaimResult = "inserted" | "pending" | "terminal";

const COLUMNS = `user_id, cadence, period_key, status, skip_reason, resend_id, created_at, updated_at`;

type DigestDeliveryDbRow = Omit<DigestDeliveryRow, "created_at_ms" | "updated_at_ms"> & {
  created_at: string;
  updated_at: string;
};

export async function getDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
): Promise<DigestDeliveryRow | null> {
  const row = await db.first<DigestDeliveryDbRow>(
    `SELECT ${COLUMNS} FROM digest_deliveries
      WHERE user_id = ? AND cadence = ? AND period_key = ?`,
    key.userId,
    key.cadence,
    key.periodKey,
  );
  if (!row) return null;
  const { created_at, updated_at, ...rest } = row;
  return { ...rest, created_at_ms: fromTimestamp(created_at), updated_at_ms: fromTimestamp(updated_at) };
}

export async function claimPendingDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
  nowMs: number,
): Promise<DigestClaimResult> {
  const inserted = await db.run(
    `INSERT INTO digest_deliveries
       (user_id, cadence, period_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(user_id, cadence, period_key) DO NOTHING`,
    key.userId,
    key.cadence,
    key.periodKey,
    toTimestamp(nowMs),
    toTimestamp(nowMs),
  );
  if (inserted.changes === 1) return "inserted";
  const existing = await getDigestDelivery(db, key);
  if (existing && periodDeliveryForStatus(existing.status) === "pending") return "pending";
  return "terminal";
}

/** Drop a still-pending row so a later tick can claim the period again. */
export async function deletePendingDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
): Promise<boolean> {
  const deleted = await db.run(
    `DELETE FROM digest_deliveries
      WHERE user_id = ? AND cadence = ? AND period_key = ? AND status = 'pending'`,
    key.userId,
    key.cadence,
    key.periodKey,
  );
  return deleted.changes === 1;
}

export async function listPendingDigestDeliveries(
  db: ControlPlaneDb,
): Promise<Array<DigestDeliveryKey & { updated_at_ms: number }>> {
  const rows = await db.all<{
    user_id: string;
    cadence: "daily" | "weekly";
    period_key: string;
    updated_at: string;
  }>(
    `SELECT user_id, cadence, period_key, updated_at FROM digest_deliveries WHERE status = 'pending'`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    cadence: row.cadence,
    periodKey: row.period_key,
    updated_at_ms: fromTimestamp(row.updated_at),
  }));
}

/** Mark a still-pending row as recently re-enqueued so the next tick treats it as fresh. */
export async function touchPendingDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
  nowMs: number,
): Promise<boolean> {
  const updated = await db.run(
    `UPDATE digest_deliveries
        SET updated_at = ?
      WHERE user_id = ? AND cadence = ? AND period_key = ? AND status = 'pending'`,
    toTimestamp(nowMs),
    key.userId,
    key.cadence,
    key.periodKey,
  );
  return updated.changes === 1;
}

export function digestDeliveryKeyId(key: DigestDeliveryKey): string {
  return `${key.userId}:${key.cadence}:${key.periodKey}`;
}

export async function finalizeDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
  next:
    | { status: "sent"; resendId?: string }
    | { status: "skipped"; reason: DigestSkipReason }
    | { status: "failed" },
  nowMs: number,
): Promise<DigestDeliveryStatus> {
  const existing = await getDigestDelivery(db, key);
  if (existing?.status === "sent") return "sent";
  if (existing?.status === "skipped" || existing?.status === "failed") {
    return existing.status;
  }

  const skipReason = next.status === "skipped" ? next.reason : null;
  const resendId = next.status === "sent" ? (next.resendId ?? null) : null;
  if (existing?.status === "pending") {
    await db.run(
      `UPDATE digest_deliveries
          SET status = ?, skip_reason = ?, resend_id = ?, updated_at = ?
        WHERE user_id = ? AND cadence = ? AND period_key = ? AND status = 'pending'`,
      next.status,
      skipReason,
      resendId,
      toTimestamp(nowMs),
      key.userId,
      key.cadence,
      key.periodKey,
    );
  } else {
    await db.run(
      `INSERT INTO digest_deliveries
         (user_id, cadence, period_key, status, skip_reason, resend_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, cadence, period_key) DO NOTHING`,
      key.userId,
      key.cadence,
      key.periodKey,
      next.status,
      skipReason,
      resendId,
      toTimestamp(nowMs),
      toTimestamp(nowMs),
    );
  }
  const after = await getDigestDelivery(db, key);
  return after?.status ?? next.status;
}
