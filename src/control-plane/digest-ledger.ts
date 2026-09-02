/**
 * D1 digest_deliveries CAS. Unique (user_id, cadence, period_key) is the
 * idempotency key: the cron inserts pending, the consumer flips pending to
 * sent or skipped, and a redelivered job seeing sent/skipped/failed acks.
 */
import type { ControlPlaneDb } from "./db";

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
  | "empty_from";

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
  created_at_ms: number;
  updated_at_ms: number;
}

export type DigestClaimResult = "inserted" | "pending" | "terminal";

const COLUMNS = `user_id, cadence, period_key, status, skip_reason, created_at_ms, updated_at_ms`;

export async function getDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
): Promise<DigestDeliveryRow | null> {
  return db.first<DigestDeliveryRow>(
    `SELECT ${COLUMNS} FROM digest_deliveries
      WHERE user_id = ? AND cadence = ? AND period_key = ?`,
    key.userId,
    key.cadence,
    key.periodKey,
  );
}

export async function claimPendingDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
  nowMs: number,
): Promise<DigestClaimResult> {
  const inserted = await db.run(
    `INSERT INTO digest_deliveries
       (user_id, cadence, period_key, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(user_id, cadence, period_key) DO NOTHING`,
    key.userId,
    key.cadence,
    key.periodKey,
    nowMs,
    nowMs,
  );
  if (inserted.changes === 1) return "inserted";
  const existing = await getDigestDelivery(db, key);
  if (existing?.status === "pending") return "pending";
  return "terminal";
}

export async function finalizeDigestDelivery(
  db: ControlPlaneDb,
  key: DigestDeliveryKey,
  next: { status: "sent" } | { status: "skipped"; reason: DigestSkipReason } | { status: "failed" },
  nowMs: number,
): Promise<DigestDeliveryStatus> {
  const existing = await getDigestDelivery(db, key);
  if (existing?.status === "sent") return "sent";
  if (existing?.status === "skipped" || existing?.status === "failed") {
    return existing.status;
  }

  const skipReason = next.status === "skipped" ? next.reason : null;
  if (existing?.status === "pending") {
    await db.run(
      `UPDATE digest_deliveries
          SET status = ?, skip_reason = ?, updated_at_ms = ?
        WHERE user_id = ? AND cadence = ? AND period_key = ? AND status = 'pending'`,
      next.status,
      skipReason,
      nowMs,
      key.userId,
      key.cadence,
      key.periodKey,
    );
  } else {
    await db.run(
      `INSERT INTO digest_deliveries
         (user_id, cadence, period_key, status, skip_reason, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, cadence, period_key) DO NOTHING`,
      key.userId,
      key.cadence,
      key.periodKey,
      next.status,
      skipReason,
      nowMs,
      nowMs,
    );
  }
  const after = await getDigestDelivery(db, key);
  return after?.status ?? next.status;
}
