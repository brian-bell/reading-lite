import { stubBatchCorpus } from "../../../helpers/batch-corpus";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newBatchAttemptId,
  runBatch,
  type BatchRunDeps,
} from "../../../../scripts/corpus-lib/batch/run";
import { loadSidecar } from "../../../../scripts/corpus-lib/batch/sidecar";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { isBatchOwnedPending } from "../../../../src/modules/staleness";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { AuditRow } from "../../../../scripts/corpus-lib/types";
import type { ExtractedContent } from "../../../../src/modules/extractor";
import { BILLING_TENANT, batchSpendAuthority } from "../../../helpers/operator-spend";
import type {
  ExtractedTarget,
  PersistedSidecar,
  Sidecar,
} from "../../../../scripts/corpus-lib/batch/types";

const NOW = "2026-06-18T12:00:00.000Z";

describe("newBatchAttemptId", () => {
  it("keeps the durable batch marker used by pending-state readers", () => {
    const id = newBatchAttemptId();
    expect(id).toMatch(/^batch_[0-9a-f-]+$/);
    expect(isBatchOwnedPending({
      status: "pending",
      active_attempt: {
        id,
        trigger: "import",
        status: "running",
        stage: "summarize",
        started_at: NOW,
      },
    })).toBe(true);
  });
});

function manifest(id: string, over: Partial<Manifest> = {}): Manifest {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: id.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0"),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

function row(id: string): AuditRow {
  return {
    category: "failed",
    url: `https://example.com/${id}`,
    short: `example.com/${id}`,
    reading_id: id,
    key_prefix: `readings/kp-${id}`,
    attempts: 1,
  };
}

const reading = {
  title: "Title",
  tldr: "Tldr.",
  tags: ["t"],
  keywords: ["keyword one", "keyword two", "keyword three"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "body",
};

// Orchestration harness; PostgreSQL behavior is owned by postgres.test.ts.
function harness(seedManifests: Record<string, Manifest>) {
  const store = new Map<string, string>();
  for (const [id, m] of Object.entries(seedManifests)) {
    store.set(`readings/kp-${id}/manifest.json`, JSON.stringify(m));
    store.set(`readings/kp-${id}/extracted.md`, `# ${id}\n\nsaved markdown`);
  }
  const r2 = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, b: Uint8Array | string) => {
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    }),
    putIfAbsent: vi.fn(async (k: string, b: Uint8Array | string) => {
      if (store.has(k)) return false;
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
      return true;
    }),
    head: vi.fn(async (k: string) => store.has(k)),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    listKeys: vi.fn(async () => [...store.keys()]),
  };
  let sidecar: PersistedSidecar | null = null;
  let inputJsonl: string | null = null;
  const batch = {
    create: vi.fn(async (requests: Array<{ custom_id: string }>) => ({
      id: "msgbatch_run",
      processing_status: "in_progress",
      results_url: null,
      _ids: requests.map((r) => r.custom_id),
    })),
    get: vi.fn(async () => ({ id: "msgbatch_run", processing_status: "ended", results_url: "https://results" })),
    results: vi.fn(async () =>
      (sidecar?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: {
          type: "succeeded" as const,
          message: {
            content: [{ type: "tool_use", id: "x", name: EMIT_READING_TOOL_NAME, input: { ...reading, title: `Title ${t.customId}` } }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      })),
    ),
  };
  const extract = vi.fn(
    async (url: string): Promise<ExtractedContent> => ({
      raw: new TextEncoder().encode("x"),
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "c".repeat(64),
      markdown: `fresh ${url}`,
      title: "Fresh",
    }),
  );
  const authority = batchSpendAuthority();
  const deps: BatchRunDeps = {
    r2: r2 as any,
    corpus: stubBatchCorpus(store),
    spend: authority.spend,
    batch: batch as any,
    embed: {
      embedMany: vi.fn(async (inputs: string[]) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0.1)),
        tokensByInput: inputs.map(() => 4),
      })),
    },
    extract,
    model: "claude-opus-4-8",
    newAttemptId: () => "at_recover_1",
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    loadSidecar: vi.fn(async () => null),
    saveSidecar: vi.fn(async (s: PersistedSidecar) => {
      sidecar = s;
    }),
    clearSidecar: vi.fn(async () => {
      sidecar = null;
    }),
    saveInputJsonl: vi.fn(async (jsonl: string) => {
      inputJsonl = jsonl;
    }),
    loadInputJsonl: vi.fn(async () => inputJsonl),
    // The reconciler's create-window lock isn't relevant to integration
    // tests — provide a no-op so the lock release path doesn't touch the fs.
    reconcileAcquireLock: async () => ({
      release: async () => undefined,
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, batch, extract, deps, authority, getSidecar: () => sidecar, setSidecar: (s: PersistedSidecar | null) => (sidecar = s), getInputJsonl: () => inputJsonl, setInputJsonl: (s: string | null) => (inputJsonl = s) };
}

// A minimal OpenAI batch client with sensible defaults so tests don't have to
// thread listFiles / listBatches through every fixture.
function fakeOpenAIClient(
  over: {
    upload?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    get?: ReturnType<typeof vi.fn>;
    content?: ReturnType<typeof vi.fn>;
    listFiles?: ReturnType<typeof vi.fn>;
    listBatches?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    upload: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    content: vi.fn(),
    listFiles: vi.fn(async () => ({ data: [], has_more: false })),
    listBatches: vi.fn(async () => ({ data: [], raw: [], has_more: false })),
    ...over,
  } as any;
}

