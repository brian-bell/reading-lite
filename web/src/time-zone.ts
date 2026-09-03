/**
 * IANA names for the digest time-zone <select>. Mirrors the Worker rule in
 * `src/modules/time-zone.ts`: `Intl.supportedValuesOf("timeZone")`, with `UTC`
 * always included because some ICU lists omit it. A stored value that is not
 * in the list is still offered so the control can round-trip it.
 */
export function listIanaTimeZones(stored?: string): string[] {
  const zones = new Set<string>(
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []
  );
  zones.add("UTC");
  if (stored && stored !== "") zones.add(stored);
  return [...zones].sort((a, b) => a.localeCompare(b));
}
