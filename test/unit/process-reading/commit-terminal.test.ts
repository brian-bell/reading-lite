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
import type { VectorLedger } from "../../../src/control-plane/vector-ledger";
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
    meta: { url: URL, title: "Test", tldr: "Test tldr.", tags: ["x"], created_at: "2026-06-19T00:00:00.000Z" },
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
    // The by-id pointer is the liveness witness: activation always writes it,
    // and without any witness a missing manifest reads as purged (case 5b).
    await reader.writeByIdPointer(ID, { id: ID, key_prefix: PREFIX });
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

  it("5b: no manifest and no liveness witness (purged reading) → nothing written", async () => {
    const reader = newReader();
    const plain = vi.spyOn(reader, "writeManifest");
    const pointerWrite = vi.spyOn(reader, "writeByUrlPointer");
    const { similarity, index } = fakeVectorize();

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out).toEqual({ committed: false, published: false });
    expect(plain).not.toHaveBeenCalled();
    expect(pointerWrite).not.toHaveBeenCalled();
    expect(index.upsert).not.toHaveBeenCalled();
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

  it("14: tenant deletion fence skips publish and restore after terminal CAS", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(readyManifest({ status: "pending" }), PREFIX));
    const { similarity, vectors } = fakeVectorize();

    const published = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => false,
    });
    expect(published).toEqual({ committed: true, published: false });
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);

    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const restored = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => false,
    });
    expect(restored).toEqual({ committed: false, published: false });
    expect(append).not.toHaveBeenCalled();
  });

  it("15: status flips to deleting between pre-publish check and publish → compensate remove", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    let checks = 0;

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => {
        checks += 1;
        return checks === 1;
      },
    });

    expect(out).toEqual({ committed: true, published: false });
    expect(checks).toBe(2);
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("16: status flips to deleting between restore check and restore write → compensate remove", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(readyManifest({ status: "pending" }), PREFIX));
    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: { url: URL } });
    let checks = 0;

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => {
        checks += 1;
        return checks === 1;
      },
    });

    expect(out).toEqual({ committed: false, published: false });
    expect(checks).toBe(2);
    expect(await reader.findListIndexItem(ID)).toBeNull();
  });

  it("17: D1 throw after terminal CAS fail-opens and still publishes", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => {
        throw new Error("D1 hiccup");
      },
    });

    consoleErr.mockRestore();
    expect(out).toEqual({ committed: true, published: true });
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(await reader.findListIndexItem(ID)).not.toBeNull();
    expect(vectors.has(ID)).toBe(true);
  });

  it("18: D1 throw on the post-publish recheck keeps visibility (compensate only on confirmed false)", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    let checks = 0;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => {
        checks += 1;
        if (checks === 1) return true;
        throw new Error("D1 hiccup");
      },
    });

    consoleErr.mockRestore();
    expect(out).toEqual({ committed: true, published: true });
    expect(checks).toBe(2);
    expect(await reader.findListIndexItem(ID)).not.toBeNull();
    expect(vectors.has(ID)).toBe(true);
  });

  it("19: after ready CAS, tenant-fence remove throw leaves ready (does not propagate)", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    vi.spyOn(reader, "removeListIndexItemIf").mockRejectedValue(new Error("R2 hide failure"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => false,
    });

    consoleErr.mockRestore();
    expect(out).toEqual({ committed: true, published: false });
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(vectors.has(ID)).toBe(false);
  });

  it("20: after ready CAS, post-publish compensate remove throw leaves ready", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity } = fakeVectorize();
    let checks = 0;
    vi.spyOn(reader, "removeListIndexItemIf").mockRejectedValue(new Error("R2 hide failure"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      tenantAllowsVisibility: async () => {
        checks += 1;
        return checks === 1;
      },
    });

    consoleErr.mockRestore();
    expect(out).toEqual({ committed: true, published: false });
    expect(checks).toBe(2);
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
  });

  it("21: purge tombstone skips terminal write, markLive, publish, restore, and by-url reclaim", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(readyManifest({ status: "pending" }), PREFIX));
    await reader.writePurgeTombstone(ID);
    const { similarity, vectors } = fakeVectorize();
    const markLive = vi.fn(async () => {});
    const ledger = {
      markLive,
      markDeleteSubmitted: vi.fn(async () => {}),
    } as unknown as VectorLedger;

    const published = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      ledger,
    });
    expect(published).toEqual({ committed: false, published: false });
    expect(markLive).not.toHaveBeenCalled();
    expect((await reader.readManifest(PREFIX))?.status).toBe("pending");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(await reader.readByUrlPointer(URL_HASH)).toBeNull();
    expect(vectors.has(ID)).toBe(false);

    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const restored = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      ledger,
    });
    expect(restored).toEqual({ committed: false, published: false });
    expect(append).not.toHaveBeenCalled();
  });

  it("22: tombstone appears between pre-publish check and publish → compensate removeForDeletedTenant", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    let checks = 0;
    vi.spyOn(reader, "hasPurgeTombstone").mockImplementation(async () => {
      checks += 1;
      return checks > 1;
    });

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out).toEqual({ committed: true, published: false });
    expect(checks).toBe(2);
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(await reader.readByUrlPointer(URL_HASH)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("23: tombstone appears between restore check and restore write → compensate remove", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(readyManifest({ status: "pending" }), PREFIX));
    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: { url: URL } });
    let checks = 0;
    vi.spyOn(reader, "hasPurgeTombstone").mockImplementation(async () => {
      checks += 1;
      return checks > 1;
    });

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out).toEqual({ committed: false, published: false });
    expect(checks).toBe(2);
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(await reader.readByUrlPointer(URL_HASH)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("23b: lost-CAS tombstone compensate throw is swallowed on the success path", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(readyManifest({ status: "pending" }), PREFIX));
    vi.spyOn(reader, "replaceManifestIfCurrent").mockResolvedValue(false);
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: { url: URL } });
    let checks = 0;
    vi.spyOn(reader, "hasPurgeTombstone").mockImplementation(async () => {
      checks += 1;
      return checks > 1;
    });
    vi.spyOn(reader, "deleteByUrlPointer").mockRejectedValue(new Error("by-url delete failed"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      commitTerminalManifest(reader, similarity, args(), readyManifest(), {
        claimMissingPointer: true,
        defensive: false,
        vector: vectorOpt(),
      }),
    ).resolves.toEqual({ committed: false, published: false });

    consoleErr.mockRestore();
    expect(checks).toBe(2);
    expect((await reader.readManifest(PREFIX))?.status).toBe("pending");
  });

  it("24: tombstone lookup throw after terminal CAS fail-opens and still publishes", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(reader, "hasPurgeTombstone").mockRejectedValue(new Error("R2 hiccup"));

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    consoleErr.mockRestore();
    expect(out).toEqual({ committed: true, published: true });
    expect((await reader.readManifest(PREFIX))?.status).toBe("ready");
    expect(await reader.findListIndexItem(ID)).not.toBeNull();
    expect(vectors.has(ID)).toBe(true);
  });

  it("25: tombstone compensate deletes the vector even when the list row is already gone", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    await reader.writePurgeTombstone(ID);
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: { url: URL } });

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
    });

    expect(out).toEqual({ committed: false, published: false });
    expect((await reader.readManifest(PREFIX))?.status).toBe("pending");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(await reader.readByUrlPointer(URL_HASH)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("26: confirmed tombstone then later HEAD throw still skips terminal write and publish", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const { similarity, vectors } = fakeVectorize();
    const markLive = vi.fn(async () => {});
    const ledger = {
      markLive,
      markDeleteSubmitted: vi.fn(async () => {}),
    } as unknown as VectorLedger;
    let checks = 0;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(reader, "hasPurgeTombstone").mockImplementation(async () => {
      checks += 1;
      if (checks === 1) return true;
      throw new Error("R2 hiccup");
    });

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      ledger,
    });

    consoleErr.mockRestore();
    expect(out).toEqual({ committed: false, published: false });
    expect(markLive).not.toHaveBeenCalled();
    expect(checks).toBe(1);
    expect((await reader.readManifest(PREFIX))?.status).toBe("pending");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(await reader.readByUrlPointer(URL_HASH)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("27: pointer-missing + tombstone does not reclaim by-url", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writePurgeTombstone(ID);
    const pointerWrite = vi.spyOn(reader, "writeByUrlPointer");
    const { similarity, vectors } = fakeVectorize();
    const markLive = vi.fn(async () => {});
    const ledger = {
      markLive,
      markDeleteSubmitted: vi.fn(async () => {}),
    } as unknown as VectorLedger;

    const out = await commitTerminalManifest(reader, similarity, args(), readyManifest(), {
      claimMissingPointer: true,
      defensive: false,
      vector: vectorOpt(),
      ledger,
    });

    expect(out).toEqual({ committed: false, published: false });
    expect(pointerWrite).not.toHaveBeenCalled();
    expect(markLive).not.toHaveBeenCalled();
    expect(await reader.readByUrlPointer(URL_HASH)).toBeNull();
    expect((await reader.readManifest(PREFIX))?.status).toBe("pending");
    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });
});
