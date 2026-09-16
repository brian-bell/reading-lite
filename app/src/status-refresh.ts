// The status refresh contract's timing and stop rules (acceptance matrix,
// Status refresh contract), with no React and no clock of its own, so the
// reading page (#406) and the library's active-row refresh (#409) read one
// definition of the schedule, the cap, and the failure stop.
//
// A watch belongs to one key — the attempt id on the reading page — and its
// elapsed time runs from when the page started watching that key. Hidden-tab
// time counts, because elapsed is wall-clock time; pausing while hidden is the
// caller's (TanStack Query's `refetchIntervalInBackground: false`).

/** No automatic check at or after this much elapsed time. */
export const REFRESH_CAP_MS = 16 * 60_000;
/** Backoff after failed checks never waits longer than this. */
export const MAX_BACKOFF_MS = 30_000;
/** Consecutive failed checks that stop the watch ("Couldn't check status"). */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** The base interval for a given elapsed time. */
export type Schedule = (elapsedMs: number) => number;

/** The reading page's schedule: 3 s for 30 s, 5 s until 2 min, then 15 s. */
export const readingSchedule: Schedule = (elapsed) => (elapsed < 30_000 ? 3_000 : elapsed < 120_000 ? 5_000 : 15_000);

/** Why a watch stopped checking on its own. The manual check still works. */
export type WatchStop = "cap" | "failures";

export interface Watch {
  readonly key: string;
  readonly startedAt: number;
  readonly failures: number;
  readonly stopped: WatchStop | null;
}

export function startWatch(key: string, now: number): Watch {
  return { key, startedAt: now, failures: 0, stopped: null };
}

/** A check answered. Resets the failure count; never lifts a stop. */
export function recordSuccess(watch: Watch): Watch {
  return watch.failures === 0 ? watch : { ...watch, failures: 0 };
}

/** A check failed (thrown fetch, 5xx, or another unexpected answer). */
export function recordFailure(watch: Watch): Watch {
  const failures = watch.failures + 1;
  const stopped = watch.stopped ?? (failures >= MAX_CONSECUTIVE_FAILURES ? "failures" : null);
  return { ...watch, failures, stopped };
}

/** Marks the cap once it has passed; the same watch otherwise. */
export function withCap(watch: Watch, now: number): Watch {
  if (watch.stopped || now - watch.startedAt < REFRESH_CAP_MS) return watch;
  return { ...watch, stopped: "cap" };
}

/**
 * The wait before the next automatic check, or `false` for none: stopped, or
 * the check would land at or past the cap. Each consecutive failure doubles
 * the scheduled interval, up to `MAX_BACKOFF_MS`.
 */
export function nextInterval(watch: Watch, now: number, schedule: Schedule): number | false {
  if (watch.stopped) return false;
  const elapsed = now - watch.startedAt;
  const interval = Math.min(schedule(elapsed) * 2 ** watch.failures, MAX_BACKOFF_MS);
  return elapsed + interval >= REFRESH_CAP_MS ? false : interval;
}
