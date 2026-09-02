/**
 * Write-time validation for digest schedule fields.
 *
 * Time zones are IANA names from `Intl.supportedValuesOf("timeZone")`. Some
 * ICU lists omit `UTC` even though it is a valid Intl zone and the D1 default,
 * so `UTC` is accepted explicitly. Aliases that `DateTimeFormat` would accept
 * (`GMT`, `Etc/UTC`, lowercase) are rejected unless they appear in the set.
 *
 * `digest_hour_local` is 0–23. `digest_weekday` is ISO 8601 Monday=1 through
 * Sunday=7 — not JavaScript `Date#getDay()`, which is Sunday=0.
 */

const IANA_TIME_ZONES: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
);

export function isIanaTimeZone(value: string): boolean {
  return value === "UTC" || IANA_TIME_ZONES.has(value);
}

export function isDigestHourLocal(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

/** ISO weekday: Monday=1 … Sunday=7. */
export function isDigestWeekday(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}
