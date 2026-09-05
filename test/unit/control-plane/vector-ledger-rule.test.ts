// The vector ledger's confirmation rule, tested as the pure function it is.
//
// The rule is S6's, measured on staging (report rl-195-s6-staging-gate §5.1),
// and it supersedes the design's sketch wherever the two differ. Every case
// below names the failure it prevents, because the failures are asymmetric:
// clearing a row for a vector that is still live strands that vector forever —
// the ledger is the only id source once R2 is empty — while failing to clear
// one merely costs another pass.

import { describe, expect, it } from "vitest";
import {
  VECTOR_LEDGER_BACKOFF_MS,
  VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS,
  VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
  VECTOR_LEDGER_REQUIRED_ABSENCES,
  VECTORIZE_GET_BY_IDS_MAX_IDS,
  absenceCounts,
  applyAbsenceObservation,
  chunkForGetByIds,
  confirmBackoffSeconds,
  earliestConfirmableAtMs,
  type VectorLedgerEntry,
} from "../../../src/control-plane/vector-ledger";

const T0 = Date.parse("2026-09-04T12:00:00.000Z");
/** Any instant at which a row deleted at T0 is old enough to confirm. */
const DUE = T0 + VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS;

function entry(overrides: Partial<VectorLedgerEntry> = {}): VectorLedgerEntry {
  return {
    readingId: "rd_0123456789",
    state: "delete_submitted",
    upsertedAtMs: T0 - 60_000,
    deletedAtMs: T0,
    absentStreak: 0,
    lastAbsentAtMs: null,
    ...overrides,
  };
}

describe("vector ledger — the constants S6 measured", () => {
  it("waits longer than the measured propagation ceiling before the first confirmation", () => {
    // S6 §3.3: deleteByIds → absent measured at 30-90s across four independent
    // cohorts, every cohort flipping atomically.
    expect(VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS).toBe(120_000);
    expect(VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS).toBeGreaterThan(90_000);
  });

  it("doubles the backoff and caps it", () => {
    expect(VECTOR_LEDGER_BACKOFF_MS).toEqual([120_000, 240_000, 480_000]);
    expect(confirmBackoffSeconds(1)).toBe(120);
    expect(confirmBackoffSeconds(2)).toBe(240);
    expect(confirmBackoffSeconds(3)).toBe(480);
    // Capped, not extrapolated: a stuck tenant must not walk off into hours.
    expect(confirmBackoffSeconds(4)).toBe(480);
    expect(confirmBackoffSeconds(99)).toBe(480);
    // Defensive: a zero or negative attempt count still yields the first delay
    // rather than an undefined array read.
    expect(confirmBackoffSeconds(0)).toBe(120);
  });

  it("chunks getByIds at the measured REST cap, not at deleteByIds' 1000", () => {
    // S6 §3.6: 25 ids → 400 with an empty body, 20 ids → 200. The Workers
    // binding's own limit is unverified, so it uses the same number.
    expect(VECTORIZE_GET_BY_IDS_MAX_IDS).toBe(20);
    const ids = Array.from({ length: 41 }, (_, i) => `rd_${i}`);
    const chunks = chunkForGetByIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 1]);
    expect(chunks.flat()).toEqual(ids);
    expect(chunkForGetByIds([])).toEqual([]);
  });
});

describe("vector ledger — when an absence is allowed to count", () => {
  it("refuses to count anything inside the propagation window", () => {
    // The old code probed immediately, which is inside the window by
    // construction: the hit was guaranteed and the attempt bought nothing
    // (S6 defect D2).
    expect(absenceCounts(entry(), T0)).toBe(false);
    expect(absenceCounts(entry(), DUE - 1)).toBe(false);
    expect(absenceCounts(entry(), DUE)).toBe(true);
  });

  it("requires the spacing between two absences, not merely two calls", () => {
    // The load-bearing half of the rule. Two calls back to back inside one
    // isolate hit the same replica milliseconds apart and confirm nothing.
    const seen = entry({ absentStreak: 1, lastAbsentAtMs: DUE });
    expect(absenceCounts(seen, DUE + 1)).toBe(false);
    expect(absenceCounts(seen, DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS - 1)).toBe(false);
    expect(absenceCounts(seen, DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS)).toBe(true);
  });

  it("never counts a row with no delete stamp", () => {
    // Un-ageable, so unconfirmable. Refusing is the safe direction: the row
    // survives, the id stays addressable, and the next deleteByIds stamps it.
    expect(absenceCounts(entry({ deletedAtMs: null }), T0 + 86_400_000)).toBe(false);
  });

  it("reports when the earliest row becomes confirmable, and null once one is due", () => {
    expect(earliestConfirmableAtMs([entry()], T0)).toBe(DUE);
    expect(earliestConfirmableAtMs([entry()], DUE)).toBeNull();
    // The soonest of several, so a pass is not deferred behind its slowest row.
    const soon = entry({ readingId: "rd_soon", deletedAtMs: T0 - 30_000 });
    expect(earliestConfirmableAtMs([entry(), soon], T0)).toBe(
      T0 - 30_000 + VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS,
    );
    // A row already seen absent once is due at the SPACING, not at the
    // first-confirm delay, once the latter has passed.
    const seen = entry({ absentStreak: 1, lastAbsentAtMs: DUE });
    expect(earliestConfirmableAtMs([seen], DUE + 1)).toBe(
      DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
    );
    expect(earliestConfirmableAtMs([], T0)).toBeNull();
  });
});

