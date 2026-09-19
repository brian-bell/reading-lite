/**
 * `user_settings` row. GET returns the full record. POST patches
 * `notify_immediate` and any digest schedule fields present in the body.
 * Digest opt-out is `digest_cadence = off`; hour, weekday, and time zone
 * still persist when cadence is off. Immediate mail is a separate flag.
 */
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";
import type { DigestCadence, UserSettingsResponse } from "../schemas/api";
import { DigestCadenceSchema } from "../schemas/api";

interface UserSettingsDbRow {
  user_id: string;
  schema_version: number;
  notify_immediate: boolean;
  digest_cadence: string;
  time_zone: string;
  digest_hour_local: number;
  digest_weekday: number;
  created_at: string;
  updated_at: string;
}

const SETTINGS_COLUMNS = `user_id, schema_version, notify_immediate, digest_cadence,
       time_zone, digest_hour_local, digest_weekday, created_at, updated_at`;

export type UserSettingsPatch = {
  userId: string;
  nowMs: number;
  notifyImmediate: boolean;
  digestCadence?: DigestCadence;
  timeZone?: string;
  digestHourLocal?: number;
  digestWeekday?: number;
};

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

export async function updateUserSettings(
  db: ControlPlaneDb,
  input: UserSettingsPatch,
): Promise<UserSettingsResponse | null> {
  const set: string[] = ["notify_immediate = ?", "updated_at = ?"];
  const params: unknown[] = [input.notifyImmediate, toTimestamp(input.nowMs)];

  if (input.digestCadence !== undefined) {
    set.push("digest_cadence = ?");
    params.push(input.digestCadence);
  }
  if (input.timeZone !== undefined) {
    set.push("time_zone = ?");
    params.push(input.timeZone);
  }
  if (input.digestHourLocal !== undefined) {
    set.push("digest_hour_local = ?");
    params.push(input.digestHourLocal);
  }
  if (input.digestWeekday !== undefined) {
    set.push("digest_weekday = ?");
    params.push(input.digestWeekday);
  }

  params.push(input.userId);
  await db.run(`UPDATE user_settings SET ${set.join(", ")} WHERE user_id = ?`, ...params);
  return getUserSettings(db, input.userId);
}

function toResponse(row: UserSettingsDbRow): UserSettingsResponse {
  return {
    user_id: row.user_id,
    schema_version: row.schema_version,
    notify_immediate: row.notify_immediate,
    digest_cadence: DigestCadenceSchema.parse(row.digest_cadence),
    time_zone: row.time_zone,
    digest_hour_local: row.digest_hour_local,
    digest_weekday: row.digest_weekday,
    created_at_ms: fromTimestamp(row.created_at),
    updated_at_ms: fromTimestamp(row.updated_at),
  };
}
