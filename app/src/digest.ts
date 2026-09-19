import type { DigestCadence, SettingsBody, UserSettings } from "./settings";

// The digest schedule on the account page (#340.6.3), as the SPA's
// digest-schedule section (web/src/App.tsx onDigest*Change,
// onSaveDigestDraft). Pure, so the draft rules are tested on their own.
//
// Turning the digest on from off opens a draft: nothing is saved until the
// reader presses Save digest, and Cancel discards it. While the digest is on,
// each change saves at once. Turning it off keeps the hour, weekday, and time
// zone (the backend stores them either way). Every save sends the full body,
// notify_immediate included.

export type DigestSchedule = Pick<UserSettings, "digest_cadence" | "time_zone" | "digest_hour_local" | "digest_weekday">;

/** An unsaved schedule for a digest that is off. Its cadence is never off. */
export type DigestDraft = DigestSchedule & { digest_cadence: Exclude<DigestCadence, "off"> };

export const DIGEST_CADENCE_OPTIONS: readonly { value: DigestCadence; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/** ISO weekday numbers, as `digest_weekday` stores them. */
export const DIGEST_WEEKDAY_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

export const DIGEST_HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

export function digestHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * IANA names for the time-zone control, as the SPA offers them
 * (web/src/time-zone.ts, mirroring the Worker's rule): `Intl`'s list with
 * `UTC` always in it, plus a stored zone the list lacks so the control can
 * round-trip it.
 */
export function listIanaTimeZones(stored?: string): string[] {
  const zones = new Set<string>(
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
  );
  zones.add("UTC");
  if (stored) zones.add(stored);
  return [...zones].sort((a, b) => a.localeCompare(b));
}

export function scheduleOf(settings: UserSettings): DigestSchedule {
  return {
    digest_cadence: settings.digest_cadence,
    time_zone: settings.time_zone,
    digest_hour_local: settings.digest_hour_local,
    digest_weekday: settings.digest_weekday,
  };
}

/** The full POST body: the stored settings with `schedule` over them. */
export function digestBody(settings: UserSettings, schedule: DigestSchedule): SettingsBody {
  return { notify_immediate: settings.notify_immediate, ...schedule };
}

export type DigestChange =
  | { kind: "draft"; draft: DigestDraft }
  | { kind: "cancel" }
  | { kind: "none" }
  | { kind: "save"; body: SettingsBody };

/**
 * What one change to a digest control does: edit the draft, drop it (as
 * Cancel does), or save at once. Whether the digest is on is the stored
 * settings' answer, as in the SPA; the values carried into a draft or a save
 * are the ones on screen (`shown`), so a change that failed to save is not
 * lost by the next one.
 */
export function changeDigest(
  stored: UserSettings,
  shown: UserSettings,
  draft: DigestDraft | null,
  patch: Partial<DigestSchedule>,
): DigestChange {
  if (draft) {
    if (patch.digest_cadence === "off") return { kind: "cancel" };
    return { kind: "draft", draft: { ...draft, ...patch } as DigestDraft };
  }
  if (stored.digest_cadence === "off") {
    const cadence = patch.digest_cadence;
    if (cadence === undefined || cadence === "off") return { kind: "none" };
    return { kind: "draft", draft: { ...scheduleOf(shown), ...patch, digest_cadence: cadence } };
  }
  return { kind: "save", body: digestBody(shown, { ...scheduleOf(shown), ...patch }) };
}

/** Whether a save body is a draft's: it turns on a digest stored as off. */
export function turnsDigestOn(stored: UserSettings, body: SettingsBody | undefined): boolean {
  return stored.digest_cadence === "off" && body?.digest_cadence !== undefined && body.digest_cadence !== "off";
}
