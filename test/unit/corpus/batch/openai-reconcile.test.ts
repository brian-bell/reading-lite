import { describe, expect, it, vi } from "vitest";
import {
  reconcileOpenAIPreSubmitSidecar,
  type ReconcileDeps,
} from "../../../../scripts/corpus-lib/batch/openai-reconcile";
import type {
  OpenAICreatingSidecar,
  OpenAIUploadingSidecar,
  PersistedSidecar,
} from "../../../../scripts/corpus-lib/batch/types";
import type { OpenAIBatchClient } from "../../../../scripts/corpus-lib/batch/clients";

const baseUploading: Omit<OpenAIUploadingSidecar, "targets"> = {
  version: 2,
  provider: "openai",
  phase: "uploading",
  runId: "run_1",
  batchId: "",
  inputFileId: null,
  outputFileId: null,
  errorFileId: null,
  model: "gpt-5.6-terra",
  reasoningEffort: "low",
  processingStatus: "uploading",
};

const baseCreating: Omit<OpenAICreatingSidecar, "targets"> = {
  version: 2,
  provider: "openai",
  phase: "creating",
  runId: "run_1",
  batchId: "",
  inputFileId: "file_input",
  outputFileId: null,
  errorFileId: null,
  model: "gpt-5.6-terra",
  reasoningEffort: "low",
  processingStatus: "creating",
};

const sampleTarget = {
  customId: "rd_a",
  keyPrefix: "readings/kp",
  id: "rd_a",
  url: "https://example.com/a",
  urlHash: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  sourceType: "url" as const,
  contentType: "text/html",
  contentStatus: "captured",
  contentBytes: 10,
  contentSha256: "b".repeat(64),
  extractedBytes: 10,
  queryEmbedTokens: 0,
};

function makeClient(): {
  batch: OpenAIBatchClient;
  upload: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  listBatches: ReturnType<typeof vi.fn>;
} {
  const upload = vi.fn();
  const create = vi.fn();
  const listFiles = vi.fn(async () => ({ data: [], has_more: false }));
  const listBatches = vi.fn(async () => ({ data: [], raw: [], has_more: false }));
  return {
    batch: { upload, create, get: vi.fn(), content: vi.fn(), listFiles, listBatches },
    upload,
    create,
    listFiles,
    listBatches,
  };
}

// Build the parallel `data`/`raw` shape returned by `listBatches`. Each
// `entry` becomes a strict-`/v1/responses` batch in both `data` and `raw`
// (so existing tests don't accidentally exercise the strict-validation path).
function batchesResponse(
  entries: Array<{
    id: string;
    input_file_id?: string;
    status: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    request_counts?: { total: number; completed: number; failed: number };
    metadata?: Record<string, string> | null;
  }>,
  opts: { has_more?: boolean; last_id?: string } = {},
) {
  const data = entries.map((e) => ({
    id: e.id,
    input_file_id: e.input_file_id ?? "file_input",
    status: e.status,
    output_file_id: e.output_file_id ?? null,
    error_file_id: e.error_file_id ?? null,
    request_counts: e.request_counts ?? { total: 1, completed: 0, failed: 0 },
    metadata: e.metadata ?? null,
  }));
  const raw = data.map((b) => ({
    object: "batch",
    endpoint: "/v1/responses",
    completion_window: "24h",
    ...b,
  }));
  return {
    data,
    raw,
    has_more: opts.has_more ?? false,
    ...(opts.last_id ? { last_id: opts.last_id } : {}),
  };
}

function makeDeps(
  client: OpenAIBatchClient,
  saved: PersistedSidecar[],
  loadJsonl?: () => Promise<string | null>,
): ReconcileDeps {
  return {
    batch: client,
    saveSidecar: vi.fn(async (s: PersistedSidecar) => {
      saved.push(s);
    }),
    ...(loadJsonl ? { loadInputJsonl: loadJsonl } : {}),
    // Provide an in-memory no-op lock by default so reconcile unit tests
    // don't touch the filesystem; the lock is exercised in `reconcile-lock.test.ts`.
    acquireLock: vi.fn(async () => ({
      release: vi.fn(async () => undefined),
    })),
    log: () => undefined,
  };
}

