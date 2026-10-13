const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Cron weekday 0 is Sunday. An ISO week starts on Monday and would grant a second budget the next day.
const REFRESH_SCHEDULE = {
  minute: 7,
  hour: 3,
  sunday: 0,
} as const;

export const REFRESH_CRON = `${REFRESH_SCHEDULE.minute} ${REFRESH_SCHEDULE.hour} * * ${REFRESH_SCHEDULE.sunday}` as const;

/** Latest Sunday 03:07:00.000 UTC at or before the instant. */
type RefreshPeriod = { readonly startsAtMs: number };

function refreshPeriod(atMs: number): RefreshPeriod {
  const at = new Date(atMs);
  const daysBack = (at.getUTCDay() - REFRESH_SCHEDULE.sunday + 7) % 7;
  // Equal to the boundary opens the period. One millisecond earlier stays on the previous Sunday.
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

export function opensNewRefreshBudget(nowIso: string, budgetAtIso: string): boolean {
  const nowMs = Date.parse(nowIso);
  const budgetMs = Date.parse(budgetAtIso);
  // Returning false for a bad string would skip a week.
  if (Number.isNaN(nowMs)) throw new RangeError(`unparseable refresh instant ${nowIso}`);
  if (Number.isNaN(budgetMs)) throw new RangeError(`unparseable refresh instant ${budgetAtIso}`);
  return refreshPeriod(nowMs).startsAtMs > refreshPeriod(budgetMs).startsAtMs;
}
