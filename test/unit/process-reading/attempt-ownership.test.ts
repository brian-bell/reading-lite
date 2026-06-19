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
  it("manifest and list gates agree on a pending reading that has a last_attempt but no active_attempt", () => {
    // A foreign attempt asks both cleanup gates whether it owns this reading.
    // The reading is pending with active_attempt cleared but a last_attempt set
    // (a prior attempt touched it). The vector (manifest) gate must not be more
    // permissive than the list-row gate, or a stale successful cleanup deletes
    // the vector for a reading the list gate refused to remove.
    const ownerArgs = args({ attemptId: "at_OTHER" });
    const divergent = {
      active_attempt: undefined,
      last_attempt: attempt("at_PRIOR"),
      status: "pending" as const,
    };

    expect(manifestBelongsToAttempt(ownerArgs, manifest(divergent))).toBe(
      listItemBelongsToAttempt(ownerArgs, item(divergent)),
    );
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
