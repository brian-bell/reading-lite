import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitTerminalManifest,
  type ProcessReadingArgs,
} from "../../../src/process-reading";
import {
  manifestToIndexItem,
  ReadingStore,
} from "../../../src/modules/stores/reading-store";
import { SimilarityStore } from "../../../src/modules/stores/similarity-store";
import { EMBEDDING_DIM } from "../../../src/schemas/api";
import type {
  Manifest,
  ProcessingAttemptSummary,
  ProcessingStage,
} from "../../../src/schemas/manifest";

const ID = "rd_X";
const PREFIX = "readings/2026/06/19T000000Z-rd_X";
const URL = "https://example.com/x";
const URL_HASH = "a".repeat(64);
const ATTEMPT = "at_MINE";

function args(overrides: Partial<ProcessReadingArgs> = {}): ProcessReadingArgs {
  return {
    id: ID,
    url: URL,
    urlHash: URL_HASH,
    createdAt: "2026-06-19T00:00:00.000Z",
    keyPrefix: PREFIX,
    attemptId: ATTEMPT,
    ...overrides,
  };
}

function attempt(id: string, status: ProcessingAttemptSummary["status"] = "running"): ProcessingAttemptSummary {
  return {
    id,
    trigger: "submit",
    status,
    started_at: "2026-06-19T00:00:00.000Z",
  };
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
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

// A terminal "ready" manifest as the success path builds it: no active_attempt,
// this attempt stamped as last_attempt.
function readyManifest(overrides: Partial<Manifest> = {}): Manifest {
  return manifest({
    status: "ready",
    title: "Test",
    tldr: "A short summary.",
    tags: ["x"],
    last_attempt: attempt(ATTEMPT, "succeeded"),
    ...overrides,
  });
}

function embedding(): number[] {
  return Array.from({ length: EMBEDDING_DIM }, () => 0.01);
}

function vectorOpt() {
  return {
    embedding: embedding(),
    meta: { url: URL, title: "Test", tags: ["x"], created_at: "2026-06-19T00:00:00.000Z" },
  };
}

// A fake VectorizeIndex mirroring installVectorizeStub, wrapped by the real
// SimilarityStore so upsert/delete/query exercise production code.
function fakeVectorize() {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const index = {
    upsert: vi.fn(async (vs: VectorizeVector[]) => {
      for (const v of vs) vectors.set(v.id, { values: v.values as number[], metadata: (v.metadata ?? {}) as Record<string, unknown> });
      return { mutationId: "m" } as VectorizeAsyncMutation;
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "m" } as VectorizeAsyncMutation;
    }),
    query: vi.fn(async () => ({ count: 0, matches: [] }) as unknown as VectorizeMatches),
  } as unknown as VectorizeIndex;
  return { index, vectors, similarity: new SimilarityStore(index) };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) await env.READINGS_BUCKET.delete(obj.key);
}

function newReader(): ReadingStore {
  return new ReadingStore(env.READINGS_BUCKET);
}

beforeEach(clearBucket);
afterEach(clearBucket);

