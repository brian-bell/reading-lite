import { describe, expect, it, vi } from "vitest";
import {
  assertBatchWithinSizeCap,
  buildSummarizeRequest,
  submitBatch,
} from "../../../../scripts/corpus-lib/batch/submit-phase";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { SummarizeTarget } from "../../../../scripts/corpus-lib/batch/types";
import type { Manifest } from "../../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../../src/modules/extractor";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 42,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

function summarizeTarget(over: { manifest?: Partial<Manifest>; fresh?: ExtractedContent; similar?: any[] } = {}): SummarizeTarget {
  const m = manifest(over.manifest);
  return {
    extracted: {
      target: {
        readingId: m.id,
        url: m.url,
        urlHash: m.url_hash,
        keyPrefix: "readings/2026/01/01T000000Z-rd_a",
        createdAt: m.created_at,
        manifest: m,
      },
      markdown: "# Article\n\nbody",
      title: "Article",
      ...(over.fresh ? { fresh: over.fresh } : {}),
    },
    similar: over.similar ?? [],
    queryEmbedTokens: 12,
  };
}

const freshContent: ExtractedContent = {
  raw: new TextEncoder().encode("<html>body</html>"),
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 17,
  content_sha256: "f".repeat(64),
  markdown: "# Article\n\nbody",
  title: "Article",
};

function fakeBatch() {
  return {
    create: vi.fn(async (_requests: any[]) => ({ id: "msgbatch_99", processing_status: "in_progress", results_url: null })),
    get: vi.fn(),
    results: vi.fn(),
  };
}

const noopSave = () => vi.fn(async (_s: any) => {});

describe("submitBatch", () => {
  it("creates a batch with one request per target, custom_id = reading id, params = realtime body", async () => {
    const batch = fakeBatch();
    const { info } = await submitBatch([summarizeTarget()], {
      model: "claude-opus-4-8",
      batch: batch as any,
      saveSidecar: noopSave(),
    });
    expect(info.id).toBe("msgbatch_99");
    const requests = batch.create.mock.calls[0]![0];
    expect(requests).toHaveLength(1);
    expect(requests[0].custom_id).toBe("rd_a");
    expect(requests[0].params.model).toBe("claude-opus-4-8");
    expect(requests[0].params.tool_choice).toEqual({ type: "tool", name: EMIT_READING_TOOL_NAME });
    const userText = JSON.stringify(requests[0].params.messages);
    expect(userText).toContain("# Article");
    expect(userText).toContain("https://example.com/a");
  });

  it("persists a pending sidecar (no batchId) BEFORE create, then the real one after", async () => {
    const batch = fakeBatch();
    const order: string[] = [];
    const saveSidecar = vi.fn(async (s: any) => {
      order.push(s.batchId === "" ? "pending" : `final:${s.batchId}`);
    });
    batch.create = vi.fn(async (_r: any[]) => {
      order.push("create");
      return { id: "msgbatch_99", processing_status: "in_progress", results_url: null };
    });
    await submitBatch([summarizeTarget()], { model: "m", batch: batch as any, saveSidecar });
    expect(order).toEqual(["pending", "create", "final:msgbatch_99"]);
  });

  it("builds a sidecar carrying content fields, extracted_bytes, and the ready snapshot", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget({ manifest: { status: "ready", title: "Old", tldr: "old tldr" } })], {
      model: "claude-opus-4-8",
      batch: batch as any,
      saveSidecar: noopSave(),
    });
    expect(sidecar.batchId).toBe("msgbatch_99");
    const t = sidecar.targets[0]!;
    expect(t).toMatchObject({
      customId: "rd_a",
      keyPrefix: "readings/2026/01/01T000000Z-rd_a",
      contentType: "text/html",
      contentBytes: 42,
      contentStatus: "captured",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // extracted_bytes computed from the markdown actually summarized.
    expect(t.extractedBytes).toBe(new TextEncoder().encode("# Article\n\nbody").byteLength);
    // query-embedding cost carried through so a resumed write still records it.
    expect(t.queryEmbedTokens).toBe(12);
    expect(t.preserveReadyManifest?.status).toBe("ready");
    expect(t.preserveReadyManifest?.tldr).toBe("old tldr");
  });

  it("takes raw-object fields from the fresh extract when re-extracted", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget({ fresh: { ...freshContent, content_bytes: 999, content_sha256: "e".repeat(64) } })], {
      model: "m",
      batch: batch as any,
      saveSidecar: noopSave(),
    });
    expect(sidecar.targets[0]!.contentBytes).toBe(999);
    expect(sidecar.targets[0]!.contentSha256).toBe("e".repeat(64));
  });

  it("does not preserve a snapshot for a non-ready reading", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget()], { model: "m", batch: batch as any, saveSidecar: noopSave() });
    expect(sidecar.targets[0]!.preserveReadyManifest).toBeUndefined();
  });
});

describe("assertBatchWithinSizeCap", () => {
  it("passes when the request set is within the cap", () => {
    const requests = [buildSummarizeRequest(summarizeTarget(), "m")];
    expect(() => assertBatchWithinSizeCap(requests, 10_000_000)).not.toThrow();
  });

  it("throws with --limit guidance when the request set exceeds the cap", () => {
    const requests = [buildSummarizeRequest(summarizeTarget(), "m")];
    // A 1-byte cap is trivially exceeded by any real request.
    expect(() => assertBatchWithinSizeCap(requests, 1)).toThrow(/exceeds.*safety cap.*--limit/s);
  });
});
