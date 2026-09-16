import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import type { Reading } from "../src/reading";
import { readingState, type ReadingStateFields } from "../src/reading-state";

// The one classification the status card, the outcome announcement, and the
// library badge render (#410). Their own tests own only their words.

const running = { id: "at_1", trigger: "reprocess", status: "running", started_at: "2026-09-10T10:00:00.000Z" };
const fetchError = { code: "BadStatusError", message: "bad response status 503: Service Unavailable", stage: "fetch_source" };
const failedReprocess = {
  id: "at_2",
  trigger: "reprocess",
  status: "failed",
  stage: "fetch_source",
  started_at: "2026-09-10T10:00:00.000Z",
  finished_at: "2026-09-10T10:00:10.000Z",
  error: fetchError,
};
const ownError = { code: "stale_pending", message: "pending too long" };

describe("readingState", () => {
  it.each<{ name: string; fields: ReadingStateFields; expected: ReturnType<typeof readingState> }>([
    { name: "a ready reading", fields: { status: "ready" }, expected: { kind: "ready" } },
    { name: "a pending reading", fields: { status: "pending" }, expected: { kind: "processing" } },
    {
      name: "a ready reading under a running reprocess, even over a failed one",
      fields: { status: "ready", active_attempt: running, last_attempt: failedReprocess },
      expected: { kind: "processing" },
    },
    {
      name: "a failed reading with its own error",
      fields: { status: "failed", error: ownError, last_attempt: failedReprocess },
      expected: { kind: "failed", error: ownError },
    },
    {
      name: "a failed reading with only the last attempt's error",
      fields: { status: "failed", last_attempt: failedReprocess },
      expected: { kind: "failed", error: fetchError },
    },
    { name: "a failed reading with no error", fields: { status: "failed" }, expected: { kind: "failed", error: undefined } },
    {
      name: "a ready reading whose last attempt is a failed reprocess",
      fields: { status: "ready", last_attempt: failedReprocess },
      expected: { kind: "reprocess-failed", error: fetchError },
    },
    {
      name: "a ready reading whose last reprocess succeeded",
      fields: { status: "ready", last_attempt: { ...failedReprocess, status: "succeeded", error: undefined } },
      expected: { kind: "ready" },
    },
    // Only a reprocess restores a ready manifest over a failure; a failed
    // attempt of another trigger on a ready manifest is not read as one.
    {
      name: "a ready reading whose failed last attempt was not a reprocess",
      fields: { status: "ready", last_attempt: { ...failedReprocess, trigger: "submit" } },
      expected: { kind: "ready" },
    },
  ])("classifies $name", ({ fields, expected }) => {
    expect(readingState(fields)).toEqual(expected);
  });

  it("agrees with the fixture pack's manifests", () => {
    const readings = pack.readings as Record<string, Reading>;
    const byName = (name: string) => readings[pack.fixtures.find((f) => f.name === name)!.id]!;
    expect(readingState(byName("attention")).kind).toBe("ready");
    expect(readingState(byName("pending")).kind).toBe("processing");
    expect(readingState(byName("fail-source-unreachable")).kind).toBe("failed");
    expect(readingState(byName("reprocess-failed")).kind).toBe("reprocess-failed");
  });
});