function installCompletedOpenAIBatch(
  h: ReturnType<typeof harness>,
  options: {
    onUpload?: (jsonl: string, runId: string) => void | Promise<void>;
  } = {},
) {
  h.deps.configuredProvider = "openai";
  h.deps.model = "gpt-5.6-terra";
  h.deps.reasoningEffort = "low";
  h.deps.newRunId = vi.fn(() => "run_recovery");
  const upload = vi.fn(async (jsonl: string, runId: string) => {
    await options.onUpload?.(jsonl, runId);
    return {
      id: "file_input",
      filename: `reading-lite-${runId}.jsonl`,
      purpose: "batch",
      bytes: new TextEncoder().encode(jsonl).byteLength,
    };
  });
  const create = vi.fn(async (inputFileId: string) => ({
    id: "batch_openai",
    input_file_id: inputFileId,
    status: "validating",
    output_file_id: null,
    error_file_id: null,
    request_counts: { total: 1, completed: 0, failed: 0 },
  }));
h.deps.openaiBatch = fakeOpenAIClient({
    upload,
    create,
    get: vi.fn(async () => ({
      id: "batch_openai",
      input_file_id: "file_input",
      status: "completed",
      output_file_id: "file_output",
      error_file_id: null,
      request_counts: { total: 1, completed: 1, failed: 0 },
    })),
    content: vi.fn(async () => {
      const customId = h.getSidecar()!.targets[0]!.customId;
      return (
        JSON.stringify({
          custom_id: customId,
          response: {
            status_code: 200,
            body: {
              id: "resp_recovery",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        ...reading,
                        title: `Title ${customId}`,
                      }),
                    },
                  ],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          },
          error: null,
        }) + "\n"
      );
    }),
  });
  return { upload, create };
}


describe("runBatch — fresh run", () => {
  it("fresh-extracts a failed recovery target before OpenAI upload and publishes it at the same owner", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.store.delete("readings/kp-rd_a/extracted.md");
    let stateAtUpload: {
      raw: string | undefined;
      extracted: string | undefined;
      manifest: Manifest;
    } | undefined;
    installCompletedOpenAIBatch(h, {
      onUpload: () => {
        stateAtUpload = {
          raw: h.store.get("readings/kp-rd_a/revisions/at_recover_1/raw.html"),
          extracted: h.store.get("readings/kp-rd_a/revisions/at_recover_1/extracted.md"),
          manifest: ManifestSchema.parse(
            JSON.parse(
              h.store.get("readings/kp-rd_a/manifest.json")!,
            ),
          ),
        };
      },
    });

    const result = await runBatch([row("rd_a")], h.deps);

    expect(h.extract).toHaveBeenCalledOnce();
    expect(stateAtUpload).toMatchObject({
      raw: "x",
      extracted: "fresh https://example.com/rd_a",
      manifest: { status: "pending", content_status: "captured" },
    });
    expect(result.report).toContainEqual({ id: "rd_a", status: "ready" });
    const final = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    expect(final).toMatchObject({
      id: "rd_a",
      status: "ready",
      content_bytes: 1,
      content_sha256: "c".repeat(64),
      usage: {
        summarization: {
          provider: "openai",
          model: "gpt-5.6-terra",
        },
      },
    });
    expect(h.deps.corpus.publish).toHaveBeenCalledOnce();
  });

  it("runs an OpenAI batch to ready with one stable run id and the realtime response parser", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.configuredProvider = "openai";
    h.deps.model = "gpt-5.6-terra";
    h.deps.reasoningEffort = "low";
    h.deps.newRunId = vi.fn(() => "run_stable");
    const upload = vi.fn(async (jsonl: string, runId: string) => ({
      id: "file_input",
      filename: `reading-lite-${runId}.jsonl`,
      purpose: "batch",
      bytes: new TextEncoder().encode(jsonl).byteLength,
    }));
    h.deps.openaiBatch = fakeOpenAIClient({
      upload,
      create: vi.fn(async (inputFileId: string, runId: string) => ({
        id: "batch_openai",
        input_file_id: inputFileId,
        status: "validating",
        output_file_id: null,
        error_file_id: null,
        request_counts: { total: 1, completed: 0, failed: 0 },
        _runId: runId,
      })),
      get: vi.fn(async () => ({
        id: "batch_openai",
        input_file_id: "file_input",
        status: "completed",
        output_file_id: "file_output",
        error_file_id: null,
        request_counts: { total: 1, completed: 1, failed: 0 },
      })),
      content: vi.fn(async () =>
        JSON.stringify({
          custom_id: "rd_a",
          response: {
            status_code: 200,
            body: {
              id: "resp_1",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(reading),
                    },
                  ],
                },
              ],
              usage: {
                input_tokens: 5,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 1 },
                output_tokens_details: { reasoning_tokens: 1 },
              },
            },
          },
          error: null,
        }) + "\n",
      ),
    });

    const result = await runBatch([row("rd_a")], h.deps);

    expect(result.report).toContainEqual({ id: "rd_a", status: "ready" });
    expect(h.deps.newRunId).toHaveBeenCalledOnce();
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith(expect.any(String), "run_stable");
    const requests = upload.mock.calls[0]![0]
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests[0]).toMatchObject({
      custom_id: "rd_a",
      method: "POST",
      url: "/v1/responses",
      body: {
        model: "gpt-5.6-terra",
        reasoning: { effort: "low" },
      },
    });
    const final = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    expect(final.usage).toMatchObject({
      summarization: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning_tokens: 1,
      },
    });
  });

  it("processes a backlog end-to-end and writes ready manifests + index", async () => {
    const h = harness({ rd_a: manifest("rd_a"), rd_b: manifest("rd_b") });
    const result = await runBatch([row("rd_a"), row("rd_b")], h.deps);

    expect(result.resumed).toBe(false);
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(2);

    const mA = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!));
    expect(mA.status).toBe("ready");
    expect(mA.title).toBe("Title rd_a");

    expect(h.deps.corpus.publish).toHaveBeenCalledTimes(2);
  });

  it("reuses saved markdown rather than re-extracting (ready+captured reading)", async () => {
    const h = harness({ rd_a: manifest("rd_a", { status: "ready" }) });
    await runBatch([row("rd_a")], h.deps);
    expect(h.extract).not.toHaveBeenCalled();
  });

  it("drops a row whose manifest is missing and processes the rest", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const result = await runBatch([row("rd_a"), row("rd_missing")], h.deps);
    expect(result.dropped.map((d) => d.readingId)).toContain("rd_missing");
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(1);
  });

  it("logs each dropped reading with its reason (not just a count)", async () => {
    const lines: string[] = [];
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.log = (l) => lines.push(l);
    await runBatch([row("rd_a"), row("rd_missing")], h.deps);
    const dropLine = lines.find((l) => l.includes("rd_missing"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toMatch(/drop/i);
    expect(dropLine).toMatch(/reading not found/i); // the reason from prepare
  });
});

