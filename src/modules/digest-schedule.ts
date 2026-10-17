/**
 * Digest due math: local civil time, period_key, and the hour/weekday match
 * the cron uses. Time zones are IANA names (`isIanaTimeZone`). Invalid stored
 * TZ cannot be converted — callers skip rather than guessing UTC.
 *
 * period_key is local, not UTC: daily `YYYY-MM-DD`, weekly ISO week `YYYY-Www`
 * (Monday=1). DST: a missing local hour never matches, so that day is skipped;
 * a repeated hour shares a period_key, so the delivery ledger is what stops a
 * second send.
 */
import { isIanaTimeZone } from "./time-zone";

export type DigestEnabledCadence = "daily" | "weekly";

export interface LocalCivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number;
}

export interface DigestScheduleSettings {
  digest_cadence: string;
  time_zone: string;
  digest_hour_local: number;
  digest_weekday: number;
}

export type DigestDue =
  | { due: true; cadence: DigestEnabledCadence; period_key: string; local: LocalCivilTime }
  | {
      due: false;
      reason: "cadence_off" | "invalid_time_zone" | "hour_mismatch" | "weekday_mismatch";
    };

const WEEKDAY_FROM_JS: readonly number[] = [7, 1, 2, 3, 4, 5, 6];

export function localCivilTime(now: Date, timeZone: string): LocalCivilTime | null {
  if (!isIanaTimeZone(timeZone)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((entry) => entry.type === type)?.value;
      return part === undefined ? Number.NaN : Number(part);
    };
    const year = value("year");
    const month = value("month");
    const day = value("day");
    let hour = value("hour");
    const minute = value("minute");
    const second = value("second");
    if (hour === 24) hour = 0;
    if (![year, month, day, hour, minute, second].every((n) => Number.isInteger(n))) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      return null;
    }
    const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, hour, minute, second, isoWeekday: WEEKDAY_FROM_JS[jsDay]! };
  } catch {
    return null;
  }
}

export function isoWeekPeriodKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoWeekday = WEEKDAY_FROM_JS[date.getUTCDay()]!;
  date.setUTCDate(date.getUTCDate() + 4 - isoWeekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function periodKeyFor(cadence: DigestEnabledCadence, local: LocalCivilTime): string {
  if (cadence === "daily") {
    return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  }
  return isoWeekPeriodKey(local.year, local.month, local.day);
}

/**
 * Current local period: cadence + civil date/week in the stored TZ.
 * Does not consult hour or weekday — those gate first-due enqueue only.
 * Send-time re-read and leftover-pending fan-out use this so a job claimed
 * for today/this week can still move after the due hour.
 */
export function currentPeriodKey(
  settings: DigestScheduleSettings,
  now: Date,
):
  | { ok: true; cadence: DigestEnabledCadence; period_key: string; local: LocalCivilTime }
  | { ok: false; reason: "cadence_off" | "invalid_time_zone" } {
  if (settings.digest_cadence !== "daily" && settings.digest_cadence !== "weekly") {
    return { ok: false, reason: "cadence_off" };
  }
  const local = localCivilTime(now, settings.time_zone);
  if (!local) return { ok: false, reason: "invalid_time_zone" };
  return {
    ok: true,
    cadence: settings.digest_cadence,
    period_key: periodKeyFor(settings.digest_cadence, local),
    local,
  };
}

export function digestDueAt(settings: DigestScheduleSettings, now: Date): DigestDue {
  const current = currentPeriodKey(settings, now);
  if (!current.ok) return { due: false, reason: current.reason };
  if (current.local.hour !== settings.digest_hour_local) {
    return { due: false, reason: "hour_mismatch" };
  }
  if (current.cadence === "weekly" && current.local.isoWeekday !== settings.digest_weekday) {
    return { due: false, reason: "weekday_mismatch" };
  }
  return {
    due: true,
    cadence: current.cadence,
    period_key: current.period_key,
    local: current.local,
  };
}

/**
 * The first local `digest_hour_local`:00 strictly after `now` that
 * `digestDueAt` accepts, so it agrees with the cron by construction. A day
 * whose due hour falls in a DST gap is skipped, as the cron skips it. When the
 * hour repeats, the cron sends in the first one, and
 * `zonedLocalTimeToUtcMs` resolves to the second. Null when the digest is off
 * or the time zone is invalid.
 */
export function nextDigestSendAt(settings: DigestScheduleSettings, now: Date): Date | null {
  const current = currentPeriodKey(settings, now);
  if (!current.ok) return null;
  const { local } = current;
  const due = (ms: number) => ms > now.getTime() && digestDueAt(settings, new Date(ms)).due;
  for (let delta = 0; delta <= 8; delta++) {
    const day = addUtcCalendarDays(local.year, local.month, local.day, delta);
    const ms = zonedLocalTimeToUtcMs(settings.time_zone, day.year, day.month, day.day, settings.digest_hour_local, 0, 0);
    if (ms === null) continue;
    if (due(ms - 3_600_000)) return new Date(ms - 3_600_000);
    if (due(ms)) return new Date(ms);
  }
  return null;
}

export interface DigestWindow {
  startMs: number;
  endMs: number;
}

/**
 * Local reading window ending at `now`. Daily is the 24 local hours ending on
 * this local civil time (hour, minute, and second); weekly is the last 7 local
 * days. First enable therefore cannot dump the corpus. Start is exclusive so a
 * reading at the previous send instant does not appear twice.
 */
export function digestWindow(
  cadence: DigestEnabledCadence,
  timeZone: string,
  now: Date,
): DigestWindow | null {
  const local = localCivilTime(now, timeZone);
  if (!local) return null;
  const days = cadence === "weekly" ? 7 : 1;
  const startDate = addUtcCalendarDays(local.year, local.month, local.day, -days);
  const startMs =
    zonedLocalTimeToUtcMs(
      timeZone,
      startDate.year,
      startDate.month,
      startDate.day,
      local.hour,
      local.minute,
      local.second,
    ) ?? now.getTime() - days * 86_400_000;
  return { startMs, endMs: now.getTime() };
}

export function zonedLocalTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (!isIanaTimeZone(timeZone)) return null;
  const targetKey = civilTimeKey(year, month, day, hour, minute, second);
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let i = 0; i < 8; i++) {
    const local = localCivilTime(new Date(utc), timeZone);
    if (!local) return null;
    if (
      civilTimeKey(local.year, local.month, local.day, local.hour, local.minute, local.second) ===
      targetKey
    ) {
      return utc;
    }
    utc +=
      Date.UTC(year, month - 1, day, hour, minute, second) -
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  }
  return null;
}

function addUtcCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function civilTimeKey(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  return `${year}-${month}-${day}-${hour}-${minute}-${second}`;
}