describe("vector ledger — applying one getByIds observation", () => {
  it("clears a row only on the SECOND spaced absence", () => {
    const first = applyAbsenceObservation(
      [entry()],
      { ok: true, requested: ["rd_0123456789"], present: [] },
      DUE,
    );
    expect(first.clear).toEqual([]);
    expect(first.advanced).toEqual([{ readingId: "rd_0123456789", absentStreak: 1 }]);

    const second = applyAbsenceObservation(
      [entry({ absentStreak: 1, lastAbsentAtMs: DUE })],
      { ok: true, requested: ["rd_0123456789"], present: [] },
      DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
    );
    // Carries the stamp the observation was made against, so the DELETE can
    // refuse a row re-marked since — a re-published reading has a NEW vector,
    // and clearing its row on a confirmation about the old one would strand it.
    expect(second.clear).toEqual([{ readingId: "rd_0123456789", deletedAtMs: T0 }]);
    expect(second.advanced).toEqual([]);
    expect(VECTOR_LEDGER_REQUIRED_ABSENCES).toBe(2);
  });

  it("does not let two unspaced calls stand in for two observations", () => {
    const verdict = applyAbsenceObservation(
      [entry({ absentStreak: 1, lastAbsentAtMs: DUE })],
      { ok: true, requested: ["rd_0123456789"], present: [] },
      DUE + 1,
    );
    // Neither counted nor reset: it is simply not an observation.
    expect(verdict).toEqual({ clear: [], advanced: [], reset: [] });
  });

  it("treats a FAILED call as no information, never as absence", () => {
    // The concrete trap S6 named: a 21-id chunk answers 400 with an empty body,
    // which a naive reader parses as "all 21 are gone". Nothing may clear here,
    // and the streak that was building must go back to zero.
    const verdict = applyAbsenceObservation(
      [entry({ absentStreak: 1, lastAbsentAtMs: DUE })],
      { ok: false, requested: ["rd_0123456789"], reason: "400 too many ids in payload" },
      DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
    );
    expect(verdict.clear).toEqual([]);
    expect(verdict.advanced).toEqual([]);
    expect(verdict.reset).toEqual(["rd_0123456789"]);
  });

  it("does not churn a reset for a row that had no streak to lose", () => {
    const verdict = applyAbsenceObservation(
      [entry()],
      { ok: false, requested: ["rd_0123456789"], reason: "timeout" },
      DUE,
    );
    expect(verdict).toEqual({ clear: [], advanced: [], reset: [] });
  });

  it("reads a partial 200 as per-id evidence and nothing more", () => {
    const rows = [
      entry({ readingId: "rd_present", absentStreak: 1, lastAbsentAtMs: DUE }),
      entry({ readingId: "rd_absent", absentStreak: 1, lastAbsentAtMs: DUE }),
      // In the ledger but NOT in this request. Nothing may be inferred about it.
      entry({ readingId: "rd_unasked", absentStreak: 1, lastAbsentAtMs: DUE }),
    ];
    const verdict = applyAbsenceObservation(
      rows,
      { ok: true, requested: ["rd_present", "rd_absent"], present: ["rd_present"] },
      DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
    );
    // Returned by a 200 → live → its streak resets.
    expect(verdict.reset).toEqual(["rd_present"]);
    // Requested and missing from a 200 → candidate absent → second one clears.
    expect(verdict.clear).toEqual([{ readingId: "rd_absent", deletedAtMs: T0 }]);
    // Never in the request → untouched, in every list.
    expect(verdict.advanced).toEqual([]);
    expect([...verdict.clear.map((c) => c.readingId), ...verdict.reset]).not.toContain(
      "rd_unasked",
    );
  });

  it("resets a streak the moment the id is seen alive again", () => {
    const verdict = applyAbsenceObservation(
      [entry({ absentStreak: 1, lastAbsentAtMs: DUE })],
      { ok: true, requested: ["rd_0123456789"], present: ["rd_0123456789"] },
      DUE + VECTOR_LEDGER_MIN_CONFIRM_SPACING_MS,
    );
    expect(verdict.clear).toEqual([]);
    expect(verdict.reset).toEqual(["rd_0123456789"]);
  });

  it("does not clear a row whose delete has not propagated long enough, however many calls agree", () => {
    // Ten absences inside the window still clear nothing. The gate is time,
    // not count.
    let row = entry();
    for (let i = 0; i < 10; i++) {
      const verdict = applyAbsenceObservation(
        [row],
        { ok: true, requested: [row.readingId], present: [] },
        T0 + i,
      );
      expect(verdict.clear).toEqual([]);
      expect(verdict.advanced).toEqual([]);
    }
    expect(row.absentStreak).toBe(0);
  });
});
