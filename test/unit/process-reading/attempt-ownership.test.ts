import { describe, expect, it } from "vitest";
import {
  listItemBelongsToAttempt,
  manifestBelongsToAttempt,
  type ProcessReadingArgs,
} from "../../../src/process-reading";
import type { Manifest, ProcessingAttemptSummary } from "../../../src/schemas/manifest";
import type { ListIndexItem } from "../../../src/schemas/api";

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

function item(overrides: Partial<ListIndexItem>): ListIndexItem {
  return {
    id: ID,
    key_prefix: PREFIX,
    url: URL,
    status: "pending",
    created_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("attempt-ownership cleanup gates", () => {
  it("manifest and list gates both refuse a pending reading that has a foreign last_attempt but no active_attempt", () => {
    // A foreign attempt asks both cleanup gates whether it owns this reading.
    // The reading is pending with active_attempt cleared but a last_attempt set
    // by another attempt. Both gates must refuse (false): the vector (manifest)
    // gate used to be more permissive here, so a stale successful cleanup would
    // delete the vector for a reading the list-row gate refused to remove.
    // Pin concrete `false` (not gate-equality) so the regression can't slip back
    // by both gates breaking to `true` in lockstep.
    const ownerArgs = args({ attemptId: "at_OTHER" });
    const divergent = {
      active_attempt: undefined,
      last_attempt: attempt("at_PRIOR"),
      status: "pending" as const,
    };

    expect(manifestBelongsToAttempt(ownerArgs, manifest(divergent))).toBe(false);
    expect(listItemBelongsToAttempt(ownerArgs, item(divergent))).toBe(false);
  });

  it("the manifest gate still grants ownership when last_attempt is this attempt (real success-cleanup path)", () => {
    // The branch the no-regression argument rests on: in the reachable
    // success-cleanup path the attempt writes its own terminal manifest stamping
    // itself as last_attempt, then runs cleanup. The id-match branch must fire
    // BEFORE the tightened legacy clause, so this attempt's own vector is still
    // deletable. If this regresses, vectors leak on the stale-success path.
    const ownerArgs = args({ attemptId: "at_MINE" });
    const owned = {
      active_attempt: undefined,
      // Mirror the production success manifest: status "ready", this attempt
      // stamped as last_attempt. The id-match branch must win regardless.
      last_attempt: { ...attempt("at_MINE"), status: "succeeded" as const },
      status: "ready" as const,
    };
    expect(manifestBelongsToAttempt(ownerArgs, manifest(owned))).toBe(true);
  });

  it("both gates still grant ownership on a fully vacant pending reading", () => {
    // The agreeing state exercised by the HTTP surface today: no active, no last,
    // pending → both gates say "belongs", vector gets deleted. Must stay true.
    const vacant = {
      active_attempt: undefined,
      last_attempt: undefined,
      status: "pending" as const,
    };
    expect(manifestBelongsToAttempt(args(), manifest(vacant))).toBe(true);
    expect(listItemBelongsToAttempt(args(), item(vacant))).toBe(true);
  });
});
