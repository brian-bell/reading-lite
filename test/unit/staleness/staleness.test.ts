import { describe, expect, it } from "vitest";
import {
  applyStaleness,
  isBatchOwnedPending,
  stalenessOf,
  type StaleInput,
} from "../../../src/modules/staleness";
import type { Manifest, ProcessingAttemptSummary } from "../../../src/schemas/manifest";
import type { ListIndexItem } from "../../../src/schemas/api";

const TTL = 300;
const NOW = "2024-01-01T01:00:00.000Z";
const ONE_HOUR_AGO = "2024-01-01T00:00:00.000Z"; // > TTL before NOW
const ONE_MINUTE_AGO = "2024-01-01T00:59:00.000Z"; // < TTL before NOW

function runningAttempt(overrides: Partial<ProcessingAttemptSummary> = {}): ProcessingAttemptSummary {
  return {
    id: "att_1",
    trigger: "submit",
    status: "running",
    started_at: ONE_HOUR_AGO,
    ...overrides,
  };
}

describe("stalenessOf", () => {
  describe("running active attempt", () => {
    it("flags a running attempt past TTL as a failed summary", () => {
      const input: StaleInput = { status: "pending", updated_at: NOW, active_attempt: runningAttempt() };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.expiredActiveAttempt).toMatchObject({
        id: "att_1",
        status: "failed",
        finished_at: NOW,
        error: {
          code: "stale_active_attempt",
          message: `active attempt > ${TTL}s`,
          failed_at: NOW,
          retryable: true,
        },
      });
      // active-attempt expiry short-circuits the pending check
      expect(verdict.pendingError).toBeNull();
    });

    it("carries the attempt stage into the synthesized error when present", () => {
      const input: StaleInput = {
        status: "pending",
        updated_at: NOW,
        active_attempt: runningAttempt({ stage: "summarize" }),
      };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.expiredActiveAttempt?.error?.stage).toBe("summarize");
    });

    it("leaves a running attempt within TTL untouched", () => {
      const input: StaleInput = {
        status: "pending",
        updated_at: NOW,
        active_attempt: runningAttempt({ started_at: ONE_MINUTE_AGO }),
      };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.expiredActiveAttempt).toBeNull();
    });

    it("ignores a running attempt whose started_at is not a finite timestamp", () => {
      const input: StaleInput = {
        status: "pending",
        updated_at: NOW,
        active_attempt: runningAttempt({ started_at: "not-a-date" }),
      };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.expiredActiveAttempt).toBeNull();
    });

    it("expires the active attempt even when the record status is not pending", () => {
      const input: StaleInput = { status: "ready", updated_at: NOW, active_attempt: runningAttempt() };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.expiredActiveAttempt).not.toBeNull();
      expect(verdict.pendingError).toBeNull();
    });
  });

  describe("pending expiry", () => {
    it("does not stale a uniquely identified batch-owned pending import", () => {
      const input: StaleInput = {
        status: "pending",
        updated_at: ONE_HOUR_AGO,
        active_attempt: runningAttempt({
          id: "batch_550e8400-e29b-41d4-a716-446655440000",
          trigger: "import",
          stage: "summarize",
          started_at: ONE_HOUR_AGO,
        }),
      };
      expect(isBatchOwnedPending(input)).toBe(true);
      expect(stalenessOf(input, TTL, NOW)).toEqual({ expiredActiveAttempt: null, pendingError: null });
    });

    it("does not stale a batch-owned pending reprocess whose preparation exceeded TTL", () => {
      const input: StaleInput = {
        status: "pending",
        updated_at: NOW,
        active_attempt: runningAttempt({
          id: "batch_550e8400-e29b-41d4-a716-446655440000",
          trigger: "reprocess",
          stage: "summarize",
          started_at: ONE_HOUR_AGO,
        }),
      };
      expect(isBatchOwnedPending(input)).toBe(true);
      expect(stalenessOf(input, TTL, NOW)).toEqual({ expiredActiveAttempt: null, pendingError: null });
    });

    it("does not exempt non-batch import attempts", () => {
      const input: StaleInput = {
        status: "pending",
        updated_at: ONE_HOUR_AGO,
        active_attempt: runningAttempt({
          id: "at_rd_a",
          trigger: "import",
          stage: "summarize",
          started_at: ONE_HOUR_AGO,
        }),
      };
      expect(isBatchOwnedPending(input)).toBe(false);
      expect(stalenessOf(input, TTL, NOW).expiredActiveAttempt?.error?.code).toBe("stale_active_attempt");
    });

    it("flags a pending record past TTL with a stale_pending error", () => {
      const input: StaleInput = { status: "pending", updated_at: ONE_HOUR_AGO };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.expiredActiveAttempt).toBeNull();
      expect(verdict.pendingError).toEqual({ code: "stale_pending", message: `pending > ${TTL}s` });
    });

    it("leaves a pending record within TTL untouched", () => {
      const input: StaleInput = { status: "pending", updated_at: ONE_MINUTE_AGO };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.pendingError).toBeNull();
    });

    it("treats a non-finite updated_at as not stale", () => {
      const input: StaleInput = { status: "pending", updated_at: "garbage" };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.pendingError).toBeNull();
    });

    it("treats a non-finite now as not stale", () => {
      const input: StaleInput = { status: "pending", updated_at: ONE_HOUR_AGO };
      const verdict = stalenessOf(input, TTL, "not-a-date");
      expect(verdict.pendingError).toBeNull();
    });

    it("falls back to created_at when updated_at is absent", () => {
      const input: StaleInput = { status: "pending", created_at: ONE_HOUR_AGO };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.pendingError).toEqual({ code: "stale_pending", message: `pending > ${TTL}s` });
    });

    it("prefers updated_at over created_at when both are present", () => {
      // updated_at is recent, created_at is old -> not stale
      const input: StaleInput = { status: "pending", updated_at: ONE_MINUTE_AGO, created_at: ONE_HOUR_AGO };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict.pendingError).toBeNull();
    });
  });

  describe("non-pending records without an active attempt", () => {
    it("never flags a ready record even with an ancient timestamp", () => {
      const input: StaleInput = { status: "ready", updated_at: ONE_HOUR_AGO };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict).toEqual({ expiredActiveAttempt: null, pendingError: null });
    });

    it("never flags a failed record even with an ancient timestamp", () => {
      const input: StaleInput = { status: "failed", updated_at: ONE_HOUR_AGO };
      const verdict = stalenessOf(input, TTL, NOW);
      expect(verdict).toEqual({ expiredActiveAttempt: null, pendingError: null });
    });
  });
});

