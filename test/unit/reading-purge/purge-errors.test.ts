import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { purgeReading } from "../../../src/reading-purge";
import type { ReadingStore } from "../../../src/modules/stores/reading-store";
import type { Manifest } from "../../../src/schemas/manifest";

// The corruption/availability distinction: a purge repairs corrupt stored
// objects (SyntaxError/ZodError) but must ABORT on a transiently failing read
// — mistaking unavailability for absence would skip the active-attempt guard
// (manifest) or strand an owned pointer (by-url) while the rest is purged.

const ID = "rd_X";
const PREFIX = "readings/2026/06/19T000000Z-rd_X";
const NOW = "2026-06-19T01:00:00.000Z";

function manifest(): Manifest {
  return {
    id: ID,
    url: "https://example.com/x",
    url_hash: "a".repeat(64),
    status: "failed",
    error: { code: "X", message: "x" },
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "b".repeat(64),
    created_at: "2026-06-19T00:00:00.000Z",
    updated_at: "2026-06-19T00:00:00.000Z",
  };
}

function fakeReader(overrides: Partial<Record<keyof ReadingStore, unknown>>): ReadingStore {
  return {
    readByIdPointer: async () => ({ id: ID, key_prefix: PREFIX }),
    readManifest: async () => manifest(),
    findListIndexItem: async () => null,
    removeListIndexItemIf: async () => {},
    readByUrlPointer: async () => null,
    deleteByUrlPointer: vi.fn(async () => {}),
    deleteReadingObjects: async () => 0,
    deleteByIdPointer: async () => {},
    ...overrides,
  } as unknown as ReadingStore;
}

const OPTS = { pendingTtlSeconds: 300, now: NOW };

