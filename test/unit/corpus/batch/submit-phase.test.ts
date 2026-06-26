import { describe, expect, it, vi } from "vitest";
import { submitBatch } from "../../../../scripts/corpus-lib/batch/submit-phase";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { BatchActivationPolicy, SummarizeTarget } from "../../../../scripts/corpus-lib/batch/types";
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

function summarizeTarget(
  over: {
    manifest?: Partial<Manifest>;
    fresh?: ExtractedContent;
    freshActivation?: BatchActivationPolicy;
    similar?: any[];
  } = {},
): SummarizeTarget {
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
      ...(over.freshActivation ? { freshActivation: over.freshActivation } : {}),
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

const noopPut = () => vi.fn(async (_k: string, _b: any, _ct: string) => {});
const noopSave = () => vi.fn(async (_s: any) => {});

describe("submitBatch", () => {
  it("creates a batch with one request per target, custom_id = reading id, params = realtime body", async () => {
    const batch = fakeBatch();
    const { info } = await submitBatch([summarizeTarget()], {
      model: "claude-opus-4-8",
      batch: batch as any,
      putObject: noopPut(),
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

  it("persists freshly-extracted raw + extracted.md to R2 before summarizing", async () => {
    const batch = fakeBatch();
    const putObject = noopPut();
    await submitBatch([summarizeTarget({ fresh: freshContent })], {
      model: "m",
      batch: batch as any,
      putObject,
      saveSidecar: noopSave(),
    });
    const keys = putObject.mock.calls.map((c) => c[0]);
    expect(keys).toContain("readings/2026/01/01T000000Z-rd_a/raw.html");
    expect(keys).toContain("readings/2026/01/01T000000Z-rd_a/extracted.md");
  });

  it("does not write content objects when markdown was reused from R2", async () => {
    const batch = fakeBatch();
    const putObject = noopPut();
    await submitBatch([summarizeTarget()], { model: "m", batch: batch as any, putObject, saveSidecar: noopSave() });
    expect(putObject).not.toHaveBeenCalled();
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
    await submitBatch([summarizeTarget()], { model: "m", batch: batch as any, putObject: noopPut(), saveSidecar });
    expect(order).toEqual(["pending", "create", "final:msgbatch_99"]);
  });

  it("builds a sidecar carrying content fields, extracted_bytes, and the ready snapshot", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget({ manifest: { status: "ready", title: "Old", tldr: "old tldr" } })], {
      model: "claude-opus-4-8",
      batch: batch as any,
      putObject: noopPut(),
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
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(sidecar.targets[0]!.contentBytes).toBe(999);
    expect(sidecar.targets[0]!.contentSha256).toBe("e".repeat(64));
  });

  it("does not preserve a snapshot for a non-ready reading", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget()], { model: "m", batch: batch as any, putObject: noopPut(), saveSidecar: noopSave() });
    expect(sidecar.targets[0]!.preserveReadyManifest).toBeUndefined();
  });

  it.each([
    { kind: "create-new" as const, expectedRelease: true },
    {
      kind: "create-existing-failed" as const,
      expectedRelease: true,
      expected: {
        id: "rd_a",
        keyPrefix: "readings/2026/01/01T000000Z-rd_a",
        url: "https://example.com/a",
        urlHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      kind: "verify-existing-failed" as const,
      expectedRelease: undefined,
      expected: {
        id: "rd_a",
        keyPrefix: "readings/2026/01/01T000000Z-rd_a",
        url: "https://example.com/a",
        urlHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ])("marks by-url release on failure only when activation creates the claim: $kind", async ({ expectedRelease, ...policy }) => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch(
      [summarizeTarget({ freshActivation: policy as BatchActivationPolicy })],
      { model: "m", batch: batch as any, putObject: noopPut(), saveSidecar: noopSave() },
    );

    expect(sidecar.targets[0]!.releaseByUrlOnFailure).toBe(expectedRelease);
  });

  it("leaves a recover target (no activation policy) re-submittable: no release, preserve only when ready", async () => {
    const batch = fakeBatch();
    // recover-shaped: no freshActivation. Failed source → no release, no snapshot.
    const failed = await submitBatch([summarizeTarget()], {
      model: "m",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(failed.sidecar.targets[0]!.releaseByUrlOnFailure).toBeUndefined();
    expect(failed.sidecar.targets[0]!.preserveReadyManifest).toBeUndefined();

    // a ready recover source still rolls forward on failure but never releases by-url
    const ready = await submitBatch([summarizeTarget({ manifest: { status: "ready", tldr: "keep" } })], {
      model: "m",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(ready.sidecar.targets[0]!.releaseByUrlOnFailure).toBeUndefined();
    expect(ready.sidecar.targets[0]!.preserveReadyManifest?.status).toBe("ready");
  });
});
