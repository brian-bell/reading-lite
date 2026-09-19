import { describe, expect, it } from "vitest";
import { changeDigest, digestBody, listIanaTimeZones, turnsDigestOn, type DigestDraft } from "../src/digest";
import type { UserSettings } from "../src/settings";

const settings = (over: Partial<UserSettings> = {}): UserSettings => ({
  notify_immediate: false,
  digest_cadence: "off",
  time_zone: "Europe/London",
  digest_hour_local: 7,
  digest_weekday: 3,
  ...over,
});

const schedule = { time_zone: "Europe/London", digest_hour_local: 7, digest_weekday: 3 };

describe("changeDigest", () => {
  const off = settings();
  const daily = settings({ digest_cadence: "daily" });

  it("opens a draft from the schedule on screen when an off digest is turned on", () => {
    expect(changeDigest(off, off, null, { digest_cadence: "weekly" })).toEqual({
      kind: "draft",
      draft: { digest_cadence: "weekly", ...schedule },
    });
  });

  it("does nothing when an off digest is set to off", () => {
    expect(changeDigest(off, off, null, { digest_cadence: "off" })).toEqual({ kind: "none" });
  });

  it("edits an open draft, and cancels it when the cadence goes back to off", () => {
    const draft: DigestDraft = { digest_cadence: "daily", ...schedule };
    expect(changeDigest(off, off, draft, { digest_hour_local: 18 })).toEqual({
      kind: "draft",
      draft: { ...draft, digest_hour_local: 18 },
    });
    expect(changeDigest(off, off, draft, { digest_cadence: "weekly" })).toEqual({
      kind: "draft",
      draft: { ...draft, digest_cadence: "weekly" },
    });
    expect(changeDigest(off, off, draft, { digest_cadence: "off" })).toEqual({ kind: "cancel" });
  });

  it.each([
    ["a new hour", { digest_hour_local: 21 }],
    ["a new time zone", { time_zone: "Asia/Tokyo" }],
    ["a new cadence", { digest_cadence: "weekly" as const }],
    ["turning it off, keeping the schedule", { digest_cadence: "off" as const }],
  ])("saves %s at once, with the full body, while the digest is on", (_case, patch) => {
    expect(changeDigest(daily, daily, null, patch)).toEqual({
      kind: "save",
      body: { notify_immediate: false, digest_cadence: "daily", ...schedule, ...patch },
    });
  });

  it("decides on or off from the stored settings, and carries the unsaved values on screen", () => {
    // Stored daily; turning it off failed, so the screen says off at 21:00.
    const shown = settings({ digest_cadence: "off", digest_hour_local: 21 });
    expect(changeDigest(daily, shown, null, { digest_cadence: "weekly" })).toEqual({
      kind: "save",
      body: { notify_immediate: false, ...schedule, digest_hour_local: 21, digest_cadence: "weekly" },
    });
  });
});

describe("turnsDigestOn", () => {
  it("is a draft's save: an off digest saved with a cadence", () => {
    expect(turnsDigestOn(settings(), { notify_immediate: false, digest_cadence: "daily" })).toBe(true);
    expect(turnsDigestOn(settings(), { notify_immediate: false })).toBe(false);
    expect(turnsDigestOn(settings({ digest_cadence: "daily" }), { notify_immediate: false, digest_cadence: "weekly" })).toBe(
      false,
    );
  });
});

describe("digestBody", () => {
  it("sends notify_immediate with the schedule", () => {
    expect(digestBody(settings({ notify_immediate: true }), { digest_cadence: "daily", ...schedule })).toEqual({
      notify_immediate: true,
      digest_cadence: "daily",
      ...schedule,
    });
  });
});

describe("listIanaTimeZones", () => {
  it("always offers UTC, sorted", () => {
    const zones = listIanaTimeZones();
    expect(zones).toContain("UTC");
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
  });

  it("keeps a stored zone the list lacks, so the control round-trips it", () => {
    expect(listIanaTimeZones("Not/A_Zone")).toContain("Not/A_Zone");
  });
});