describe("runBatch — resume", () => {
  it("terminal-writes a completed OpenAI batch whose only results are in the error file", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const urlHash = manifest("rd_a").url_hash;
    const sc: PersistedSidecar = {
      version: 2,
      provider: "openai",
      phase: "submitted",
      runId: "run_error_only",
      batchId: "batch_error_only",
      inputFileId: "file_input",
      outputFileId: null,
      errorFileId: null,
      model: "gpt-pinned",
      reasoningEffort: "low",
      processingStatus: "in_progress",
      targets: [
        {
          customId: "rd_a",
          keyPrefix: "readings/kp-rd_a",
          id: "rd_a",
          url: "https://example.com/rd_a",
          urlHash,
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 0,
          releaseByUrlOnFailure: true,
        },
      ],
    };
    h.deps.loadSidecar = vi.fn(async () => sc);
    const content = vi.fn(async (fileId: string) => {
      expect(fileId).toBe("file_errors");
      return (
        JSON.stringify({
          custom_id: "rd_a",
          response: null,
          error: { code: "invalid_request", message: "bad request" },
        }) + "\n"
      );
    });
    h.deps.openaiBatch = fakeOpenAIClient({
      get: vi.fn(async () => ({
        id: "batch_error_only",
        input_file_id: "file_input",
        status: "completed",
        output_file_id: null,
        error_file_id: "file_errors",
        request_counts: { total: 1, completed: 0, failed: 1 },
      })),
      content,
    });

    const result = await runBatch([row("rd_a")], h.deps);

    expect(content).toHaveBeenCalledOnce();
    expect(result.report).toEqual([
      { id: "rd_a", status: "failed", reason: "bad request" },
    ]);
    const failed = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    expect(failed.error?.code).toBe("OpenAIBatchRequestError");
    expect(h.deps.corpus.fail).toHaveBeenCalled();
    expect(h.deps.corpus.fail).toHaveBeenCalled();
  });

  it.each(["failed", "expired", "cancelled"] as const)(
    "terminal-writes every unresolved target when an OpenAI batch is %s",
    async (status) => {
      const h = harness({ rd_a: manifest("rd_a") });
      const urlHash = manifest("rd_a").url_hash;
      const sc: PersistedSidecar = {
        version: 2,
        provider: "openai",
        phase: "submitted",
        runId: "run_terminal",
        batchId: "batch_terminal",
        inputFileId: "file_input",
        outputFileId: null,
        errorFileId: null,
        model: "gpt-pinned",
        reasoningEffort: "low",
        processingStatus: "in_progress",
        targets: [
          {
            customId: "rd_a",
            keyPrefix: "readings/kp-rd_a",
            id: "rd_a",
            url: "https://example.com/rd_a",
            urlHash,
            createdAt: "2026-01-01T00:00:00.000Z",
            sourceType: "url",
            contentType: "text/html",
            contentStatus: "captured",
            contentBytes: 10,
            contentSha256: "b".repeat(64),
            queryEmbedTokens: 0,
          },
        ],
      };
      h.deps.loadSidecar = vi.fn(async () => sc);
      h.deps.openaiBatch = fakeOpenAIClient({
        get: vi.fn(async () => ({
          id: "batch_terminal",
          input_file_id: "file_input",
          status,
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 1 },
        })),
        content: vi.fn(),
      });

      const result = await runBatch([row("rd_a")], h.deps);

      expect(h.deps.sleep).not.toHaveBeenCalled();
      expect(result.report).toEqual([
        {
          id: "rd_a",
          status: "failed",
          reason: `OpenAI batch ended with status ${status} before returning a result for this reading`,
        },
      ]);
      const failed = ManifestSchema.parse(
        JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
      );
      expect(failed.error?.code).toBe(
        `OpenAIBatch${status[0]!.toUpperCase()}${status.slice(1)}`,
      );
      expect(h.deps.corpus.fail).toHaveBeenCalled();
    },
  );

  it("continues polling every documented nonterminal OpenAI batch state", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: PersistedSidecar = {
      version: 2,
      provider: "openai",
      phase: "submitted",
      runId: "run_polling",
      batchId: "batch_polling",
      inputFileId: "file_input",
      outputFileId: null,
      errorFileId: null,
      model: "gpt-pinned",
      reasoningEffort: "low",
      processingStatus: "validating",
      targets: [],
    };
    h.deps.loadSidecar = vi.fn(async () => sc);
    const statuses = [
      "validating",
      "in_progress",
      "finalizing",
      "cancelling",
      "completed",
    ];
    h.deps.openaiBatch = fakeOpenAIClient({
      get: vi.fn(async () => ({
        id: "batch_polling",
        input_file_id: "file_input",
        status: statuses.shift()!,
        output_file_id: null,
        error_file_id: null,
        request_counts: { total: 0, completed: 0, failed: 0 },
      })),
      content: vi.fn(),
    });

    const result = await runBatch([row("rd_a")], h.deps);

    expect(h.deps.openaiBatch!.get).toHaveBeenCalledTimes(5);
    expect(h.deps.sleep).toHaveBeenCalledTimes(4);
    expect(result.report).toEqual([]);
  });

  it("does not terminal-write a partial result set when one OpenAI file download fails", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: PersistedSidecar = {
      version: 2,
      provider: "openai",
      phase: "submitted",
      runId: "run_download",
      batchId: "batch_download",
      inputFileId: "file_input",
      outputFileId: null,
      errorFileId: null,
      model: "gpt-pinned",
      reasoningEffort: "low",
      processingStatus: "in_progress",
      targets: [
        {
          customId: "rd_a",
          keyPrefix: "readings/kp-rd_a",
          id: "rd_a",
          url: "https://example.com/rd_a",
          urlHash: manifest("rd_a").url_hash,
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 0,
        },
      ],
    };
    h.deps.loadSidecar = vi.fn(async () => sc);
    const content = vi.fn(async (fileId: string) => {
      if (fileId === "file_errors") throw new Error("download unavailable");
      return (
        JSON.stringify({
          custom_id: "rd_a",
          response: {
            status_code: 200,
            body: {
              id: "resp_partial",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(reading),
                    },
                  ],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          },
          error: null,
        }) + "\n"
      );
    });
    h.deps.openaiBatch = fakeOpenAIClient({
      get: vi.fn(async () => ({
        id: "batch_download",
        input_file_id: "file_input",
        status: "completed",
        output_file_id: "file_output",
        error_file_id: "file_errors",
        request_counts: { total: 1, completed: 1, failed: 0 },
      })),
      content,
    });

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /download unavailable/,
    );

    expect(content.mock.calls.map(([fileId]) => fileId)).toEqual([
      "file_output",
      "file_errors",
    ]);
    expect(h.r2.put).not.toHaveBeenCalled();
    expect(h.deps.corpus.publish).not.toHaveBeenCalled();
    expect(h.deps.clearSidecar).not.toHaveBeenCalled();
  });

  it("resumes the provider pinned by an OpenAI submitted sidecar without producing or uploading again", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: PersistedSidecar = {
      version: 2,
      provider: "openai",
      phase: "submitted",
      runId: "run_pinned",
      batchId: "batch_pinned",
      inputFileId: "file_input",
      outputFileId: null,
      errorFileId: null,
      model: "gpt-pinned",
      reasoningEffort: "medium",
      processingStatus: "in_progress",
      targets: [
        {
          customId: "rd_a",
          keyPrefix: "readings/kp-rd_a",
          id: "rd_a",
          url: "https://example.com/rd_a",
          urlHash: manifest("rd_a").url_hash,
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 9,
        },
      ],
    };
    h.deps.loadSidecar = vi.fn(async () => sc);
    h.deps.configuredProvider = "anthropic";
    const upload = vi.fn();
    h.deps.openaiBatch = fakeOpenAIClient({
      upload,
      create: vi.fn(),
      get: vi.fn(async () => ({
        id: "batch_pinned",
        input_file_id: "file_input",
        status: "completed",
        output_file_id: "file_output",
        error_file_id: null,
        request_counts: { total: 1, completed: 1, failed: 0 },
      })),
      content: vi.fn(async () =>
        JSON.stringify({
          custom_id: "rd_a",
          response: {
            status_code: 200,
            body: {
              id: "resp_1",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(reading),
                    },
                  ],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          },
          error: null,
        }) + "\n",
      ),
    });
    const result = await runBatch([row("rd_a")], h.deps);

    expect(result.resumed).toBe(true);
    expect(h.extract).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(h.deps.openaiBatch!.create).not.toHaveBeenCalled();
    expect(h.deps.openaiBatch!.get).toHaveBeenCalledWith("batch_pinned");
    const final = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    expect(final.usage).toMatchObject({
      summarization: { provider: "openai", model: "gpt-pinned" },
    });
  });

  it.each([
    { name: "with an OpenAI client wired", wired: true },
    // No openaiBatch client wired — the abort message must point at
    // activation, not "missing OpenAI batch credentials".
    { name: "even when no OpenAI client is wired", wired: false },
  ])("still aborts an OpenAI activating sidecar before any remote check, $name", async ({ wired }) => {
    const h = harness({ rd_a: manifest("rd_a") });
    const activatingTarget = {
      id: "rd_a",
      customId: "rd_a",
      keyPrefix: "readings/kp-rd_a",
      url: "https://example.com/rd_a",
      urlHash: manifest("rd_a").url_hash,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    h.deps.loadSidecar = vi.fn(
      async () =>
        ({
          version: 2,
          provider: "openai",
          phase: "activating",
          runId: "run_1",
          batchId: "",
          inputFileId: null,
          outputFileId: null,
          errorFileId: null,
          model: "gpt-pinned",
          reasoningEffort: "low",
          processingStatus: "activating",
          targets: [activatingTarget],
        }) as PersistedSidecar,
    );
    const client = {
      upload: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      content: vi.fn(),
      listFiles: vi.fn(),
      listBatches: vi.fn(),
    };
    h.deps.openaiBatch = wired ? (client as any) : undefined;

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /ownership activation/i,
    );
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(client.listBatches).not.toHaveBeenCalled();
  });

  it("loads a legacy sidecar and resumes its pinned Anthropic model under an OpenAI default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reading-lite-run-legacy-"));
    try {
      const path = join(dir, "index.batch.json");
      const legacy = {
        batchId: "msgbatch_legacy",
        model: "claude-legacy-pinned",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [
          {
            customId: "rd_a",
            keyPrefix: "readings/kp-rd_a",
            id: "rd_a",
            url: "https://example.com/rd_a",
            urlHash: "a".repeat(64),
            createdAt: "2026-01-01T00:00:00.000Z",
            sourceType: "url",
            contentType: "text/html",
            contentStatus: "captured",
            contentBytes: 10,
            contentSha256: "b".repeat(64),
            queryEmbedTokens: 9,
          },
        ],
      };
      await writeFile(path, JSON.stringify(legacy));
      const loaded = await loadSidecar(path);
      expect(loaded).toMatchObject({
        version: 2,
        provider: "anthropic",
        phase: "submitted",
      });

      const h = harness({ rd_a: manifest("rd_a") });
      h.setSidecar(loaded as Sidecar);
      h.deps.loadSidecar = vi.fn(async () => loaded);
      h.deps.configuredProvider = "openai";
      h.deps.model = "gpt-current-default";

      const result = await runBatch([row("rd_a")], h.deps);

      expect(result.resumed).toBe(true);
      expect(h.batch.create).not.toHaveBeenCalled();
      expect(h.batch.get).toHaveBeenCalledWith("msgbatch_legacy");
      expect(h.batch.results).toHaveBeenCalled();
      const ready = ManifestSchema.parse(
        JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
      );
      expect(ready.usage).toEqual({
        summarization: {
          provider: "anthropic",
          model: "claude-legacy-pinned",
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        openai_embedding_tokens: 13,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts (no new batch) when a pending sidecar has no batch id — avoids double-billing", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.loadSidecar = vi.fn(async (): Promise<PersistedSidecar> => ({
      version: 2,
      provider: "anthropic",
      phase: "creating",
      batchId: "",
      model: "m",
      processingStatus: "pending",
      resultsUrl: null,
      targets: [],
    }));
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/sidecar with no batch id/i);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.r2.put).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
  });

  it("fails clearly before mutation when a submitted Anthropic sidecar has no client credentials", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
      batchId: "msgbatch_pinned",
      model: "claude-pinned",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [],
    };
    h.deps.loadSidecar = vi.fn(async () => sc);
    h.deps.batch = undefined as any;

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /Anthropic.*credentials/i,
    );

    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.r2.put).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.corpus.publish).not.toHaveBeenCalled();
  });
});

