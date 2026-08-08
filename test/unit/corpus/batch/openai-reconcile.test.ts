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
  const listBatches = vi.fn(async () => ({ data: [], has_more: false }));
  return {
    batch: { upload, create, get: vi.fn(), content: vi.fn(), listFiles, listBatches },
    upload,
    create,
    listFiles,
    listBatches,
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
    log: () => undefined,
  };
}

describe("reconcileOpenAIPreSubmitSidecar — creating phase", () => {
  it("adopts the remote batch when exactly one matches the run id and never calls create", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce({
      data: [
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
      has_more: false,
    });
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

  it("creates a batch once when the remote list has no match for this run id", async () => {
    const c = makeClient();
    c.create.mockResolvedValueOnce({
      id: "batch_new",
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

    const result = await reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved));

    expect(c.create).toHaveBeenCalledTimes(1);
    expect(c.create).toHaveBeenCalledWith("file_input", "run_1");
    expect(result.batchId).toBe("batch_new");
    expect(saved.map((s) => s.phase)).toEqual(["submitted"]);
  });

  it("refuses to adopt a foreign batch whose input_file_id does not match the sidecar", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce({
      data: [
        {
          id: "batch_foreign",
          input_file_id: "file_other",
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

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/foreign batch/);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("aborts when more than one batch matches the run id", async () => {
    const c = makeClient();
    c.listBatches.mockResolvedValueOnce({
      data: [
        {
          id: "batch_dup1",
          input_file_id: "file_input",
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
          metadata: { run_id: "run_1" },
        },
        {
          id: "batch_dup2",
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

    await expect(
      reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved)),
    ).rejects.toThrow(/ambiguous/i);
    expect(c.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});

describe("reconcileOpenAIPreSubmitSidecar — uploading phase", () => {
  it("uploads the persisted JSONL once when no remote file matches the run id", async () => {
    const c = makeClient();
    c.upload.mockResolvedValueOnce({
      id: "file_input",
      filename: "reading-lite-run_1.jsonl",
      purpose: "batch",
      bytes: 12,
    });
    c.create.mockResolvedValueOnce({
      id: "batch_new",
      input_file_id: "file_input",
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 1, completed: 0, failed: 0 },
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };
    const jsonl = '{"custom_id":"rd_a"}\n';

    const result = await reconcileOpenAIPreSubmitSidecar(
      sidecar,
      makeDeps(c.batch, saved, async () => jsonl),
    );

    expect(c.listFiles).toHaveBeenCalledTimes(1);
    expect(c.upload).toHaveBeenCalledTimes(1);
    expect(c.upload).toHaveBeenCalledWith(jsonl, "run_1");
    expect(c.create).toHaveBeenCalledTimes(1);
    expect(c.create).toHaveBeenCalledWith("file_input", "run_1");
    expect(result.batchId).toBe("batch_new");
    expect(saved.map((s) => s.phase)).toEqual(["creating", "submitted"]);
  });

  it("adopts the remote file and skips upload when exactly one file matches", async () => {
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
    c.listBatches.mockResolvedValueOnce({ data: [], has_more: false });
    c.create.mockResolvedValueOnce({
      id: "batch_new",
      input_file_id: "file_existing",
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 1, completed: 0, failed: 0 },
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    const result = await reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved));

    expect(c.upload).not.toHaveBeenCalled();
    expect(c.create).toHaveBeenCalledTimes(1);
    expect(c.create).toHaveBeenCalledWith("file_existing", "run_1");
    expect(result.inputFileId).toBe("file_existing");
    expect(result.batchId).toBe("batch_new");
    expect(saved.map((s) => s.phase)).toEqual(["creating", "submitted"]);
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

  it("paginates batch list when more pages are available before treating as not found", async () => {
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
    c.create.mockResolvedValueOnce({
      id: "batch_new",
      input_file_id: "file_existing",
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 1, completed: 0, failed: 0 },
    });
    const saved: PersistedSidecar[] = [];
    const sidecar: OpenAIUploadingSidecar = {
      ...baseUploading,
      targets: [sampleTarget],
    };

    await reconcileOpenAIPreSubmitSidecar(sidecar, makeDeps(c.batch, saved));

    expect(c.listBatches).toHaveBeenCalledTimes(2);
    expect(c.create).toHaveBeenCalledTimes(1);
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