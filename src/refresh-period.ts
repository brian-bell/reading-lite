const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Cron weekday 0 is Sunday. An ISO week starts on Monday and would grant a second budget the next day.
const REFRESH_SCHEDULE = {
  minute: 7,
  hour: 3,
  sunday: 0,
} as const;

export const REFRESH_CRON = `${REFRESH_SCHEDULE.minute} ${REFRESH_SCHEDULE.hour} * * ${REFRESH_SCHEDULE.sunday}` as const;

type RefreshPeriod = { readonly startsAtMs: number };

function refreshPeriod(atMs: number): RefreshPeriod {
  const at = new Date(atMs);
  const daysBack = (at.getUTCDay() - REFRESH_SCHEDULE.sunday + 7) % 7;
  const boundary = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() - daysBack,
    REFRESH_SCHEDULE.hour,
    REFRESH_SCHEDULE.minute,
    0,
    0,
  );
  return { startsAtMs: atMs < boundary ? boundary - WEEK_MS : boundary };
}

function refreshInstantMs(iso: string): number {
  // Date.parse accepts a date-only prefix and rolls 2026-02-31 into March.
  // Either would look like a real instant and skip or mint a week.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(iso);
  if (!match) throw new RangeError(`unparseable refresh instant ${iso}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = Number(match[7] ?? "0");
  const atMs = Date.UTC(year, month, day, hour, minute, second, ms);
  const at = new Date(atMs);
  if (
    at.getUTCFullYear() !== year || at.getUTCMonth() !== month || at.getUTCDate() !== day ||
    at.getUTCHours() !== hour || at.getUTCMinutes() !== minute || at.getUTCSeconds() !== second ||
    at.getUTCMilliseconds() !== ms
  ) {
    throw new RangeError(`unparseable refresh instant ${iso}`);
  }
  return atMs;
}

export function opensNewRefreshBudget(nowIso: string, budgetAtIso: string): boolean {
  return refreshPeriod(refreshInstantMs(nowIso)).startsAtMs > refreshPeriod(refreshInstantMs(budgetAtIso)).startsAtMs;
}