describe("runBatch — payload admission", () => {
  it("rejects an oversized payload before any by-url claim or batch create", async () => {
    const h = harness({ rd_a: manifest("rd_a") });

    await expect(runBatch([row("rd_a")], { ...h.deps, maxBatchBytes: 100 })).rejects.toThrow(/re-run with --limit/);

    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.corpus.activate).not.toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized OpenAI payload before embedding or any by-url claim", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    installCompletedOpenAIBatch(h);

    await expect(runBatch([row("rd_a")], { ...h.deps, maxBatchBytes: 100 })).rejects.toThrow(/re-run with --limit/);

    // The extracted-only preflight must fire before similarity resolution spends
    // embedding quota, and before any eager by-url claim or remote object.
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.corpus.activate).not.toHaveBeenCalled();
    expect(h.deps.openaiBatch!.upload).not.toHaveBeenCalled();
    expect(h.deps.openaiBatch!.create).not.toHaveBeenCalled();
  });
});

describe("runBatch — recover resume", () => {
  it("reconciles an OpenAI upload crash, then fails closed at the create step without operator cleanup", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.store.delete("readings/kp-rd_a/extracted.md");
    installCompletedOpenAIBatch(h, {
      onUpload: () => {
        expect(h.getSidecar()).toMatchObject({
          provider: "openai",
          phase: "uploading",
          runId: "run_recovery",
        });
        throw new Error("simulated upload crash");
      },
    });

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /simulated upload crash/,
    );
    expect(h.extract).toHaveBeenCalledOnce();
    expect(h.getSidecar()).toMatchObject({
      provider: "openai",
      phase: "uploading",
      batchId: "",
    });
    const activated = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    expect(activated).toMatchObject({
      status: "pending",
      active_attempt: { id: "at_recover_1", trigger: "reprocess" },
    });
    expect(h.store.get("readings/kp-rd_a/revisions/at_recover_1/extracted.md")).toBe(
      "fresh https://example.com/rd_a",
    );
    // Companion JSONL was persisted before the upload checkpoint, so a
    // resume from "uploading" with no remote file can re-upload the same
    // bytes.
    expect(h.getInputJsonl()).toContain('"custom_id":"rd_a"');

    // Re-install the OpenAI batch client — this time without the crash hook —
    // so the second run resumes from "uploading" and reaches the create
    // step, where the reconciler fails closed (no remote batch visible,
    // operator must reconcile manually).
    h.setSidecar(h.getSidecar());
    h.deps.loadSidecar = vi.fn(async () => h.getSidecar());
    installCompletedOpenAIBatch(h);

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /Refusing to create a second batch/,
    );
    expect(h.extract).toHaveBeenCalledOnce();
    // The reconcile lock prevents a double-create; the by-url claim stays
    // owned so a manual reconciliation can resolve.
    expect(h.deps.corpus.activate).toHaveBeenCalledOnce();
  });

  it("adopts an OpenAI batch that was created after the sidecar said 'creating'", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    installCompletedOpenAIBatch(h);
    const activated = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    const urlHash = activated.url_hash;
    const kp = "readings/kp-rd_a";
    const submittedSidecar: PersistedSidecar = {
      version: 2,
      provider: "openai",
      phase: "creating",
      runId: "run_recovery",
      batchId: "",
      inputFileId: "file_input",
      outputFileId: null,
      errorFileId: null,
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      processingStatus: "creating",
      targets: [
        {
          customId: "rd_a",
          keyPrefix: kp,
          id: "rd_a",
          url: activated.url,
          urlHash,
          createdAt: activated.created_at,
          sourceType: "url",
          contentType: activated.content_type,
          contentStatus: "captured",
          contentBytes: activated.content_bytes,
          contentSha256: activated.content_sha256,
          queryEmbedTokens: 0,
        },
      ],
    };
    h.setSidecar(submittedSidecar);
    h.deps.loadSidecar = vi.fn(async () => h.getSidecar());

    // The harness's installCompletedOpenAIBatch already wired listFiles /
    // listBatches with empty defaults. Override to inject the "remote batch
    // created but never written to the sidecar" case.
    const openai = h.deps.openaiBatch!;
    const createSpy = vi.fn(async () => {
      throw new Error("create must not be called when a remote batch exists");
    });
    openai.create = createSpy as any;
    openai.listBatches = vi.fn(async () => ({
      data: [
        {
          id: "batch_adopted",
          input_file_id: "file_input",
          status: "completed",
          output_file_id: "file_output",
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
          metadata: { run_id: "run_recovery" },
        },
      ],
      raw: [
        {
          object: "batch",
          endpoint: "/v1/responses",
          completion_window: "24h",
          id: "batch_adopted",
          input_file_id: "file_input",
          status: "completed",
          output_file_id: "file_output",
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
          metadata: { run_id: "run_recovery" },
        },
      ],
      has_more: false,
    }));
    openai.get = vi.fn(async () => ({
      id: "batch_adopted",
      input_file_id: "file_input",
      status: "completed",
      output_file_id: "file_output",
      error_file_id: null,
      request_counts: { total: 1, completed: 1, failed: 0 },
    }));

    const result = await runBatch([row("rd_a")], h.deps);

    expect(createSpy).not.toHaveBeenCalled();
    // A creating sidecar already has its input file; adoption lists batches only.
    expect(openai.listFiles).not.toHaveBeenCalled();
    expect(openai.listBatches).toHaveBeenCalled();
    expect(result.resumed).toBe(true);
    expect(result.report).toContainEqual({ id: "rd_a", status: "ready" });
    expect(h.getSidecar()).toMatchObject({
      phase: "submitted",
      batchId: "batch_adopted",
    });
  });

  it("fails closed from a creating sidecar when two remote batches share the run id (no create)", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    installCompletedOpenAIBatch(h);
    const activated = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    const kp = "readings/kp-rd_a";
    const submittedSidecar: PersistedSidecar = {
      version: 2,
      provider: "openai",
      phase: "creating",
      runId: "run_recovery",
      batchId: "",
      inputFileId: "file_input",
      outputFileId: null,
      errorFileId: null,
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      processingStatus: "creating",
      targets: [
        {
          customId: "rd_a",
          keyPrefix: kp,
          id: "rd_a",
          url: activated.url,
          urlHash: activated.url_hash,
          createdAt: activated.created_at,
          sourceType: "url",
          contentType: activated.content_type,
          contentStatus: "captured",
          contentBytes: activated.content_bytes,
          contentSha256: activated.content_sha256,
          queryEmbedTokens: 0,
        },
      ],
    };
    h.setSidecar(submittedSidecar);
    h.deps.loadSidecar = vi.fn(async () => h.getSidecar());

    const openai = h.deps.openaiBatch!;
    const createSpy = vi.fn(async () => {
      throw new Error("create must not be called on ambiguous match");
    });
    openai.create = createSpy as any;
    openai.listBatches = vi.fn(async () => {
      const data = [
        {
          id: "batch_dup1",
          input_file_id: "file_input",
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
          metadata: { run_id: "run_recovery" },
        },
        {
          id: "batch_dup2",
          input_file_id: "file_input",
          status: "validating",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
          metadata: { run_id: "run_recovery" },
        },
      ];
      return {
        data,
        raw: data.map((b) => ({
          object: "batch",
          endpoint: "/v1/responses",
          completion_window: "24h",
          ...b,
        })),
        has_more: false,
      };
    });

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/ambiguous/);
    expect(createSpy).not.toHaveBeenCalled();
    // The sidecar must NOT advance to "submitted" — the operator must resolve
    // the duplicate before the next run.
    expect(h.getSidecar()).toMatchObject({ phase: "creating", batchId: "" });
  });

  it("resumes a post-create sidecar and flips its eager-claim pending to ready (no re-create)", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const urlHash = "a".repeat(64);
    const pending: Manifest = ManifestSchema.parse({
      id: "rd_a",
      url: "https://example.com/rd_a",
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: { id: "batch_rd_a", trigger: "reprocess", status: "running", stage: "summarize", started_at: NOW },
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "b".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: NOW,
    });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(pending));

    // A second eager-claim pending that is NOT in this batch's sidecar. Resume must
    // key off the sidecar's targets, not blindly sweep every pending manifest — so
    // this one must be left untouched (proves the rd_a flip is sidecar-driven).
    const otherKp = "readings/kp-rd_other";
    const otherPending: Manifest = ManifestSchema.parse({
      ...pending,
      id: "rd_other",
      url: "https://example.com/rd_other",
      url_hash: "c".repeat(64),
      active_attempt: { id: "batch_rd_other", trigger: "reprocess", status: "running", stage: "summarize", started_at: NOW },
    });
    h.store.set(`${otherKp}/manifest.json`, JSON.stringify(otherPending));

    const sc: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
      batchId: "msgbatch_run",
      model: "claude-opus-4-8",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [
        {
          customId: "rd_a",
          keyPrefix: kp,
          id: "rd_a",
          url: pending.url,
          urlHash,
          createdAt: pending.created_at,
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 7,
        },
      ],
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    const result = await runBatch([row("rd_a")], h.deps);

    expect(result.resumed).toBe(true);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    // the sidecar's specific eager-claim pending (rd_a, batch_rd_a) flips to ready
    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    // the unrelated pending NOT in the sidecar is left untouched (no blind sweep)
    const other = ManifestSchema.parse(JSON.parse(h.store.get(`${otherKp}/manifest.json`)!));
    expect(other.status).toBe("pending");
    expect(other.active_attempt?.id).toBe("batch_rd_other");
    expect(h.deps.corpus.publish).toHaveBeenCalledOnce();
  });

  it("aborts on an activating-window sidecar, then re-runs cleanly to a single claim", async () => {
    const h = harness({ rd_a: manifest("rd_a") });

    // activating-window crash: a sidecar with no batch id
    h.deps.loadSidecar = vi.fn(async (): Promise<PersistedSidecar> => ({
      version: 2,
      provider: "anthropic",
      phase: "activating",
      batchId: "",
      model: "m",
      processingStatus: "activating",
      resultsUrl: null,
      targets: [],
    }));
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/sidecar with no batch id/i);
    expect(h.batch.create).not.toHaveBeenCalled();

    // operator clears the sidecar and re-runs — idempotent, single claim + list row
    h.deps.loadSidecar = vi.fn(async () => null);
    await runBatch([row("rd_a")], h.deps);

    expect(h.deps.corpus.activate).toHaveBeenCalledOnce();
    expect(h.deps.corpus.publish).toHaveBeenCalledOnce();
  });
});

