// The cron and the preview share nextDigestSendAt. These cases are the ones
// a half-hour-early tenant guard cannot see: a still-open period inside the
// due hour, and a fallback longer than one hour.

import { describe, expect, it } from "vitest";
import {
  digestDueAt,
  digestWindow,
  nextDigestSendAt,
  periodDeliveryForStatus,
  type DigestScheduleSettings,
} from "../../src/modules/digest-schedule";

function settings(
  timeZone: string,
  hour: number,
  cadence: DigestScheduleSettings["digest_cadence"] = "daily",
  weekday = 1,
): DigestScheduleSettings {
  return {
    digest_cadence: cadence,
    time_zone: timeZone,
    digest_hour_local: hour,
    digest_weekday: weekday,
  };
}

describe("nextDigestSendAt", () => {
  it("keeps today's send when the due hour is underway and the period is still open", () => {
    const now = new Date("2026-10-17T10:20:00.000Z");
    const next = nextDigestSendAt(settings("UTC", 10), now, "open");
    expect(next?.toISOString()).toBe("2026-10-17T10:00:00.000Z");
    expect(digestWindow("daily", "UTC", next ?? now)?.startMs).toBe(Date.parse("2026-10-16T10:00:00.000Z"));
  });

  it("keeps this week's send when the weekly due hour is underway", () => {
    const now = new Date("2026-10-14T10:20:00.000Z");
    expect(nextDigestSendAt(settings("UTC", 10, "weekly", 3), now, "open")?.toISOString()).toBe(
      "2026-10-14T10:00:00.000Z",
    );
  });

  it("moves to the next day once the due hour has passed", () => {
    const now = new Date("2026-10-17T11:00:00.000Z");
    expect(nextDigestSendAt(settings("UTC", 10), now, "open")?.toISOString()).toBe("2026-10-18T10:00:00.000Z");
  });

  it("uses the first Antarctica/Troll 01:00, two hours before the repeated one", () => {
    const now = new Date("2026-10-24T22:00:00.000Z");
    const next = nextDigestSendAt(settings("Antarctica/Troll", 1), now, "open");
    expect(next?.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(digestDueAt(settings("Antarctica/Troll", 1), next ?? now)).toEqual({
      due: true,
      cadence: "daily",
      period_key: "2026-10-25",
      local: { year: 2026, month: 10, day: 25, hour: 1, minute: 0, second: 0, isoWeekday: 7 },
    });
  });

  it("stays on that first Troll occurrence while the hour is still underway", () => {
    const now = new Date("2026-10-24T23:30:00.000Z");
    expect(nextDigestSendAt(settings("Antarctica/Troll", 1), now, "open")?.toISOString()).toBe(
      "2026-10-24T23:00:00.000Z",
    );
  });

  it("uses the second Troll occurrence once the first hour has passed and the next one is still ahead", () => {
    const now = new Date("2026-10-25T00:30:00.000Z");
    expect(nextDigestSendAt(settings("Antarctica/Troll", 1), now, "open")?.toISOString()).toBe(
      "2026-10-25T01:00:00.000Z",
    );
  });

  it("keeps the first America/New_York 01:00 on the one-hour fallback", () => {
    const now = new Date("2026-11-01T04:00:00.000Z");
    expect(nextDigestSendAt(settings("America/New_York", 1), now, "open")?.toISOString()).toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });

  it("skips a local hour that the spring-forward gap removes", () => {
    const now = new Date("2026-03-08T06:30:00.000Z");
    expect(nextDigestSendAt(settings("America/New_York", 2), now, "open")?.toISOString()).toBe(
      "2026-03-09T06:00:00.000Z",
    );
  });

  it("advances a daily period the cron has already closed", () => {
    const now = new Date("2026-10-17T10:20:00.000Z");
    expect(nextDigestSendAt(settings("UTC", 10), now, "closed")?.toISOString()).toBe("2026-10-18T10:00:00.000Z");
  });

  it("advances a weekly period the cron has already closed", () => {
    const now = new Date("2026-10-14T10:20:00.000Z");
    expect(nextDigestSendAt(settings("UTC", 10, "weekly", 3), now, "closed")?.toISOString()).toBe(
      "2026-10-21T10:00:00.000Z",
    );
  });

  it("does not keep the later Troll occurrence of a period the cron has closed", () => {
    const now = new Date("2026-10-24T23:30:00.000Z");
    expect(nextDigestSendAt(settings("Antarctica/Troll", 1), now, "closed")?.toISOString()).toBe(
      "2026-10-26T01:00:00.000Z",
    );
  });
});

describe("periodDeliveryForStatus", () => {
  it("treats a missing or pending row as open and a finished row as closed", () => {
    expect(periodDeliveryForStatus(null)).toBe("open");
    expect(periodDeliveryForStatus("pending")).toBe("open");
    expect(periodDeliveryForStatus("sent")).toBe("closed");
    expect(periodDeliveryForStatus("skipped")).toBe("closed");
    expect(periodDeliveryForStatus("failed")).toBe("closed");
  });
});

describe("digestWindow", () => {
  it("starts a Troll day at the first 01:30, not the repeated one two hours later", () => {
    const window = digestWindow("daily", "Antarctica/Troll", new Date("2026-10-26T01:30:00.000Z"));
    expect(window?.startMs).toBe(Date.parse("2026-10-24T23:30:00.000Z"));
  });
});
