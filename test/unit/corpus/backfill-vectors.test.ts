import { describe, expect, it, vi } from "vitest";
import { runVectorBackfill } from "../../../scripts/corpus-lib/backfill-vectors";
import { parseArgs } from "../../../scripts/corpus-backfill-vectors";

const AT = "2026-08-22T00:00:00.000Z";

function readyManifest(id = "rd_a") {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "ready" as const,
    title: "A title",
    tldr: "A stored TL;DR.",
    tags: ["AI", "ai", "Research"],
    content_type: "text/html",
    content_status: "captured" as const,
    content_bytes: 42,
    content_sha256: "b".repeat(64),
    created_at: AT,
    updated_at: AT,
  };
}

function readyRow(id = "rd_a") {
  return {
    id,
    url: `https://example.com/${id}`,
    status: "ready",
    key_prefix: `readings/2026/${id}`,
    created_at: AT,
  };
}

describe("runVectorBackfill", () => {
  it("dry-runs a ready manifest with a TL;DR and a confirmed vector miss without spending or writing", async () => {
    const embedMany = vi.fn();
    const upsert = vi.fn();

    const result = await runVectorBackfill(
      { execute: false },
      {
        readListIndex: async () => [readyRow()],
        vectorExists: async () => false,
        readManifest: async () => readyManifest(),
        embedMany,
        upsert,
      },
    );

    expect(result.eligible.map((target) => target.id)).toEqual(["rd_a"]);
    expect(result.restoredIds).toEqual([]);
    expect(embedMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("revalidates execute targets, embeds their stored TL;DRs, and upserts worker-shaped metadata", async () => {
    const vectorExists = vi.fn(async () => false);
    const readManifest = vi.fn(async () => readyManifest());
    const embedding = Array.from({ length: 1536 }, () => 0.25);
    const embedMany = vi.fn(async () => ({ embeddings: [embedding] }));
    const upsert = vi.fn(async () => undefined);

    const result = await runVectorBackfill(
      { execute: true },
      {
        readListIndex: async () => [readyRow()],
        vectorExists,
        readManifest,
        embedMany,
        upsert,
      },
    );

    expect(vectorExists).toHaveBeenCalledTimes(2);
    expect(readManifest).toHaveBeenCalledTimes(2);
    expect(embedMany).toHaveBeenCalledWith(["A stored TL;DR."]);
    expect(upsert).toHaveBeenCalledWith([
      {
        id: "rd_a",
        values: embedding,
        metadata: {
          url: "https://example.com/rd_a",
          title: "A title",
          tldr: "A stored TL;DR.",
          tags: ["ai", "research"],
          created_at: AT,
        },
      },
    ]);
    expect(result.restoredIds).toEqual(["rd_a"]);
  });

  it("reports corrupt or ineligible missing-vector manifests instead of silently embedding them", async () => {
    const manifests: Record<string, unknown> = {
      "readings/2026/rd_invalid": { nope: true },
      "readings/2026/rd_pending": {
        ...readyManifest("rd_pending"),
        status: "pending",
      },
      "readings/2026/rd_no_tldr": {
        ...readyManifest("rd_no_tldr"),
        tldr: undefined,
      },
      "readings/2026/rd_drift": {
        ...readyManifest("rd_drift"),
        url: "https://example.com/a-different-reading",
      },
    };

    const result = await runVectorBackfill(
      { execute: false },
      {
        readListIndex: async () => [
          readyRow("rd_invalid"),
          readyRow("rd_pending"),
          readyRow("rd_no_tldr"),
          readyRow("rd_drift"),
        ],
        vectorExists: async () => false,
        readManifest: async (keyPrefix) => manifests[keyPrefix] ?? null,
        embedMany: vi.fn(),
        upsert: vi.fn(),
      },
    );

    expect(result.eligible).toEqual([]);
    expect(result.problems).toEqual([
      { id: "rd_invalid", kind: "manifest_invalid" },
      { id: "rd_pending", kind: "manifest_not_ready" },
      { id: "rd_no_tldr", kind: "missing_tldr" },
      { id: "rd_drift", kind: "identity_mismatch" },
    ]);
  });

  it("reports an unreadable manifest and continues scanning later candidates", async () => {
    const result = await runVectorBackfill(
      { execute: false },
      {
        readListIndex: async () => [readyRow("rd_corrupt"), readyRow("rd_good")],
        vectorExists: async () => false,
        readManifest: async (keyPrefix) => {
          if (keyPrefix.endsWith("rd_corrupt")) throw new SyntaxError("bad JSON");
          return readyManifest("rd_good");
        },
        embedMany: vi.fn(),
        upsert: vi.fn(),
      },
    );

    expect(result.problems).toEqual([
      { id: "rd_corrupt", kind: "manifest_invalid" },
    ]);
    expect(result.eligible.map((target) => target.id)).toEqual(["rd_good"]);
  });

  it("refuses an embedding response that cannot map one 1536-dimensional vector to every target", async () => {
    const upsert = vi.fn();

    await expect(
      runVectorBackfill(
        { execute: true },
        {
          readListIndex: async () => [readyRow()],
          vectorExists: async () => false,
          readManifest: async () => readyManifest(),
          embedMany: async () => ({ embeddings: [[0.1, 0.2]] }),
          upsert,
        },
      ),
    ).rejects.toThrow(/1536/);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("reports non-ready and already-indexed skips so reruns show their resumability", async () => {
    const result = await runVectorBackfill(
      { execute: false },
      {
        readListIndex: async () => [
          { ...readyRow("rd_failed"), status: "failed" },
          readyRow("rd_indexed"),
          readyRow("rd_missing"),
        ],
        vectorExists: async (id) => id === "rd_indexed",
        readManifest: async () => readyManifest("rd_missing"),
        embedMany: vi.fn(),
        upsert: vi.fn(),
      },
    );

    expect(result.eligible.map((target) => target.id)).toEqual(["rd_missing"]);
    expect(result.stats).toEqual({
      corpus: 3,
      considered: 3,
      skippedNotReady: 1,
      alreadyIndexed: 1,
      raced: 0,
    });
  });

  it("applies positional IDs and limits to eligible misses rather than indexed rows", async () => {
    const vectorExists = vi.fn(async (id: string) => id === "rd_indexed");
    const result = await runVectorBackfill(
      { execute: false, only: ["rd_indexed", "rd_first", "rd_second"], limit: 1 },
      {
        readListIndex: async () => [
          readyRow("rd_ignored"),
          readyRow("rd_indexed"),
          readyRow("rd_first"),
          readyRow("rd_second"),
        ],
        vectorExists,
        readManifest: async () => readyManifest("rd_first"),
        embedMany: vi.fn(),
        upsert: vi.fn(),
      },
    );

    expect(result.eligible.map((target) => target.id)).toEqual(["rd_first"]);
    expect(vectorExists.mock.calls.flat()).toEqual(["rd_indexed", "rd_first"]);
  });

  it("skips a vector that appears during the execute precheck", async () => {
    const vectorExists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const embedMany = vi.fn();
    const upsert = vi.fn();

    const result = await runVectorBackfill(
      { execute: true },
      {
        readListIndex: async () => [readyRow()],
        vectorExists,
        readManifest: async () => readyManifest(),
        embedMany,
        upsert,
      },
    );

    expect(result.eligible).toEqual([]);
    expect(result.stats.raced).toBe(1);
    expect(embedMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not embed a target whose manifest becomes unreadable during execute revalidation", async () => {
    const embedMany = vi.fn();
    const upsert = vi.fn();
    const readManifest = vi.fn()
      .mockResolvedValueOnce(readyManifest())
      .mockRejectedValueOnce(new SyntaxError("bad JSON"));

    const result = await runVectorBackfill(
      { execute: true },
      {
        readListIndex: async () => [readyRow()],
        vectorExists: async () => false,
        readManifest,
        embedMany,
        upsert,
      },
    );

    expect(result.problems).toEqual([
      { id: "rd_a", kind: "manifest_invalid" },
    ]);
    expect(result.eligible).toEqual([]);
    expect(embedMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("corpus-backfill-vectors CLI", () => {
  it("is remote and dry-run by default, with positional IDs and bounded execute flags", () => {
    expect(parseArgs([], {})).toEqual({
      only: [],
      bucket: "reading-lite",
      vectorizeIndex: undefined,
      remote: true,
      execute: false,
      limit: undefined,
    });
    expect(
      parseArgs(
        ["rd_a", "rd_b", "--bucket", "reading-lite-staging", "--vectorize", "vec-stg", "--limit", "2", "--execute"],
        {},
      ),
    ).toEqual({
      only: ["rd_a", "rd_b"],
      bucket: "reading-lite-staging",
      vectorizeIndex: "vec-stg",
      remote: true,
      execute: true,
      limit: 2,
    });
  });

  it("rejects --local because this Vectorize repair has no local index", () => {
    expect(() => parseArgs(["--local"], {})).toThrow(/Vectorize has no local store/i);
    expect(() => parseArgs(["--local", "--execute"], {})).toThrow(/Vectorize has no local store/i);
  });
});