// reading-lite-gh319.2: a provider batch is one spend operation, admitted
// before its first pending sidecar and settled from its results. The unit
// tests in spend.test.ts own the bound and what settles; these own where the
// calls sit in the lifecycle.
describe("runBatch — spend admission", () => {
  const OP_ID = "operator:anthropic-batch:op-1";

  function traced(h: ReturnType<typeof harness>) {
    const events: string[] = [];
    const saved: PersistedSidecar[] = [];
    const rpc = h.deps.spend.rpc;
    h.deps.spend = {
      ...h.deps.spend,
      rpc: async (body) => {
        events.push(String(body.kind));
        return rpc(body);
      },
    };
    const save = h.deps.saveSidecar;
    h.deps.saveSidecar = async (s) => {
      events.push(`sidecar:${s.phase}`);
      saved.push(s);
      await save(s);
    };
    const create = h.batch.create;
    h.batch.create = vi.fn(async (requests: Array<{ custom_id: string }>) => {
      events.push("create");
      return create(requests);
    });
    return { events, saved };
  }

  it("reserves and marks before the first pending sidecar, which precedes create, then settles the results", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const { events, saved } = traced(h);

    const result = await runBatch([row("rd_a")], h.deps);

    expect(events).toEqual([
      "reserve_spend",
      "mark_spend_dispatched",
      "sidecar:activating",
      "sidecar:creating",
      "create",
      "sidecar:submitted",
      "settle_spend",
    ]);
    expect(saved.map((s) => s.spend?.opId)).toEqual([OP_ID, OP_ID, OP_ID]);
    // 5 input × 500 + 2 output × 2,500 hundredths of a µ$, × 1.1 geography.
    expect(result.spend).toEqual({
      state: "settled",
      actualMicrodollars: 83,
      maxMicrodollars: saved[0]!.spend!.quote.maxMicrodollars,
    });
    expect(h.authority.calls.at(-1)).toMatchObject({ opId: OP_ID, actualMicrodollars: 83 });
  });

  it.each([
    ["a budget denial", { ok: false, reason: "daily_spend" }],
    ["a spend authority outage", { ok: false, reason: "unavailable" }],
  ] as const)("%s writes no sidecar, claims nothing, and creates no batch, so a rerun is clean", async (_label, refusal) => {
    const h = harness({ rd_a: manifest("rd_a") });
    const before = h.store.get("readings/kp-rd_a/manifest.json");
    h.authority.answers.reserve_spend = refusal;

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toMatchObject({
      name: "SpendAdmissionError",
      reason: refusal.reason,
    });
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.store.get("readings/kp-rd_a/manifest.json")).toBe(before);

    delete h.authority.answers.reserve_spend;
    const rerun = await runBatch([row("rd_a")], h.deps);
    expect(rerun.report).toEqual([{ id: "rd_a", status: "ready" }]);
  });

  it("refuses a batch the price catalog cannot bound before any paid call", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.model = "claude-not-in-the-catalog";

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toMatchObject({ reason: "unbounded_request" });
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
    expect(h.authority.rpc).not.toHaveBeenCalled();
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
  });

  it.each([
    ["activation leaves nothing to summarize", async () => ({
      activated: [],
      skipped: [{ id: "rd_a", status: "skipped" as const, reason: "by-url slot already owned at batch submit" }],
    })],
    ["activation fails", async () => {
      throw new Error("batch activation lost the rd_a ownership revalidation race");
    }],
  ])("settles at zero when %s, since no batch was created", async (_label, activate) => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.activateExtracted = activate;

    await runBatch([row("rd_a")], h.deps).catch(() => undefined);

    expect(h.authority.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(h.authority.calls.at(-1)).toMatchObject({ opId: OP_ID, actualMicrodollars: 0 });
    expect(h.batch.create).not.toHaveBeenCalled();
  });

  const activatingSpend = {
    tenantId: BILLING_TENANT,
    opId: OP_ID,
    quote: {
      dayKey: "2026-09-19",
      catalogVersion: 1,
      requestFingerprint: "f".repeat(64),
      maxMicrodollars: 900,
    },
  };

  function activatingSidecar(
    provider: "anthropic" | "openai",
    spend = activatingSpend,
  ): PersistedSidecar {
    const spendField = spend ? { spend } : {};
    if (provider === "openai") {
      return {
        version: 2,
        provider: "openai",
        phase: "activating",
        runId: "run_1",
        batchId: "",
        inputFileId: null,
        outputFileId: null,
        errorFileId: null,
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        processingStatus: "activating",
        targets: [],
        ...spendField,
      };
    }
    return {
      version: 2,
      provider: "anthropic",
      phase: "activating",
      batchId: "",
      model: "claude-opus-4-8",
      processingStatus: "activating",
      resultsUrl: null,
      targets: [],
      ...spendField,
    };
  }

  async function writeActivatingThenSkip(
    h: ReturnType<typeof harness>,
    identity: { spend?: typeof activatingSpend },
  ) {
    await h.deps.saveSidecar(activatingSidecar("anthropic", identity.spend));
    return {
      activated: [] as ExtractedTarget[],
      skipped: [{ id: "rd_a", status: "skipped" as const, reason: "by-url slot already owned at batch submit" }],
    };
  }

  it.each(["anthropic", "openai"] as const)(
    "resumes a %s activating sidecar by settling the known-zero hold before the sidecar may be deleted",
    async (provider) => {
      const h = harness({ rd_a: manifest("rd_a") });
      const existing = activatingSidecar(provider);
      h.setSidecar(existing);
      h.deps.loadSidecar = vi.fn(async () => h.getSidecar());

      await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/ownership activation/i);
      expect(h.authority.kinds()).toEqual(["settle_spend"]);
      expect(h.authority.calls[0]).toEqual({
        kind: "settle_spend",
        ...activatingSpend,
        actualMicrodollars: 0,
      });
      expect(h.deps.clearSidecar).not.toHaveBeenCalled();
      expect(h.getSidecar()).toMatchObject({ phase: "activating", spend: { opId: OP_ID } });
      expect(h.batch.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unavailable", { ok: false, reason: "unavailable" }],
    ["refused", { ok: false, reason: "operation_state" }],
  ] as const)(
    "keeps an activating sidecar on resume when zero settlement is %s",
    async (_label, answer) => {
      const h = harness({ rd_a: manifest("rd_a") });
      h.authority.answers.settle_spend = answer;
      h.setSidecar(activatingSidecar("anthropic"));
      h.deps.loadSidecar = vi.fn(async () => h.getSidecar());

      await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/sidecar is retained/);
      expect(h.deps.clearSidecar).not.toHaveBeenCalled();
      expect(h.getSidecar()).toMatchObject({ phase: "activating", spend: { opId: OP_ID } });
      expect(h.authority.kinds()).toEqual(["settle_spend"]);
    },
  );

  it("clears the activating sidecar only after zero settlement is acknowledged when activation leaves nothing", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.activateExtracted = async (_targets, identity) => writeActivatingThenSkip(h, identity);

    const result = await runBatch([row("rd_a")], h.deps);

    expect(h.authority.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(h.authority.calls.at(-1)).toMatchObject({ opId: OP_ID, actualMicrodollars: 0 });
    expect(h.deps.clearSidecar).toHaveBeenCalledOnce();
    expect(h.getSidecar()).toBeNull();
    expect(result.report).toEqual([
      { id: "rd_a", status: "skipped", reason: "by-url slot already owned at batch submit" },
    ]);
  });

  it.each([
    ["unavailable", { ok: false, reason: "unavailable" }],
    ["refused", { ok: false, reason: "operation_state" }],
  ] as const)(
    "keeps the activating sidecar when zero settlement is %s after activation leaves nothing",
    async (_label, answer) => {
      const h = harness({ rd_a: manifest("rd_a") });
      h.authority.answers.settle_spend = answer;
      h.deps.activateExtracted = async (_targets, identity) => writeActivatingThenSkip(h, identity);

      await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/sidecar is retained/);
      expect(h.deps.clearSidecar).not.toHaveBeenCalled();
      expect(h.getSidecar()).toMatchObject({ phase: "activating", spend: { opId: OP_ID } });
      expect(h.authority.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
      expect(h.batch.create).not.toHaveBeenCalled();
    },
  );

  it("keeps the maximum held after an Anthropic create whose outcome is unknown, and never admits it again", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.batch.create.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow("socket hang up");
    expect(h.authority.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched"]);
    expect(h.getSidecar()).toMatchObject({ phase: "creating", spend: { opId: OP_ID } });

    h.deps.loadSidecar = vi.fn(async () => h.getSidecar());
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/no batch id/);
    expect(h.authority.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched"]);
    expect(h.batch.create).toHaveBeenCalledOnce();
  });

  it("adopts an OpenAI batch whose create response was lost and settles it under the persisted operation", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const { create } = installCompletedOpenAIBatch(h);
    create.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow("socket hang up");
    const persisted = h.getSidecar()!.spend!;
    expect(h.getSidecar()).toMatchObject({ phase: "creating", spend: { opId: "operator:openai-batch:op-1" } });

    const remote = {
      id: "batch_openai", object: "batch", endpoint: "/v1/responses", input_file_id: "file_input",
      completion_window: "24h", status: "completed", output_file_id: "file_output", error_file_id: null,
      request_counts: { total: 1, completed: 1, failed: 0 }, metadata: { run_id: "run_recovery" },
    };
    h.deps.openaiBatch!.listBatches = vi.fn(async () => ({ data: [remote], raw: [remote], has_more: false }));
    h.deps.loadSidecar = vi.fn(async () => h.getSidecar());
    const resumed = await runBatch([row("rd_a")], h.deps);

    expect(resumed.report).toEqual([{ id: "rd_a", status: "ready" }]);
    expect(create).toHaveBeenCalledOnce();
    expect(h.authority.kinds()).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    // 5 input × 200 + 2 output × 1,200 hundredths of a µ$.
    expect(h.authority.calls.at(-1)).toEqual({ kind: "settle_spend", ...persisted, actualMicrodollars: 34 });
  });

  it.each([
    ["settles the persisted operation", { ok: true, state: "settled" }, { state: "settled", actualMicrodollars: 83 }],
    // Operation records are discarded a day after the admission day ends.
    ["reports the maximum permanently held once the operation record expired", { ok: false, reason: "operation_state" }, { state: "held", reason: "operation_state" }],
  ] as const)("a resumed batch %s and completes", async (_label, answer, outcome) => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.batch.results.mockRejectedValueOnce(new Error("results download reset"));
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow("results download reset");
    const submitted = h.getSidecar()!;
    expect(submitted).toMatchObject({ phase: "submitted", spend: { opId: OP_ID } });

    const resume = batchSpendAuthority({ settle_spend: answer });
    h.deps.spend = resume.spend;
    h.deps.loadSidecar = vi.fn(async () => submitted);
    const first = await runBatch([row("rd_a")], h.deps);
    const again = await runBatch([row("rd_a")], h.deps);

    expect(first.report).toEqual([{ id: "rd_a", status: "ready" }]);
    expect(first.spend).toMatchObject(outcome);
    // A repeated reconciliation re-sends the identical settlement, which the
    // authority applies at most once; it never reserves again.
    expect(resume.kinds()).toEqual(["settle_spend", "settle_spend"]);
    expect(resume.calls[1]).toEqual(resume.calls[0]);
    const { tenantId, opId, quote } = submitted.spend!;
    expect(resume.calls[0]).toEqual({ kind: "settle_spend", tenantId, opId, quote, actualMicrodollars: 83 });
    expect(again.spend).toEqual(first.spend);
  });
});
