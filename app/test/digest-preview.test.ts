import { describe, expect, it } from "vitest";
import { digestSendOf, type DigestPreview } from "../src/digest-preview";

// The next send is told on the reader's digest clock (design spec, Digest
// preview), never this browser's: the zones below cannot all be the runner's.

const PREVIEW: DigestPreview = {
  cadence: "weekly",
  time_zone: "Europe/London",
  next_send_at: "2026-09-14T03:00:00.000Z",
  subject: "Weekly digest · 0 readings",
  items: [],
};

describe("the next digest's send time", () => {
  it.each([
    ["Europe/London", "Monday 14 September at 04:00, Europe/London"],
    ["America/Los_Angeles", "Sunday 13 September at 20:00, America/Los_Angeles"],
    ["Pacific/Auckland", "Monday 14 September at 15:00, Pacific/Auckland"],
    ["Not/A_Zone", "Monday 14 September at 03:00, UTC"],
  ])("in %s", (time_zone, goesOut) => {
    expect(digestSendOf({ ...PREVIEW, time_zone })).toMatchObject({ kind: "scheduled", goesOut });
  });
});
