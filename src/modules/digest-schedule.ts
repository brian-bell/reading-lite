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
    if (hour === 24) hour = 0;
    if (![year, month, day, hour].every((n) => Number.isInteger(n))) return null;
    if (hour < 0 || hour > 23) return null;
    const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, hour, isoWeekday: WEEKDAY_FROM_JS[jsDay]! };
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

export function digestDueAt(settings: DigestScheduleSettings, now: Date): DigestDue {
  if (settings.digest_cadence !== "daily" && settings.digest_cadence !== "weekly") {
    return { due: false, reason: "cadence_off" };
  }
  const local = localCivilTime(now, settings.time_zone);
  if (!local) return { due: false, reason: "invalid_time_zone" };
  if (local.hour !== settings.digest_hour_local) return { due: false, reason: "hour_mismatch" };
  if (settings.digest_cadence === "weekly" && local.isoWeekday !== settings.digest_weekday) {
    return { due: false, reason: "weekday_mismatch" };
  }
  return {
    due: true,
    cadence: settings.digest_cadence,
    period_key: periodKeyFor(settings.digest_cadence, local),
    local,
  };
}