describe("reconcileOpenAIPreSubmitSidecar — creating phase", () => {
  it("adopts the remote batch when exactly one matches the run id and never calls create", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce(
      batchesResponse([
        {
          id: "batch_adopt",
          input_file_id: "file_input",
          status: "validating",
          metadata: { run_id: "run_1" },
        },
      ]),
    );
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };

    const result = await reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved));

    expect(c.create).not.toHaveBeenCalled();
    expect(c.listFiles).not.toHaveBeenCalled();
    expect(result.batchId).toBe("batch_adopt");
    expect(result.inputFileId).toBe("file_input");
    expect(result.phase).toBe("submitted");
    expect(result.processingStatus).toBe("validating");
    expect(saved.map((s) => s.phase)).toEqual(["submitted"]);
  });

  it("fails closed from a creating sidecar when no remote batch is visible (no auto-create)", async () => {
    // The OpenAI Batch API has no idempotency key. A list-then-create cannot
    // distinguish a failed prior create from a successful-but-lost-response
    // one (visibility lag may temporarily hide it). The reconciler refuses
    // to create and asks the operator to reconcile manually.
    const c = makeClient();
    c.create.mockResolvedValueOnce({
      id: "batch_would_have_double_billed",
      input_file_id: "file_input",
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 1, completed: 0, failed: 0 },
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/Refusing to create a second batch/);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("acquires the reconcile lock once for the whole path and releases it", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce(
      batchesResponse([
        {
          id: "batch_adopt",
          status: "validating",
          metadata: { run_id: "run_1" },
        },
      ]),
    );
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };
    const release = vi.fn(async () => undefined);
    const deps = {
      ...makeDeps(c.batch, saved),
      acquireLock: vi.fn(async () => ({ release })),
    };

    await reconcileOpenAIPreSubmitSidecar(sidecar, deps);

    expect(deps.acquireLock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the create-window lock cannot be acquired", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce(batchesResponse([]));
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };
    const deps = {
      ...makeDeps(c.batch, saved),
      acquireLock: vi.fn(async () => {
        throw new Error("OpenAI reconcile lock is held by another process");
      }),
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, deps),
    ).rejects.toThrow(/held by another process/);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("refuses to adopt a foreign batch whose input_file_id does not match the sidecar", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce(
      batchesResponse([
        {
          id: "batch_foreign",
          input_file_id: "file_other",
          status: "validating",
          metadata: { run_id: "run_1" },
        },
      ]),
    );
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/foreign batch/);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("aborts when more than one batch matches the run id", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce(
      batchesResponse([
        {
          id: "batch_dup1",
          status: "validating",
          metadata: { run_id: "run_1" },
        },
        {
          id: "batch_dup2",
          status: "validating",
          metadata: { run_id: "run_1" },
        },
      ]),
    );
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/ambiguous/i);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});

