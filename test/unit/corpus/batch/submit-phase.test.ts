import { describe, expect, it, vi } from "vitest";
import {
  submitBatch,
  submitOpenAIBatch,
} from "../../../../scripts/corpus-lib/batch/submit-phase";
import { prepareOpenAIBatchPayload } from "../../../../scripts/corpus-lib/batch/openai-payload";
import type {
  BatchActivationPolicy,
  PersistedSidecar,
  SummarizeTarget,
} from "../../../../scripts/corpus-lib/batch/types";
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
        attemptId: "at_submit_1",
        attemptStartedAt: "2026-06-22T12:00:00.000Z",
        trigger: "reprocess",
        manifest: m,
      },
      markdown: "# Article\n\nbody",
      title: "Article",
      ...(over.fresh ? { fresh: over.fresh } : {}),
      ...(over.freshActivation ? { freshActivation: over.freshActivation } : {}),
    },
    similar: over.similar ?? [],
    queryEmbedTokens: 12,
    similarity: { count: 0, computed_at: "2026-08-22T00:00:00.000Z" },
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
      effort: "low",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(info.id).toBe("msgbatch_99");
    const requests = batch.create.mock.calls[0]![0];
    expect(requests).toHaveLength(1);
    expect(requests[0].custom_id).toBe("rd_a");
    expect(requests[0].params.model).toBe("claude-opus-4-8");
    expect(requests[0].params.tool_choice).toEqual({ type: "any" });
    const userText = JSON.stringify(requests[0].params.messages);
    expect(userText).toContain("# Article");
    expect(userText).toContain("https://example.com/a");
    expect(requests[0].params.output_config).toEqual({ effort: "low" });
  });

  it("passes the configured Anthropic effort on the realtime request body", async () => {
    const batch = fakeBatch();
    await submitBatch([summarizeTarget()], {
      model: "claude-sonnet-5",
      effort: "max",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    const requests = batch.create.mock.calls[0]![0];
    expect(requests[0].params.output_config).toEqual({ effort: "max" });
    expect(requests[0].params.max_tokens).toBe(8192);
    expect(requests[0].params.thinking).toEqual({ type: "disabled" });
  });

  it("persists freshly-extracted raw + extracted.md to R2 before summarizing", async () => {
    const batch = fakeBatch();
    const putObject = noopPut();
    await submitBatch([summarizeTarget({ fresh: freshContent })], {
      model: "m",
      effort: "low",
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
    await submitBatch([summarizeTarget()], { model: "m", effort: "low", batch: batch as any, putObject, saveSidecar: noopSave() });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("persists a pending sidecar (no batchId) BEFORE create, then the real one after", async () => {
    const batch = fakeBatch();
    const order: string[] = [];
    const saved: any[] = [];
    const saveSidecar = vi.fn(async (s: any) => {
      saved.push(s);
      order.push(s.batchId === "" ? "pending" : `final:${s.batchId}`);
    });
    batch.create = vi.fn(async (_r: any[]) => {
      order.push("create");
      return { id: "msgbatch_99", processing_status: "in_progress", results_url: null };
    });
    await submitBatch([summarizeTarget()], { model: "m", effort: "low", batch: batch as any, putObject: noopPut(), saveSidecar });
    expect(order).toEqual(["pending", "create", "final:msgbatch_99"]);
    expect(saved).toMatchObject([
      {
        version: 2,
        provider: "anthropic",
        phase: "creating",
        batchId: "",
        model: "m",
      },
      {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_99",
        model: "m",
      },
    ]);
    expect(saved[1].targets).toEqual(saved[0].targets);
  });

  it("builds a sidecar carrying content fields, extracted_bytes, and the ready snapshot", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget({ manifest: { status: "ready", title: "Old", tldr: "old tldr" } })], {
      model: "claude-opus-4-8",
      effort: "low",
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
      attemptId: "at_submit_1",
      attemptStartedAt: "2026-06-22T12:00:00.000Z",
      trigger: "reprocess",
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
      effort: "low",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(sidecar.targets[0]!.contentBytes).toBe(999);
    expect(sidecar.targets[0]!.contentSha256).toBe("e".repeat(64));
  });

  it("does not preserve a snapshot for a non-ready reading", async () => {
    const batch = fakeBatch();
    const { sidecar } = await submitBatch([summarizeTarget()], { model: "m", effort: "low", batch: batch as any, putObject: noopPut(), saveSidecar: noopSave() });
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
      { model: "m", effort: "low", batch: batch as any, putObject: noopPut(), saveSidecar: noopSave() },
    );

    expect(sidecar.targets[0]!.releaseByUrlOnFailure).toBe(expectedRelease);
  });

  it("leaves a recover target (no activation policy) re-submittable: no release, preserve only when ready", async () => {
    const batch = fakeBatch();
    // recover-shaped: no freshActivation. Failed source → no release, no snapshot.
    const failed = await submitBatch([summarizeTarget()], {
      model: "m",
      effort: "low",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(failed.sidecar.targets[0]!.releaseByUrlOnFailure).toBeUndefined();
    expect(failed.sidecar.targets[0]!.preserveReadyManifest).toBeUndefined();

    // a ready recover source still rolls forward on failure but never releases by-url
    const ready = await submitBatch([summarizeTarget({ manifest: { status: "ready", tldr: "keep" } })], {
      model: "m",
      effort: "low",
      batch: batch as any,
      putObject: noopPut(),
      saveSidecar: noopSave(),
    });
    expect(ready.sidecar.targets[0]!.releaseByUrlOnFailure).toBeUndefined();
    expect(ready.sidecar.targets[0]!.preserveReadyManifest?.status).toBe("ready");
  });
});

describe("submitOpenAIBatch", () => {
  it("uploads the exact preflighted bytes and checkpoints each non-idempotent boundary", async () => {
    const target = summarizeTarget();
    const prepared = prepareOpenAIBatchPayload(
      [target],
      "gpt-5.6-terra",
      "low",
    );
    const order: string[] = [];
    const saved: PersistedSidecar[] = [];
    const client = {
      upload: vi.fn(async (jsonl: string, runId: string) => {
        order.push(`upload:${runId}`);
        expect(jsonl).toBe(prepared.jsonl);
        return {
          id: "file_input",
          filename: `reading-lite-${runId}.jsonl`,
          purpose: "batch",
          bytes: prepared.byteCount,
        };
      }),
      create: vi.fn(async (inputFileId: string, runId: string) => {
        order.push(`create:${inputFileId}:${runId}`);
        return {
          id: "batch_1",
          input_file_id: inputFileId,
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
        };
      }),
      get: vi.fn(),
      content: vi.fn(),
      listFiles: vi.fn(async () => ({ data: [], has_more: false })),
      listBatches: vi.fn(async () => ({ data: [], raw: [], has_more: false })),
    };

    const result = await submitOpenAIBatch([target], prepared, {
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      runId: "run_stable",
      batch: client,
      putObject: noopPut(),
      saveInputJsonl: vi.fn(async (jsonl: string) => {
        order.push(`saveJsonl:${jsonl.length}`);
      }),
      saveSidecar: vi.fn(async (sidecar: PersistedSidecar) => {
        saved.push(sidecar);
        order.push(`save:${sidecar.phase}`);
      }),
      acquireLock: async () => ({
        release: async () => undefined,
      }),
      loadSidecar: async () => null,
    });

    expect(order).toEqual([
      `saveJsonl:${prepared.jsonl.length}`,
      "save:uploading",
      "upload:run_stable",
      "save:creating",
      "create:file_input:run_stable",
      "save:submitted",
    ]);
    expect(saved[0]!.targets).toEqual(result.sidecar.targets);
    expect(saved).toMatchObject([
      {
        provider: "openai",
        phase: "uploading",
        runId: "run_stable",
        inputFileId: null,
      },
      {
        provider: "openai",
        phase: "creating",
        runId: "run_stable",
        inputFileId: "file_input",
      },
      {
        provider: "openai",
        phase: "submitted",
        runId: "run_stable",
        batchId: "batch_1",
        inputFileId: "file_input",
      },
    ]);
    expect(result.sidecar.targets).toEqual(saved[0]!.targets);
  });

  it("holds the sidecar lock from before upload until after the submitted checkpoint", async () => {
    const target = summarizeTarget();
    const prepared = prepareOpenAIBatchPayload(
      [target],
      "gpt-5.6-terra",
      "low",
    );
    const events: string[] = [];
    const lock = {
      heartbeat: vi.fn(async () => {
        events.push("heartbeat");
      }),
      release: vi.fn(async () => {
        events.push("release");
      }),
    };
    const client = {
      upload: vi.fn(async () => {
        events.push("upload");
        return {
          id: "file_input",
          filename: "reading-lite-run_stable.jsonl",
          purpose: "batch",
          bytes: prepared.byteCount,
        };
      }),
      create: vi.fn(async () => {
        events.push("create");
        return {
          id: "batch_1",
          input_file_id: "file_input",
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
        };
      }),
      get: vi.fn(),
      content: vi.fn(),
      listFiles: vi.fn(async () => ({ data: [], has_more: false })),
      listBatches: vi.fn(async () => ({ data: [], raw: [], has_more: false })),
    };

    await submitOpenAIBatch([target], prepared, {
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      runId: "run_stable",
      batch: client,
      putObject: noopPut(),
      saveInputJsonl: vi.fn(async () => {
        events.push("saveJsonl");
      }),
      saveSidecar: vi.fn(async (sidecar: PersistedSidecar) => {
        events.push(`save:${sidecar.phase}`);
      }),
      acquireLock: vi.fn(async () => {
        events.push("acquire");
        return lock;
      }),
      loadSidecar: async () => {
        events.push("loadSidecar");
        return null;
      },
      sidecarFilePath: "/tmp/index.batch.json",
    });

    expect(events).toEqual([
      "acquire",
      "loadSidecar",
      "saveJsonl",
      "save:uploading",
      "heartbeat",
      "upload",
      "save:creating",
      "heartbeat",
      "create",
      "save:submitted",
      "release",
    ]);
  });

  it("refuses to start a second submit when a sidecar already exists after the lock is held", async () => {
    const target = summarizeTarget();
    const prepared = prepareOpenAIBatchPayload(
      [target],
      "gpt-5.6-terra",
      "low",
    );
    const client = {
      upload: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      content: vi.fn(),
      listFiles: vi.fn(),
      listBatches: vi.fn(),
    };
    const saveInputJsonl = vi.fn(async () => undefined);
    const saveSidecar = vi.fn(async () => undefined);

    await expect(
      submitOpenAIBatch([target], prepared, {
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        runId: "run_stable",
        batch: client,
        putObject: noopPut(),
        saveInputJsonl,
        saveSidecar,
        acquireLock: async () => ({
          release: async () => undefined,
        }),
        loadSidecar: async () =>
          ({
            version: 2,
            provider: "openai",
            phase: "submitted",
            runId: "run_other",
            batchId: "batch_existing",
            inputFileId: "file_existing",
            outputFileId: null,
            errorFileId: null,
            model: "gpt-5.6-terra",
            reasoningEffort: "low",
            processingStatus: "validating",
            targets: [],
          }) as PersistedSidecar,
      }),
    ).rejects.toThrow(/already exists/);
    expect(saveInputJsonl).not.toHaveBeenCalled();
    expect(saveSidecar).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("allows the current run's activating checkpoint and still rejects a foreign one", async () => {
    const target = summarizeTarget();
    const prepared = prepareOpenAIBatchPayload(
      [target],
      "gpt-5.6-terra",
      "low",
    );
    const activating = {
      version: 2 as const,
      provider: "openai" as const,
      phase: "activating" as const,
      runId: "run_stable",
      batchId: "" as const,
      inputFileId: null,
      outputFileId: null,
      errorFileId: null,
      model: "gpt-5.6-terra",
      reasoningEffort: "low" as const,
      processingStatus: "activating" as const,
      targets: [],
    };
    const client = {
      upload: vi.fn(async () => ({
        id: "file_input",
        filename: "reading-lite-run_stable.jsonl",
        purpose: "batch",
        bytes: prepared.byteCount,
      })),
      create: vi.fn(async () => ({
        id: "batch_1",
        input_file_id: "file_input",
        status: "validating",
        output_file_id: null,
        error_file_id: null,
        request_counts: { total: 1, completed: 0, failed: 0 },
      })),
      get: vi.fn(),
      content: vi.fn(),
      listFiles: vi.fn(),
      listBatches: vi.fn(),
    };

    await expect(
      submitOpenAIBatch([target], prepared, {
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        runId: "run_stable",
        batch: client,
        putObject: noopPut(),
        saveInputJsonl: async () => undefined,
        saveSidecar: async () => undefined,
        acquireLock: async () => ({ release: async () => undefined }),
        loadSidecar: async () => activating,
      }),
    ).resolves.toMatchObject({ sidecar: { phase: "submitted", batchId: "batch_1" } });

    await expect(
      submitOpenAIBatch([target], prepared, {
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        runId: "run_stable",
        batch: client,
        putObject: noopPut(),
        saveInputJsonl: async () => undefined,
        saveSidecar: async () => undefined,
        acquireLock: async () => ({ release: async () => undefined }),
        loadSidecar: async () => ({ ...activating, runId: "run_other" }),
      }),
    ).rejects.toThrow(/already exists/);
  });
});
