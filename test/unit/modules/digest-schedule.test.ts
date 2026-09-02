import { describe, expect, it } from "vitest";
import {
  digestDueAt,
  isoWeekPeriodKey,
  localCivilTime,
  periodKeyFor,
} from "../../../src/modules/digest-schedule";

const daily = (hour: number, timeZone = "UTC") => ({
  digest_cadence: "daily" as const,
  time_zone: timeZone,
  digest_hour_local: hour,
  digest_weekday: 1,
});

const weekly = (hour: number, weekday: number, timeZone = "UTC") => ({
  digest_cadence: "weekly" as const,
  time_zone: timeZone,
  digest_hour_local: hour,
  digest_weekday: weekday,
});

describe("localCivilTime / period_key", () => {
  it("uses local YYYY-MM-DD for daily, including when UTC date has rolled", () => {
    // 2026-09-02T06:00Z = 2026-09-01 23:00 America/Los_Angeles
    const now = new Date("2026-09-02T06:00:00.000Z");
    const local = localCivilTime(now, "America/Los_Angeles");
    expect(local).toMatchObject({ year: 2026, month: 9, day: 1, hour: 23, isoWeekday: 2 });
    expect(periodKeyFor("daily", local!)).toBe("2026-09-01");
  });

  it("uses ISO week YYYY-Www with Monday=1", () => {
    expect(isoWeekPeriodKey(2026, 1, 1)).toBe("2026-W01");
    expect(isoWeekPeriodKey(2025, 12, 29)).toBe("2026-W01");
    expect(isoWeekPeriodKey(2026, 12, 31)).toBe("2026-W53");
    const wed = localCivilTime(new Date("2026-09-02T12:00:00.000Z"), "UTC");
    expect(wed?.isoWeekday).toBe(3);
    expect(periodKeyFor("weekly", wed!)).toBe("2026-W36");
  });

  it("rejects an invalid stored TZ", () => {
    expect(localCivilTime(new Date("2026-09-02T12:00:00.000Z"), "Not/A_Zone")).toBeNull();
  });
});

describe("digestDueAt with frozen now", () => {
  it("selects the first tick whose local hour matches", () => {
    const nineUtc = new Date("2026-09-02T09:00:00.000Z");
    expect(digestDueAt(daily(9), nineUtc)).toEqual({
      due: true,
      cadence: "daily",
      period_key: "2026-09-02",
      local: { year: 2026, month: 9, day: 2, hour: 9, isoWeekday: 3 },
    });
    expect(digestDueAt(daily(9), new Date("2026-09-02T08:45:00.000Z")).due).toBe(false);
    expect(digestDueAt(daily(9), new Date("2026-09-02T09:15:00.000Z"))).toMatchObject({
      due: true,
      period_key: "2026-09-02",
    });
  });

  it("requires weekday for weekly (ISO Monday=1)", () => {
    const wedNine = new Date("2026-09-02T09:00:00.000Z");
    expect(digestDueAt(weekly(9, 3), wedNine)).toMatchObject({
      due: true,
      cadence: "weekly",
      period_key: "2026-W36",
    });
    expect(digestDueAt(weekly(9, 1), wedNine)).toEqual({ due: false, reason: "weekday_mismatch" });
  });

  it("skips a DST missing hour and keeps one period_key across a repeated hour", () => {
    const missingTwo = digestDueAt(
      daily(2, "America/New_York"),
      new Date("2026-03-08T07:00:00.000Z"),
    );
    const threeAm = digestDueAt(
      daily(3, "America/New_York"),
      new Date("2026-03-08T07:00:00.000Z"),
    );
    expect(missingTwo).toEqual({ due: false, reason: "hour_mismatch" });
    expect(threeAm).toMatchObject({ due: true, period_key: "2026-03-08" });

    const firstOne = digestDueAt(
      daily(1, "America/New_York"),
      new Date("2026-11-01T05:00:00.000Z"),
    );
    const secondOne = digestDueAt(
      daily(1, "America/New_York"),
      new Date("2026-11-01T06:00:00.000Z"),
    );
    expect(firstOne).toMatchObject({ due: true, period_key: "2026-11-01" });
    expect(secondOne).toMatchObject({ due: true, period_key: "2026-11-01" });
  });

  it("returns cadence_off and invalid_time_zone without guessing UTC", () => {
    expect(
      digestDueAt(
        { digest_cadence: "off", time_zone: "UTC", digest_hour_local: 9, digest_weekday: 1 },
        new Date("2026-09-02T09:00:00.000Z"),
      ),
    ).toEqual({ due: false, reason: "cadence_off" });
    expect(digestDueAt(daily(9, "Not/A_Zone"), new Date("2026-09-02T09:00:00.000Z"))).toEqual({
      due: false,
      reason: "invalid_time_zone",
    });
  });
});
