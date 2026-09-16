import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newBatchAttemptId,
  runBatch,
  runBatchPipeline,
  type BatchRunDeps,
} from "../../../../scripts/corpus-lib/batch/run";
import { activateRecoverTargets } from "../../../../scripts/corpus-lib/batch/activation-phase";
import { loadSidecar } from "../../../../scripts/corpus-lib/batch/sidecar";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { isBatchOwnedPending } from "../../../../src/modules/staleness";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { AuditRow } from "../../../../scripts/corpus-lib/types";
import type { ExtractedContent } from "../../../../src/modules/extractor";
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

// A fake harness: in-memory R2, recording vectorize, scripted batch lifecycle.
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
  const vectorize = {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
  };
  // The vector ledger (issue #195 S3), recording the upsert count at the moment
  // each row was written so the "before the upsert" ordering is assertable.
  const ledgered: string[] = [];
  const ledger = {
    markLive: async (ids: readonly string[]) => {
      for (const id of ids) ledgered.push(`live:${id}:${vectorize.upsert.mock.calls.length}`);
    },
    markDeleteSubmitted: async () => {},
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
  const deps: BatchRunDeps = {
    r2: r2 as any,
    vectorize: vectorize as any,
    ledger,
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
  return { store, r2, vectorize, ledgered, batch, extract, deps, getSidecar: () => sidecar, setSidecar: (s: PersistedSidecar | null) => (sidecar = s), getInputJsonl: () => inputJsonl, setInputJsonl: (s: string | null) => (inputJsonl = s) };
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

const TENANT = "usr_11111111-1111-4111-8111-111111111111";

describe("runBatch — fresh run", () => {
  it("fresh-extracts a failed recovery target before OpenAI upload and publishes it at the same owner", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.store.delete("readings/kp-rd_a/extracted.md");
    const ownerKey = `index/by-url/${manifest("rd_a").url_hash}`;
    let stateAtUpload: {
      owner: string | undefined;
      raw: string | undefined;
      extracted: string | undefined;
      manifest: Manifest;
    } | undefined;
    installCompletedOpenAIBatch(h, {
      onUpload: () => {
        stateAtUpload = {
          owner: h.store.get(ownerKey),
          raw: h.store.get("readings/kp-rd_a/raw.html"),
          extracted: h.store.get("readings/kp-rd_a/extracted.md"),
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
      owner: JSON.stringify({
        id: "rd_a",
        key_prefix: "readings/kp-rd_a",
      }),
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
    expect(JSON.parse(h.store.get(ownerKey)!)).toEqual({
      id: "rd_a",
      key_prefix: "readings/kp-rd_a",
    });
    expect(h.vectorize.upsert).toHaveBeenCalledOnce();
    // The ledger reaches write-phase through BatchRunDeps, and the row lands
    // BEFORE the upsert. `ops corpus ingest` and `corpus recover --batch` are
    // vector writers with no `users.status` check, so an un-ledgered upsert
    // here is a vector the account wipe will never even ask Vectorize to
    // delete — and will then report a clean completion around.
    expect(h.ledgered).toEqual(["live:rd_a:0"]);
  });

  it("returns neighbours under bare reading ids when writing into a tenant namespace", async () => {
    // `SimilarityStore.query` in the Worker strips its own `{tenant}:` prefix so
    // callers only ever see reading ids; `makeVectorizeClient.query` does not,
    // and this pipeline consumes matches directly. That divergence was
    // invisible while the pipeline wrote bare ids, and stopped being invisible
    // the moment write-phase started composing them — the pipeline now reads
    // back its own prefixed writes.
    //
    // Two things go wrong without the strip, and neither is loud: `excludeSelf`
    // compares the bare reading id against a prefixed match, so a re-ingested
    // reading spends a neighbour slot on ITSELF at ~1.0; and the ids flow into
    // `similarity`/`connections` on the manifest this pipeline writes, where
    // the read path and the SPA expect bare reading ids.
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.vectorNamespace = TENANT;
    h.deps.vectorize.query = vi.fn(async () => [
      // The reading's own vector, as Vectorize returns it: prefixed.
      { id: `${TENANT}:rd_a`, score: 0.99, metadata: { url: "https://a", title: "A" } },
      { id: `${TENANT}:rd_neighbour`, score: 0.8, metadata: { url: "https://n", title: "N" } },
    ]);

    const result = await runBatch([row("rd_a")], h.deps);
    expect(result.report[0]?.status).toBe("ready");

    const written = ManifestSchema.parse(
      JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
    );
    // Self excluded despite the prefix, so the slot was not wasted...
    expect(JSON.stringify(written)).not.toContain(`${TENANT}:rd_a`);
    // ...and no prefixed id reached the manifest at all.
    expect(JSON.stringify(written)).not.toContain(`${TENANT}:rd_neighbour`);
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

    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.map((i: any) => i.id).sort()).toEqual(["rd_a", "rd_b"]);

    // by-url pointers written for both
    expect(h.store.has(`index/by-url/${mA.url_hash}`)).toBe(true);
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
    expect(dropLine).toMatch(/manifest/i); // the reason from prepare
  });
});

describe("runBatch — resume", () => {
  it("terminal-writes a completed OpenAI batch whose only results are in the error file", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const urlHash = manifest("rd_a").url_hash;
    h.store.set(
      `index/by-url/${urlHash}`,
      JSON.stringify({ id: "rd_a", key_prefix: "readings/kp-rd_a" }),
    );
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
    expect(h.store.has(`index/by-url/${urlHash}`)).toBe(false);
    expect(h.store.has("index/by-id/rd_a")).toBe(true);
  });

  it.each(["failed", "expired", "cancelled"] as const)(
    "terminal-writes every unresolved target when an OpenAI batch is %s",
    async (status) => {
      const h = harness({ rd_a: manifest("rd_a") });
      const urlHash = manifest("rd_a").url_hash;
      const ownerKey = `index/by-url/${urlHash}`;
      h.store.set(
        ownerKey,
        JSON.stringify({ id: "rd_a", key_prefix: "readings/kp-rd_a" }),
      );
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
      expect(h.store.has("index/by-id/rd_a")).toBe(true);
      // Recover targets retain their existing owner on failure.
      expect(h.store.has(ownerKey)).toBe(true);
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
    expect(h.vectorize.upsert).not.toHaveBeenCalled();
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
    expect(h.vectorize.upsert).not.toHaveBeenCalled();
  });
});

describe("runBatch — eager recover claim", () => {
  it("keeps a ready recovery owner and preserved snapshot through a successful OpenAI replacement", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const ready = manifest("rd_a", {
      status: "ready",
      title: "Prior ready title",
      tldr: "prior ready summary",
      tags: ["prior"],
      keywords: ["prior ready state", "recovery ownership", "batch replacement"],
      people: [],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [],
      summary_markdown: "Prior body.",
    });
    const ownerKey = `index/by-url/${ready.url_hash}`;
    h.store.set(`${kp}/manifest.json`, JSON.stringify(ready));
    h.store.set(`${kp}/extracted.md`, "# Saved\n\nrecovery markdown");
    h.store.set(
      ownerKey,
      JSON.stringify({ id: "rd_a", key_prefix: kp }),
    );
    installCompletedOpenAIBatch(h);
    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: ready.url,
        urlHash: ready.url_hash,
        keyPrefix: kp,
        createdAt: ready.created_at,
        attemptId: "at_ready_success",
        attemptStartedAt: NOW,
        trigger: "reprocess",
        manifest: ready,
      },
      markdown: "# Saved\n\nrecovery markdown",
    };

    const result = await runBatchPipeline(
      async () => ({ extracted: [injected], dropped: [] }),
      {
        ...h.deps,
        activateExtracted: (targets, identity) =>
          activateRecoverTargets(targets, {
            r2: h.deps.r2,
            identity,
            now: h.deps.now,
            saveSidecar: h.deps.saveSidecar,
          }),
      },
    );

    expect(result.report).toContainEqual({ id: "rd_a", status: "ready" });
    const submitted = h.getSidecar();
    expect(submitted).toMatchObject({
      provider: "openai",
      phase: "submitted",
      targets: [
        {
          id: "rd_a",
          keyPrefix: kp,
          preserveReadyManifest: {
            status: "ready",
            title: "Prior ready title",
          },
        },
      ],
    });
    expect(JSON.parse(h.store.get(ownerKey)!)).toEqual({
      id: "rd_a",
      key_prefix: kp,
    });
    expect(h.r2.delete).not.toHaveBeenCalledWith(ownerKey);
    const final = ManifestSchema.parse(
      JSON.parse(h.store.get(`${kp}/manifest.json`)!),
    );
    expect(final.status).toBe("ready");
    expect(final.title).toBe("Title rd_a");
    expect(final.usage).toMatchObject({
      summarization: { provider: "openai", model: "gpt-5.6-terra" },
    });
  });

  it("claims by-url and writes the pending manifest before creating the batch", async () => {
    const h = harness({ rd_a: manifest("rd_a") }); // failed, no by-url
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

    let atCreate: { byUrl?: string; manifest?: string } = {};
    const origCreate = h.batch.create;
    h.batch.create = vi.fn(async (r: any) => {
      atCreate = {
        byUrl: h.store.get(byUrlKey),
        manifest: h.store.get("readings/kp-rd_a/manifest.json"),
      };
      return origCreate(r);
    });

    const result = await runBatch([row("rd_a")], h.deps);

    // by-url claimed == {id, key_prefix} and the pending manifest exists BEFORE create
    expect(atCreate.byUrl).toBeDefined();
    expect(JSON.parse(atCreate.byUrl!)).toEqual({ id: "rd_a", key_prefix: "readings/kp-rd_a" });
    expect(JSON.parse(atCreate.manifest!).status).toBe("pending");

    // final manifest lands ready
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(1);
    expect(ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!)).status).toBe("ready");
  });

  it("keeps the by-url claim on batch failure so the failed recover URL stays re-submittable", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    const result = await runBatch([row("rd_a")], h.deps);
    expect(result.report.filter((r) => r.status === "failed")).toHaveLength(1);

    const final = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!));
    expect(final.status).toBe("failed");
    // by-id present (no dangling row); by-url kept (contrast fresh ingest's release)
    expect(h.store.has("index/by-id/rd_a")).toBe(true);
    expect(h.store.has(byUrlKey)).toBe(true);
    expect(h.r2.delete).not.toHaveBeenCalledWith(byUrlKey);
    // the kept pointer still resolves the failed reading as owner
    expect(JSON.parse(h.store.get(byUrlKey)!)).toEqual({ id: "rd_a", key_prefix: "readings/kp-rd_a" });
    // failed list row present
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.find((i: any) => i.id === "rd_a").status).toBe("failed");
  });

  it("rolls a ready reading forward on failure (defensive: stale in-memory manifest invariant)", async () => {
    // corpus-audit never routes ready rows into recover, so this injects a ready
    // target.manifest straight at the runBatch/activateRecoverTargets seam. The
    // invariant: activation must flip only the live R2 manifest, never the
    // in-memory snapshot submit-phase reads to compute preserveReadyManifest.
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const ready = manifest("rd_a", { status: "ready", title: "Ready", tldr: "keep me" });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(ready));
    h.store.set(`index/by-url/${ready.url_hash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));

    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: ready.url,
        urlHash: ready.url_hash,
        keyPrefix: kp,
        createdAt: ready.created_at,
        attemptId: "at_ready_failure",
        attemptStartedAt: NOW,
        trigger: "reprocess",
        manifest: ready,
      },
      markdown: "# rd_a\n\nbody",
      fresh: {
        raw: new TextEncoder().encode("<html>new body</html>"),
        content_type: "text/html",
        content_status: "captured",
        content_bytes: 999,
        content_sha256: "c".repeat(64),
        markdown: "# rd_a\n\nbody",
      },
    };

    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    await runBatchPipeline(async () => ({ extracted: [injected], dropped: [] }), {
      ...h.deps,
      activateExtracted: (targets) =>
        activateRecoverTargets(targets, {
          r2: h.deps.r2,
          model: h.deps.model,
          now: h.deps.now,
          saveSidecar: h.deps.saveSidecar,
        }),
    });

    // rolled FORWARD to ready (preserveReadyManifest), not down to failed
    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("keep me");
    expect(final.active_attempt).toBeUndefined();
  });

  it("rolls forward when the live manifest becomes ready before activation", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const failedAtPrepare = manifest("rd_a", { status: "failed" });
    const liveReady = manifest("rd_a", {
      status: "ready",
      title: "Ready before activation",
      tldr: "keep live ready",
      tags: ["saved"],
      keywords: ["live manifest", "recovery state", "ownership check"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "live summary",
    });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(liveReady));
    h.store.set(`${kp}/extracted.md`, "# rd_a\n\nsaved markdown");
    h.store.set(`index/by-url/${liveReady.url_hash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));

    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: failedAtPrepare.url,
        urlHash: failedAtPrepare.url_hash,
        keyPrefix: kp,
        createdAt: failedAtPrepare.created_at,
        attemptId: "at_failed_recover",
        attemptStartedAt: NOW,
        trigger: "reprocess",
        manifest: failedAtPrepare,
      },
      markdown: "# rd_a\n\nbody",
    };

    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    await runBatchPipeline(async () => ({ extracted: [injected], dropped: [] }), {
      ...h.deps,
      activateExtracted: (targets) =>
        activateRecoverTargets(targets, {
          r2: h.deps.r2,
          model: h.deps.model,
          now: h.deps.now,
          saveSidecar: h.deps.saveSidecar,
        }),
    });

    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("keep live ready");
    expect(final.title).toBe("Ready before activation");
    expect(final.active_attempt).toBeUndefined();
  });

  it("preserves a ready snapshot across an activation-window crash and rerun", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const ready = manifest("rd_a", {
      status: "ready",
      title: "Ready before batch",
      tldr: "keep me",
      tags: ["saved"],
      keywords: ["ready snapshot", "rollback state", "recovery batch"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "previous summary",
    });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(ready));
    h.store.set(`${kp}/extracted.md`, "# rd_a\n\nsaved markdown");
    h.store.set(`index/by-url/${ready.url_hash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));

    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: ready.url,
        urlHash: ready.url_hash,
        keyPrefix: kp,
        createdAt: ready.created_at,
        attemptId: "at_ready_anthropic",
        attemptStartedAt: NOW,
        trigger: "reprocess",
        manifest: ready,
      },
      markdown: "# rd_a\n\nbody",
    };

    await expect(
      runBatchPipeline(async () => ({ extracted: [injected], dropped: [] }), {
        ...h.deps,
        activateExtracted: async (targets) => {
          await activateRecoverTargets(targets, {
            r2: h.deps.r2,
            model: h.deps.model,
            now: h.deps.now,
            saveSidecar: h.deps.saveSidecar,
          });
          throw new Error("simulated crash after activation");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    expect(ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!)).status).toBe("pending");
    h.setSidecar(null);

    await expect(
      runBatch([row("rd_a")], {
        ...h.deps,
        activateExtracted: async (targets) => {
          await activateRecoverTargets(targets, {
            r2: h.deps.r2,
            model: h.deps.model,
            now: h.deps.now,
            saveSidecar: h.deps.saveSidecar,
          });
          throw new Error("simulated second crash after activation");
        },
      }),
    ).rejects.toThrow(/simulated second crash/);

    expect(ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!)).status).toBe("pending");
    h.setSidecar(null);
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    await runBatch([row("rd_a")], h.deps);

    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("keep me");
    expect(final.title).toBe("Ready before batch");
    expect(final.content_bytes).toBe(ready.content_bytes);
    expect(final.content_sha256).toBe(ready.content_sha256);
    expect(final.active_attempt).toBeUndefined();
  });

  it("activates one target and skips another (foreign-owned) in the same run", async () => {
    const h = harness({ rd_a: manifest("rd_a"), rd_b: manifest("rd_b") });
    // rd_b's by-url slot is owned by a different reading → activation skips it,
    // and only rd_a is summarized + flipped to ready.
    h.store.set(`index/by-url/${manifest("rd_b").url_hash}`, JSON.stringify({ id: "rd_other", key_prefix: "readings/kp-other" }));

    const result = await runBatch([row("rd_a"), row("rd_b")], h.deps);

    expect(result.report.find((r) => r.id === "rd_b")).toMatchObject({
      status: "skipped",
      reason: "by-url owned by a different reading",
    });
    expect(result.report.filter((r) => r.status === "ready").map((r) => r.id)).toEqual(["rd_a"]);
    // only the activated target was submitted, and rd_b stays untouched (still failed)
    expect(h.batch.create.mock.calls[0]![0]).toHaveLength(1);
    expect(ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!)).status).toBe("ready");
    expect(ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_b/manifest.json")!)).status).toBe("failed");
    // rd_b never clobbered rd_other's by-url slot
    expect(JSON.parse(h.store.get(`index/by-url/${manifest("rd_b").url_hash}`)!).id).toBe("rd_other");
  });

  it("rejects an oversized payload before any by-url claim or batch create", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

    await expect(runBatch([row("rd_a")], { ...h.deps, maxBatchBytes: 100 })).rejects.toThrow(/re-run with --limit/);

    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.store.has(byUrlKey)).toBe(false);
    expect(h.batch.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized OpenAI payload before embedding or any by-url claim", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    installCompletedOpenAIBatch(h);
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

    await expect(runBatch([row("rd_a")], { ...h.deps, maxBatchBytes: 100 })).rejects.toThrow(/re-run with --limit/);

    // The extracted-only preflight must fire before similarity resolution spends
    // embedding quota, and before any eager by-url claim or remote object.
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.store.has(byUrlKey)).toBe(false);
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
    expect(h.store.get("readings/kp-rd_a/extracted.md")).toBe(
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
    expect(
      [...h.store.keys()].filter((key) =>
        key.startsWith("index/by-url/"),
      ),
    ).toHaveLength(1);
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
    h.store.set(`index/by-url/${urlHash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));
    h.store.set("index/by-id/rd_a", JSON.stringify({ id: "rd_a", key_prefix: kp }));

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
    h.store.set(
      "index/list.json",
      JSON.stringify({
        version: 1,
        items: [
          { id: "rd_a", key_prefix: kp, url: pending.url, status: "pending", created_at: pending.created_at, updated_at: NOW },
          { id: "rd_other", key_prefix: otherKp, url: otherPending.url, status: "pending", created_at: pending.created_at, updated_at: NOW },
        ],
      }),
    );

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
    // by-url / by-id stay consistent for the flipped reading
    expect(JSON.parse(h.store.get(`index/by-url/${urlHash}`)!)).toEqual({ id: "rd_a", key_prefix: kp });
    expect(JSON.parse(h.store.get("index/by-id/rd_a")!)).toEqual({ id: "rd_a", key_prefix: kp });
  });

  it("aborts on an activating-window sidecar, then re-runs cleanly to a single claim", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

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

    expect([...h.store.keys()].filter((k) => k.startsWith("index/by-url/"))).toHaveLength(1);
    expect(h.store.has(byUrlKey)).toBe(true);
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.filter((i: any) => i.id === "rd_a")).toHaveLength(1);
  });
});
