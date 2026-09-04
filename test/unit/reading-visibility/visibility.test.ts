import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingVisibility } from "../../../src/reading-visibility";
import { type ProcessReadingArgs } from "../../../src/process-reading";
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

function attempt(
  id: string,
  status: ProcessingAttemptSummary["status"] = "running",
): ProcessingAttemptSummary {
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
      for (const v of vs)
        vectors.set(v.id, {
          values: v.values as number[],
          metadata: (v.metadata ?? {}) as Record<string, unknown>,
        });
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

describe("ReadingVisibility.publish", () => {
  it("writes the list row and upserts the vector", async () => {
    const reader = newReader();
    const { similarity, vectors } = fakeVectorize();
    const vis = new ReadingVisibility(reader, similarity);

    await vis.publish(readyManifest(), args(), vectorOpt());

    expect(await reader.findListIndexItem(ID)).not.toBeNull();
    expect(vectors.has(ID)).toBe(true);
  });

  it("writes the list row only when similarity is null", async () => {
    const reader = newReader();
    const vis = new ReadingVisibility(reader, null);

    await vis.publish(readyManifest(), args(), vectorOpt());

    expect(await reader.findListIndexItem(ID)).not.toBeNull();
  });

  it("emits a ProcessingStage event per sub-write through the instrument", async () => {
    const reader = newReader();
    const { similarity } = fakeVectorize();
    const vis = new ReadingVisibility(reader, similarity);

    const stages: ProcessingStage[] = [];
    const instrument = <T>(stage: ProcessingStage, fn: () => Promise<T>): Promise<T> => {
      stages.push(stage);
      return fn();
    };

    await vis.publish(readyManifest(), args(), vectorOpt(), { instrument });

    expect(stages).toEqual(["write_indexes", "upsert_vector"]);
  });
});

describe("ReadingVisibility.remove", () => {
  it("deletes both the list row and the vector when this attempt owns them", async () => {
    const reader = newReader();
    // Manifest owned by this attempt (vacant-pending list gate matches).
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt(ATTEMPT) }), PREFIX),
    );
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });
    const vis = new ReadingVisibility(reader, similarity);

    await vis.remove(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("is a no-op when a foreign attempt owns the list row", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt("at_OTHER") }));
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt("at_OTHER") }), PREFIX),
    );
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });
    const vis = new ReadingVisibility(reader, similarity);

    await vis.remove(args());

    expect(await reader.findListIndexItem(ID)).not.toBeNull();
    expect(vectors.has(ID)).toBe(true);
  });

  it("removes the list row but keeps the vector when the manifest gate refuses", async () => {
    const reader = newReader();
    // List row is vacant-pending (gate matches) but the manifest now carries a
    // foreign last_attempt → vector gate refuses.
    await reader.writeManifest(
      PREFIX,
      manifest({ status: "failed", last_attempt: attempt("at_FOREIGN", "failed") }),
    );
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest(), PREFIX));
    const { similarity, index, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });
    const vis = new ReadingVisibility(reader, similarity);

    await vis.remove(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(true);
    expect(index.deleteByIds).not.toHaveBeenCalled();
  });

  it("removes the list row only when similarity is null (failure-path asymmetry)", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt(ATTEMPT) }), PREFIX),
    );
    const vis = new ReadingVisibility(reader, null);

    await vis.remove(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
  });
});

describe("ReadingVisibility.removeForDeletedTenant", () => {
  it("deletes the vector even though there is no list row to remove", async () => {
    const reader = newReader();
    // The account wipe has already deleted index/list.json and the manifest;
    // this consumer published a vector after the wipe collected its ids.
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });
    const vis = new ReadingVisibility(reader, similarity);

    await vis.removeForDeletedTenant(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("deletes the vector even when the manifest ownership gate would refuse", async () => {
    const reader = newReader();
    await reader.writeManifest(
      PREFIX,
      manifest({ status: "failed", last_attempt: attempt("at_FOREIGN", "failed") }),
    );
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest(), PREFIX));
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });
    const vis = new ReadingVisibility(reader, similarity);

    await vis.removeForDeletedTenant(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("removes an owned list row alongside the vector", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt(ATTEMPT) }), PREFIX),
    );
    const { similarity, vectors } = fakeVectorize();
    vectors.set(ID, { values: embedding(), metadata: {} });
    const vis = new ReadingVisibility(reader, similarity);

    await vis.removeForDeletedTenant(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
    expect(vectors.has(ID)).toBe(false);
  });

  it("is list-only when similarity is null (failure-path asymmetry)", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(manifest({ active_attempt: attempt(ATTEMPT) }), PREFIX),
    );
    const vis = new ReadingVisibility(reader, null);

    await vis.removeForDeletedTenant(args());

    expect(await reader.findListIndexItem(ID)).toBeNull();
  });
});

describe("ReadingVisibility.restoreIfOwner", () => {
  it("re-appends the current row when the by-url pointer still points here", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: ID, key_prefix: PREFIX });
    const vis = new ReadingVisibility(reader, null);

    await vis.restoreIfOwner(args());

    expect(await reader.findListIndexItem(ID)).not.toBeNull();
  });

  it("does not resurrect the row when the pointer points at another reading", async () => {
    const reader = newReader();
    await reader.writeManifest(PREFIX, manifest({ active_attempt: attempt(ATTEMPT) }));
    await reader.writeByUrlPointer(URL_HASH, { id: "rd_OTHER", key_prefix: "other/prefix" });
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const vis = new ReadingVisibility(reader, null);

    await vis.restoreIfOwner(args());

    expect(append).not.toHaveBeenCalled();
  });

  it("is a no-op when no manifest exists", async () => {
    const reader = newReader();
    const append = vi.spyOn(reader, "appendOrReplaceListIndexItem");
    const vis = new ReadingVisibility(reader, null);

    await vis.restoreIfOwner(args());

    expect(append).not.toHaveBeenCalled();
  });
});