describe("reconcileOpenAIPreSubmitSidecar — uploading phase", () => {
  it("uploads the persisted JSONL once when no remote file matches the run id, then fails closed (no create)", async () => {
    // Re-uploading the JSONL is cheap and recoverable. The reconciler
    // does it, advances to `creating`, then refuses to call `create`
    // because no remote batch is visible. Operator must reconcile.
    const c = makeClient();
    c.upload.mockResolvedValueOnce({
      id: "file_input",
      filename: "reading-lite-run_1.jsonl",
      purpose: "batch",
      bytes: 12,
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };
    const jsonl = '{"custom_id":"rd_a"}\n';

    await expect(
      reconcileOpenAIPreSubmitSidecar(
        sidecar,
        makeDeps(c.batch, saved, async () => jsonl),
      ),
    ).rejects.toThrow(/Refusing to create a second batch/);
    expect(c.listFiles).toHaveBeenCalledTimes(1);
    expect(c.upload).toHaveBeenCalledTimes(1);
    expect(c.upload).toHaveBeenCalledWith(jsonl, "run_1");
    expect(c.create).not.toHaveBeenCalled();
    // The creating checkpoint was written before the failed create.
    expect(saved.map((s) => s.phase)).toEqual(["creating"]);
  });

  it("adopts the remote file and skips upload when exactly one file matches, then fails closed (no create)", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({
      data: [
        {
          id: "file_existing",
          filename: "reading-lite-run_1.jsonl",
          purpose: "batch",
          bytes: 12,
        },
      ],
      has_more: false,
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/Refusing to create a second batch/);
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
    expect(saved.map((s) => s.phase)).toEqual(["creating"]);
  });

  it("aborts without upload or create when the local JSONL is missing", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({ data: [], has_more: false });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(
        sidecar,
        makeDeps(c.batch, saved, async () => null),
      ),
    ).rejects.toThrow(/input JSONL is missing/i);
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("aborts when more than one file matches the run id filename", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({
      data: [
        {
          id: "file_dup1",
          filename: "reading-lite-run_1.jsonl",
          purpose: "batch",
          bytes: 12,
        },
        {
          id: "file_dup2",
          filename: "reading-lite-run_1.jsonl",
          purpose: "batch",
          bytes: 12,
        },
      ],
      has_more: false,
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(
        sidecar,
        makeDeps(c.batch, saved, async () => '{"custom_id":"rd_a"}\n'),
      ),
    ).rejects.toThrow(/ambiguous/i);
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });

  it("paginates the batch list before failing closed", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({
      data: [
        {
          id: "file_existing",
          filename: "reading-lite-run_1.jsonl",
          purpose: "batch",
          bytes: 12,
        },
      ],
      has_more: false,
    });
    c.listBatches
      .mockResolvedValueOnce({
        data: [],
        has_more: true,
        last_id: "page1_last",
      })
      .mockResolvedValueOnce({
        data: [],
        has_more: false,
      });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/Refusing to create a second batch/);
    // Both pages of the list were fetched.
    expect(c.listBatches).toHaveBeenCalledTimes(2);
    expect(c.create).not.toHaveBeenCalled();
  });

  it("fails closed when the batch list reports has_more without a last_id cursor", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({
      data: [
        {
          id: "file_existing",
          filename: "reading-lite-run_1.jsonl",
          purpose: "batch",
          bytes: 12,
        },
      ],
      has_more: false,
    });
    c.listBatches.mockResolvedValueOnce({
      data: [],
      has_more: true,
      // last_id intentionally omitted — the reconciler must refuse to
      // assume the list is exhausted.
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/refusing to assume/i);
    expect(c.create).not.toHaveBeenCalled();
    // The intermediate "creating" checkpoint was written before the batch
    // list, so a crash leaves the sidecar on the creating branch (no create
    // happened). That checkpoint counts as one save.
    expect(saved.map((s) => s.phase)).toEqual(["creating"]);
  });

  it("fails closed when the batch list page cap is reached before exhausting results", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({
      data: [
        {
          id: "file_existing",
          filename: "reading-lite-run_1.jsonl",
          purpose: "batch",
          bytes: 12,
        },
      ],
      has_more: false,
    });
    // Always has_more with a valid last_id, so the cap (20) trips first.
    for (let i = 0; i < 21; i++) {
      c.listBatches.mockResolvedValueOnce({
        data: [],
        has_more: true,
        last_id: `cursor_${i}`,
      });
    }
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/page cap/i);
    expect(c.create).not.toHaveBeenCalled();
  });

  it("fails closed when the file list reports has_more without a last_id cursor", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({
      data: [],
      has_more: true,
      // last_id intentionally omitted — the reconciler must refuse to
      // assume the list is exhausted (mirrors the batches defense).
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(
        sidecar,
        makeDeps(c.batch, saved, async () => '{"custom_id":"rd_a"}\n'),
      ),
    ).rejects.toThrow(/refusing to assume/i);
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });

  it("fails closed when the file list page cap is reached before exhausting results", async () => {
    const c = makeClient();
    // Always has_more with a valid last_id, so the cap (20) trips first.
    for (let i = 0; i < 21; i++) {
      c.listFiles.mockResolvedValueOnce({
        data: [],
        has_more: true,
        last_id: `cursor_${i}`,
      });
    }
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(
        sidecar,
        makeDeps(c.batch, saved, async () => '{"custom_id":"rd_a"}\n'),
      ),
    ).rejects.toThrow(/file list page cap/i);
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });

  it("tolerates a non-/v1/responses batch on the same page (filters by metadata.run_id, then strict-validates)", async () => {
    // A pre-existing /v1/chat/completions batch in the same OpenAI org must
    // not break parsing of the responses batch we're trying to adopt.
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce({
      data: [
        {
          id: "batch_other_endpoint",
          // OpenAIListBatchSchema accepts arbitrary endpoint / completion_window.
          endpoint: "/v1/chat/completions",
          completion_window: "1h",
          status: "completed",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
          metadata: { run_id: "run_other" },
        },
        {
          id: "batch_adopt",
          input_file_id: "file_input",
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
          metadata: { run_id: "run_1" },
        },
      ],
      raw: [
        {
          object: "batch",
          endpoint: "/v1/chat/completions",
          completion_window: "1h",
          id: "batch_other_endpoint",
          status: "completed",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
          metadata: { run_id: "run_other" },
        },
        {
          object: "batch",
          endpoint: "/v1/responses",
          completion_window: "24h",
          id: "batch_adopt",
          input_file_id: "file_input",
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
          metadata: { run_id: "run_1" },
        },
      ],
      has_more: false,
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };

    const result = await reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved));

    expect(c.create).not.toHaveBeenCalled();
    expect(result.batchId).toBe("batch_adopt");
    expect(result.inputFileId).toBe("file_input");
    expect(saved.map((s) => s.phase)).toEqual(["submitted"]);
  });

  it("fails closed when the matched batch's raw shape is not a /v1/responses batch", async () => {
    // A run_id collision: some unrelated tool stamps our run_id on a batch
    // targeted at /v1/chat/completions. Strict re-validation must refuse to
    // adopt it rather than publish a `submitted` sidecar.
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce({
      data: [
        {
          id: "batch_foreign_endpoint",
          status: "completed",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
          metadata: { run_id: "run_1" },
        },
      ],
      raw: [
        {
          object: "batch",
          endpoint: "/v1/chat/completions",
          completion_window: "1h",
          id: "batch_foreign_endpoint",
          status: "completed",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
          metadata: { run_id: "run_1" },
        },
      ],
      has_more: false,
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAICreatingSidecar = {
      ...baseCreating,
      targets: [sampleTarget],
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/strict validation/i);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("adopts a submitted sidecar that appeared after the lock was acquired", async () => {
    const c = makeClient();
    const saved: PersistedSidecar[] = [];
    const staleUploading: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };
    const liveSubmitted: PersistedSidecar = {
      ...baseUploading,
      phase: "submitted",
      batchId: "batch_winner",
      inputFileId: "file_winner",
      processingStatus: "validating",
      targets: [sampleTarget],
    };
    const deps = {
      ...makeDeps(c.batch, saved),
      loadSidecar: async () => liveSubmitted,
    };

    const result = await reconcileOpenAIPreSubmitSidecar(staleUploading, deps);
    expect(result).toMatchObject({
      phase: "submitted",
      batchId: "batch_winner",
      inputFileId: "file_winner",
    });
    expect(c.listFiles).not.toHaveBeenCalled();
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });

  it("refuses to adopt a submitted sidecar whose runId does not match the resume", async () => {
    const c = makeClient();
    const saved: PersistedSidecar[] = [];
    const staleUploading: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };
    const foreignSubmitted: PersistedSidecar = {
      ...baseUploading,
      runId: "run_other",
      phase: "submitted",
      batchId: "batch_foreign",
      inputFileId: "file_foreign",
      processingStatus: "validating",
      targets: [sampleTarget],
    };
    const deps = {
      ...makeDeps(c.batch, saved),
      loadSidecar: async () => foreignSubmitted,
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(staleUploading, deps),
    ).rejects.toThrow(/changed under the lock/);
    expect(c.listFiles).not.toHaveBeenCalled();
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("refuses to reconcile an uploading sidecar whose runId does not match the resume", async () => {
    const c = makeClient();
    const saved: PersistedSidecar[] = [];
    const staleUploading: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };
    const foreignUploading: PersistedSidecar = {
      ...baseUploading,
      runId: "run_other",
      targets: [sampleTarget],
    };
    const deps = {
      ...makeDeps(c.batch, saved),
      loadSidecar: async () => foreignUploading,
      loadInputJsonl: async () => "custom-id,body\n",
    };

    await expect(
      reconcileOpenAIPreSubmitSidecar(staleUploading, deps),
    ).rejects.toThrow(/changed under the lock/);
    expect(c.listFiles).not.toHaveBeenCalled();
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("refuses to upload when no loadInputJsonl helper is provided", async () => {
    const c = makeClient();
    c.listFiles.mockResolvedValueOnce({ data: [], has_more: false });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };
    // Note: no `loadInputJsonl` passed to makeDeps — the reconciler must
    // fail closed rather than rebuild JSONL from extracted markdown.
    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/loadInputJsonl helper/);
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).not.toHaveBeenCalled();
  });
});