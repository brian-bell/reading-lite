import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_MS, REFRESH_CAP_MS, nextInterval, readingSchedule, recordFailure, startWatch } from "../src/status-refresh";

// The shared timing rules. The reading page's request times, backoff, the
// three-failure stop, and what a stop does to later answers are owned by the
// page test (test/reading-refresh.test.tsx); this pins only what no page
// check reaches.

describe("nextInterval", () => {
  // Two failures at the 15 s interval would wait 60 s.
  it("never backs off past the ceiling", () => {
    const watch = recordFailure(recordFailure(startWatch("at_1", 0)));
    expect(nextInterval(watch, 200_000, readingSchedule)).toBe(MAX_BACKOFF_MS);
  });

  // 15:45 plus a 15 s interval lands exactly on 16:00, which is past the cap.
  it("schedules nothing that would land at or after the cap", () => {
    const watch = startWatch("at_1", 0);
    expect(nextInterval(watch, REFRESH_CAP_MS - 15_001, readingSchedule)).toBe(15_000);
    expect(nextInterval(watch, REFRESH_CAP_MS - 15_000, readingSchedule)).toBe(false);
  });
});