describe("commitTerminalManifest", () => {
  it("1: active attempt matches + owns url → manifest written, index appended, vector upserted", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();

    const final = readyManifest();
    const out = await commitTerminalManifest(reader, similarity, args(), final, {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out).toEqual({ committed: true, published: true });
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(await reader.findListIndexItem(ID)).not.toBeNull();
    expect(vectors.has(ID)).toBe(true);
  });

  it("2: active-attempt conflict → no writes, no restore, committed:false", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt("at_OTHER") }));
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const { similarity } = fakeVectorize();

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out.committed).toBe(false);
    // The conflicting manifest is untouched and nothing (publish OR restore) writes the index.
    expect((await reader.readManifest(PREFIX))?.status).toBe("pending");
    expect(append).not.toHaveBeenCalled();
  });

  it("3: CAS loss → restoreIfOwner re-syncs the row, committed:false", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const { similarity } = fakeVectorize();

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out.committed).toBe(false);
    // restore re-appends the CURRENT (still-pending) manifest's list visibility.
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("4: owns-write but not url owner → list row + vector removed, committed:true", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    // Pointer owned by a DIFFERENT reading → ownerAllowsVisibility false → remove branch.
    await reader.writeByUrlPointer(URL_HASH, { id: "rd_OTHER", key_prefix: "other/prefix" });
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt(ATTEMPT) }), PREFIX),
    );
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out).toEqual({ committed: true, published: false });
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("5: no existing manifest → plain writeManifest (no CAS), committed:true", async () => {
    const reader = newReader();
    const plain = vi.spyOn(reader, "writeManifest");
    const cas = vi.spyOn(reader, "replaceManifestIfCurrent");
    const { similarity } = fakeVectorize();

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out.committed).toBe(true);
    expect(plain).toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
  });

  it("6: preserve-ready manifest (markFailed preserve branch) → committed + index appended", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });

    const preserve = readyManifest({
      active_attempt: undefined,
      last_attempt: attempt(ATTEMPT, "failed"),
    });
    const out = await commitTerminalManifest(reader, null, args(), preserve, {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
    });

    expect(out).toEqual({ committed: true, published: true });
    expect(await reader.findListIndexItem(ID)).not.toBeNull();
  });

  it("7: defensive + writeManifest throws → swallowed, restore, committed:false", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    vi.spyOn(reader, "replaceManifestIfCurrent").mockRejectedValue(new Error("R2 outage"));
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await commitTerminalManifest(reader, null, args(), readyManifest(), {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
    });

    expect(out.committed).toBe(false);
    expect(append).toHaveBeenCalledTimes(1); // restore
    consoleErr.mockRestore();
  });

  it("8: non-defensive + writeManifest throws → propagates (load-bearing)", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    vi.spyOn(reader, "replaceManifestIfCurrent").mockRejectedValue(new Error("R2 outage"));
    const { similarity } = fakeVectorize();

    await expect(
      commitTerminalManifest(reader, similarity, args(), readyManifest(), {
        claimMissingPointer: true,
        defensive: false,
        vector: vectorOpt(),
      }),
    ).rejects.toThrow("R2 outage");
  });

  it("9: failure-path asymmetry (similarity:null on remove) → list removed, vector untouched", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: "rd_OTHER", key_prefix: "other/prefix" });
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt(ATTEMPT) }), PREFIX),
    );
    const { vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });

    const out = await commitTerminalManifest(reader, null, args(), readyManifest(), {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
    });

    expect(out).toEqual({ committed: true, published: false });
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(true); // vector untouched on the failure path
  });

  it("10: instrument wraps each sub-write with its ProcessingStage", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity } = fakeVectorize();

    const stages: ProcessingStage[] = [];
    const instrument = <T>(stage: ProcessingStage, fn: () => Promise<T>): Promise<T> => {
      stages.push(stage);
      return fn();
    };

    await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      instrument,
    });

    expect(stages).toEqual(["write_manifest", "write_indexes", "upsert_vector"]);
  });

  it("11: defensive failure path + active-attempt conflict → no restore (unifies with success path)", async () => {
    // The failure-path divergence the extraction deliberately removed: pre-refactor
    // markFailed re-synced the foreign row via the restore path when a
    // conflicting attempt owned the manifest; the unified contract skips it (plan 005
    // case 2). Lock that: a foreign active_attempt under defensive:true writes nothing.
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt("at_OTHER") }));
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");

    const out = await commitTerminalManifest(reader, null, args(), readyManifest(), {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
    });

    expect(out).toEqual({ committed: false, published: false });
    expect((await reader.readManifest(PREFIX))?.active_attempt?.id).toBe("at_OTHER");
    expect(append).not.toHaveBeenCalled(); // no restore re-sync of the foreign row
  });

  it("12: CAS loss + not url owner → restore does NOT resurrect a removed row", async () => {
    // A non-owner duplicate (by-url pointer owned by a different reading) loses
    // the manifest CAS. The concurrent owner already reconciled visibility — and
    // may have deliberately removed this reading's list row. restoreIfOwner
    // must NOT blindly re-append it; that would resurrect a row the
    // owner unpublished. (Owns-pointer and no-pointer restores still re-sync — see
    // tests 3 and 7.)
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: "rd_OTHER", key_prefix: "other/prefix" });
    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const { similarity } = fakeVectorize();

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out.committed).toBe(false);
    expect(append).not.toHaveBeenCalled(); // no resurrection of the non-owner row
  });

  it("13: CAS loss + no url pointer (failure path) → restore still re-syncs the row", async () => {
    // The no-pointer branch is the failure-path default (ownerAllowsVisibility=true).
    // The Fix-#2 gate only suppresses re-append for a FOREIGN pointer; with no
    // pointer at all the row must still be restored. Guards against a future edit
    // that flips the `pointer && ...` short-circuit and breaks this default.
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    // No by-url pointer written.
    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");

    const out = await commitTerminalManifest(reader, null, args(), readyManifest(), {
      claimMissingPointer: false,
      allowLastAttempt: true,
      defensive: true,
    });

    expect(out.committed).toBe(false);
    expect(append).toHaveBeenCalledTimes(1); // no-pointer → restore re-syncs
  });
});
