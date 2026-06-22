import { describe, expect, it } from "vitest";
import {
  attemptOwnership,
  type ProcessReadingArgs,
} from "../../../src/attempt-ownership";
import type { Manifest, ProcessingAttemptSummary } from "../../../src/schemas/manifest";

const ID = "rd_X";
const PREFIX = "readings/2026/06/19T000000Z-rd_X";
const URL = "https://example.com/x";
const URL_HASH = "a".repeat(64);

function args(overrides: Partial<ProcessReadingArgs> = {}): ProcessReadingArgs {
  return {
    id: ID,
    url: URL,
    urlHash: URL_HASH,
    createdAt: "2026-06-19T00:00:00.000Z",
    keyPrefix: PREFIX,
    ...overrides,
  };
}

function attempt(id: string): ProcessingAttemptSummary {
  return {
    id,
    trigger: "submit",
    status: "failed",
    started_at: "2026-06-19T00:00:00.000Z",
  };
}

// The verdict reads only active_attempt / last_attempt / status, the shape both
// Manifest and ListIndexItem share. We exercise it through a Manifest builder.
function manifest(overrides: Partial<Manifest>): Manifest {
  return {
    id: ID,
    url: URL,
    url_hash: URL_HASH,
    status: "pending",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "b".repeat(64),
    created_at: "2026-06-19T00:00:00.000Z",
    updated_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("attemptOwnership verdict", () => {
  it("isActive when active_attempt.id matches this attempt", () => {
    const o = attemptOwnership(
      manifest({ active_attempt: attempt("at_MINE"), status: "pending" }),
      args({ attemptId: "at_MINE" }),
    );
    expect(o.isActive).toBe(true);
    expect(o.hasConflict).toBe(false);
    expect(o.isLegacyPending).toBe(false);
    expect(o.isVacantPending).toBe(false);
  });

  it("isLast when last_attempt.id matches this attempt", () => {
    // markFailed stamps last_attempt before computing terminal state, so the
    // terminal-write and cleanup gates must recognize a finished attempt by last.
    const o = attemptOwnership(
      manifest({
        active_attempt: undefined,
        last_attempt: { ...attempt("at_MINE"), status: "succeeded" },
        status: "ready",
      }),
      args({ attemptId: "at_MINE" }),
    );
    expect(o.isLast).toBe(true);
    expect(o.isActive).toBe(false);
    expect(o.hasConflict).toBe(false);
  });

  it("isLegacyPending when active_attempt is absent and status is pending", () => {
    // The write-side rule: a pre-attempt-tracking pending manifest (active
    // cleared) is still writable by the attempt processing it, even with a
    // foreign last_attempt set.
    const o = attemptOwnership(
      manifest({
        active_attempt: undefined,
        last_attempt: attempt("at_PRIOR"),
        status: "pending",
      }),
      args({ attemptId: "at_MINE" }),
    );
    expect(o.isLegacyPending).toBe(true);
    // But it is NOT vacant-pending — last_attempt is set, so cleanup must refuse.
    expect(o.isVacantPending).toBe(false);
  });

  it("isVacantPending only when active AND last are both absent and pending", () => {
    const o = attemptOwnership(
      manifest({ active_attempt: undefined, last_attempt: undefined, status: "pending" }),
      args(),
    );
    expect(o.isVacantPending).toBe(true);
    expect(o.isLegacyPending).toBe(true);
  });

  it("isVacantPending is false once a (foreign) last_attempt exists — the Part-1 fix", () => {
    // This is the divergence Part 1 unified: a pending reading with active
    // cleared but a foreign last_attempt set. Cleanup gates compose
    // isActive||isLast||isVacantPending, so all three must be false here.
    const o = attemptOwnership(
      manifest({
        active_attempt: undefined,
        last_attempt: attempt("at_PRIOR"),
        status: "pending",
      }),
      args({ attemptId: "at_OTHER" }),
    );
    expect(o.isActive).toBe(false);
    expect(o.isLast).toBe(false);
    expect(o.isVacantPending).toBe(false);
  });

  it("hasConflict when active_attempt is defined and foreign", () => {
    const o = attemptOwnership(
      manifest({ active_attempt: attempt("at_OTHER"), status: "pending" }),
      args({ attemptId: "at_MINE" }),
    );
    expect(o.hasConflict).toBe(true);
    expect(o.isActive).toBe(false);
    // A foreign active attempt blocks the write-side legacy-pending grant too.
    expect(o.isLegacyPending).toBe(false);
  });

  it("defaults the attemptId to at_<id> when args.attemptId is absent", () => {
    // The single home of the `at_${id}` fallback. A manifest whose active_attempt
    // is the derived id belongs to an args with no explicit attemptId.
    const o = attemptOwnership(
      manifest({ active_attempt: attempt(`at_${ID}`), status: "pending" }),
      args(),
    );
    expect(o.isActive).toBe(true);
    expect(o.hasConflict).toBe(false);
  });

  it("treats a null manifest as no ownership and no conflict", () => {
    const o = attemptOwnership(null, args());
    expect(o.isActive).toBe(false);
    expect(o.isLast).toBe(false);
    expect(o.isLegacyPending).toBe(false);
    expect(o.isVacantPending).toBe(false);
    expect(o.hasConflict).toBe(false);
  });
});