// The verdict-application half of the rule, single-homed here so the manifest
// path and the index-item path can never drift (previously two adapters in
// router.ts).
describe("applyStaleness", () => {
  function manifest(overrides: Partial<Manifest> = {}): Manifest {
    return {
      id: "rd_A",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: ONE_HOUR_AGO,
      updated_at: ONE_HOUR_AGO,
      ...overrides,
    };
  }

  it("flips a pending manifest with an expired running attempt to failed", () => {
    const input = manifest({ updated_at: NOW, active_attempt: runningAttempt() });
    const out = applyStaleness(input, TTL, NOW);
    expect(out.status).toBe("failed");
    expect(out.active_attempt).toBeUndefined();
    expect(out.last_attempt).toMatchObject({
      id: "att_1",
      status: "failed",
      finished_at: NOW,
    });
    expect(out.error).toMatchObject({ code: "stale_active_attempt" });
    expect(out.updated_at).toBe(NOW);
  });

  it("clears an expired attempt on a ready manifest without changing status", () => {
    const input = manifest({ status: "ready", updated_at: NOW, active_attempt: runningAttempt() });
    const out = applyStaleness(input, TTL, NOW);
    expect(out.status).toBe("ready");
    expect(out.active_attempt).toBeUndefined();
    expect(out.last_attempt).toMatchObject({ status: "failed" });
    expect(out.error).toBeUndefined();
  });

  it("flips a stale pending manifest with no active attempt to failed", () => {
    const input = manifest();
    const out = applyStaleness(input, TTL, NOW);
    expect(out.status).toBe("failed");
    expect(out.error).toEqual({ code: "stale_pending", message: `pending > ${TTL}s` });
  });

  it("returns a fresh record unchanged", () => {
    const input = manifest({ updated_at: ONE_MINUTE_AGO });
    expect(applyStaleness(input, TTL, NOW)).toEqual(input);
  });

  it("applies to the list-index item shape too, preserving its extra fields", () => {
    const item: ListIndexItem = {
      id: "rd_B",
      key_prefix: "readings/2024/01/01T000000Z-rd_B",
      url: "https://example.com/b",
      status: "pending",
      created_at: ONE_HOUR_AGO,
      updated_at: NOW,
      tags: ["t1"],
      active_attempt: runningAttempt(),
    };
    const out = applyStaleness(item, TTL, NOW);
    expect(out.status).toBe("failed");
    expect(out.key_prefix).toBe(item.key_prefix);
    expect(out.tags).toEqual(["t1"]);
    expect(out.active_attempt).toBeUndefined();
    expect(out.last_attempt).toMatchObject({ id: "att_1", status: "failed" });
  });
});
