import { describe, expect, it } from "vitest";
import { stalenessOf, type StaleInput } from "../../../src/modules/staleness";
import type { ProcessingAttemptSummary } from "../../../src/schemas/manifest";

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
