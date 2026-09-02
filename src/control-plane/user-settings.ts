import type { ControlPlaneDb } from "./db";
import type { UserSettingsResponse } from "../schemas/api";
import { DigestCadenceSchema } from "../schemas/api";

interface UserSettingsDbRow {
  user_id: string;
  schema_version: number;
  notify_immediate: number;
  digest_cadence: string;
  time_zone: string;
  digest_hour_local: number;
  digest_weekday: number;
  created_at_ms: number;
  updated_at_ms: number;
}

const SETTINGS_COLUMNS = `user_id, schema_version, notify_immediate, digest_cadence,
       time_zone, digest_hour_local, digest_weekday, created_at_ms, updated_at_ms`;

export async function getUserSettings(
  db: ControlPlaneDb,
  userId: string,
): Promise<UserSettingsResponse | null> {
  const row = await db.first<UserSettingsDbRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM user_settings WHERE user_id = ?`,
    userId,
  );
  return row ? toResponse(row) : null;
}

export async function updateNotifyImmediate(
  db: ControlPlaneDb,
  input: { userId: string; notifyImmediate: boolean; nowMs: number },
): Promise<UserSettingsResponse | null> {
  await db.run(
    `UPDATE user_settings SET notify_immediate = ?, updated_at_ms = ? WHERE user_id = ?`,
    input.notifyImmediate ? 1 : 0,
    input.nowMs,
    input.userId,
  );
  return getUserSettings(db, input.userId);
}

function toResponse(row: UserSettingsDbRow): UserSettingsResponse {
  return {
    user_id: row.user_id,
    schema_version: row.schema_version,
    notify_immediate: row.notify_immediate === 1,
    digest_cadence: DigestCadenceSchema.parse(row.digest_cadence),
    time_zone: row.time_zone,
    digest_hour_local: row.digest_hour_local,
    digest_weekday: row.digest_weekday,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}