describe("purgeReading error classification", () => {
  it("aborts before deleting anything when the manifest read fails transiently", async () => {
    const deleteObjects = vi.fn();
    const reader = fakeReader({
      readManifest: async () => {
        throw new Error("r2 unavailable");
      },
      deleteReadingObjects: deleteObjects,
    });
    await expect(purgeReading({ reader, similarity: null }, ID, OPTS)).rejects.toThrow(
      "r2 unavailable",
    );
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("aborts when the by-url pointer read fails transiently", async () => {
    const reader = fakeReader({
      readByUrlPointer: async () => {
        throw new Error("r2 unavailable");
      },
    });
    await expect(purgeReading({ reader, similarity: null }, ID, OPTS)).rejects.toThrow(
      "r2 unavailable",
    );
  });

  it("treats a corrupt by-url pointer as not-owned and completes the purge", async () => {
    const deleteByUrlPointer = vi.fn(async () => {});
    const reader = fakeReader({
      readByUrlPointer: async () => {
        throw new SyntaxError("Unexpected token");
      },
      deleteByUrlPointer,
    });
    const out = await purgeReading({ reader, similarity: null }, ID, OPTS);
    expect(out.kind).toBe("purged");
    if (out.kind !== "purged") return;
    expect(out.report.by_url_released).toBe(false);
    expect(deleteByUrlPointer).not.toHaveBeenCalled();
  });

  it("treats a schema-invalid manifest as corrupt and completes the purge", async () => {
    const reader = fakeReader({
      readManifest: async () => {
        throw new ZodError([]);
      },
    });
    const out = await purgeReading({ reader, similarity: null }, ID, OPTS);
    expect(out.kind).toBe("purged");
  });

  it("keeps the list row through a failed pointer release so a retry can still free the URL", async () => {
    // Corrupt manifest: the list row is the only source of the URL hash. A
    // transient failure while releasing the by-url slot must abort BEFORE the
    // row is removed, so a retried DELETE can recover the URL and finish.
    let row: { id: string; url: string } | null = { id: ID, url: "https://example.com/x" };
    let pointer: { id: string } | null = { id: ID };
    let pointerReadsFailed = 0;
    const reader = fakeReader({
      readManifest: async () => {
        throw new SyntaxError("corrupt manifest");
      },
      findListIndexItem: async () => row,
      removeListIndexItemIf: async (_id: string, predicate: (item: { id: string }) => boolean) => {
        if (row && predicate(row)) row = null;
      },
      readByUrlPointer: async () => {
        if (pointerReadsFailed === 0) {
          pointerReadsFailed++;
          throw new Error("r2 unavailable");
        }
        return pointer;
      },
      deleteByUrlPointer: async () => {
        pointer = null;
      },
    });

    await expect(purgeReading({ reader, similarity: null }, ID, OPTS)).rejects.toThrow(
      "r2 unavailable",
    );
    expect(row).not.toBeNull();

    const retry = await purgeReading({ reader, similarity: null }, ID, OPTS);
    expect(retry.kind).toBe("purged");
    if (retry.kind !== "purged") return;
    expect(retry.report.by_url_released).toBe(true);
    expect(pointer).toBeNull();
    expect(row).toBeNull();
  });

  it("refuses to follow a by-id pointer into another reading's prefix", async () => {
    const deleteObjects = vi.fn();
    const reader = fakeReader({
      // Damaged pointer: resolves the requested id to a DIFFERENT reading.
      readByIdPointer: async () => ({
        id: "rd_OTHER",
        key_prefix: "readings/2026/06/19T000000Z-rd_OTHER",
      }),
      deleteReadingObjects: deleteObjects,
    });
    const out = await purgeReading({ reader, similarity: null }, ID, OPTS);
    expect(out.kind).toBe("not_found");
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("re-removes a list row republished by a racing attempt during object deletion", async () => {
    // Simulates a live in-flight attempt whose terminal commit lands mid-purge:
    // the row reappears while objects are being deleted. The final sweep must
    // leave it removed.
    let row: { id: string } | null = { id: ID };
    const reader = fakeReader({
      findListIndexItem: async () => row,
      removeListIndexItemIf: async (_id: string, predicate: (item: { id: string }) => boolean) => {
        if (row && predicate(row)) row = null;
      },
      deleteReadingObjects: async () => {
        row = { id: ID };
        return 3;
      },
    });
    const out = await purgeReading({ reader, similarity: null }, ID, OPTS);
    expect(out.kind).toBe("purged");
    expect(row).toBeNull();
  });
});

// Issue #195 S3. A single-reading purge is a vector writer too, and it is the
// one that most obviously produces the failure the ledger exists to prevent:
// it deletes the reading's R2 objects in the same call, so a vector delete that
// did not take leaves a vector with no id source anywhere (review finding F3).
describe("purgeReading vector ledger", () => {
  const events: string[] = [];
  let deletes = 0;
  const similarity = {
    delete: async () => {
      deletes += 1;
    },
  } as unknown as NonNullable<Parameters<typeof purgeReading>[0]["similarity"]>;
  const ledger = {
    markLive: async () => {
      throw new Error("a purge never marks a vector live");
    },
    markDeleteSubmitted: async (ids: readonly string[]) => {
      for (const id of ids) events.push(`submitted:${id}:${deletes}`);
    },
  };

  it("marks the row delete_submitted after each vector delete, and never clears it", async () => {
    events.length = 0;
    deletes = 0;
    const reader = fakeReader({});
    const out = await purgeReading({ reader, similarity, ledger }, ID, OPTS);
    expect(out.kind).toBe("purged");
    // Twice, once per vector delete: the purge issues a second, idempotent
    // delete in its final sweep. Each is `:n` — after the delete it describes,
    // because `deleted_at_ms` dates the submission and the confirmation rule's
    // +120s first-attempt delay is measured from it.
    expect(events).toEqual([`submitted:${ID}:1`, `submitted:${ID}:2`]);
  });

  it("touches no ledger when there is no similarity store to delete through", async () => {
    // Local dev has no Vectorize binding, so the purge is R2-only and no vector
    // delete was submitted. A `delete_submitted` row would date one that never
    // happened.
    events.length = 0;
    deletes = 0;
    const reader = fakeReader({});
    const out = await purgeReading({ reader, similarity: null, ledger }, ID, OPTS);
    expect(out.kind).toBe("purged");
    expect(events).toEqual([]);
  });

  it("purges without a ledger, so a control-plane-less environment still works", async () => {
    deletes = 0;
    const reader = fakeReader({});
    const out = await purgeReading({ reader, similarity }, ID, OPTS);
    expect(out.kind).toBe("purged");
    expect(deletes).toBe(2);
  });
});
