import { stubBatchCorpus } from "../../../helpers/batch-corpus";
import { describe, expect, it, vi } from "vitest";
import { batchSpendAuthority } from "../../../helpers/operator-spend";
import { createHash } from "node:crypto";
import {
  runFreshMarkdownBatch,
  type FreshMarkdownRunDeps,
} from "../../../../scripts/corpus-lib/batch/run-fresh-markdown";
import { ManifestSchema } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { PersistedSidecar, Sidecar } from "../../../../scripts/corpus-lib/batch/types";

const NOW = "2026-06-22T12:00:00.000Z";

function hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function article(name: string, url: string): MarkdownArticle {
  const markdown = `# ${name}\n\n**Source:** ${url}\n\nbody of ${name}`;
  return {
    filePath: `/tmp/${name}.md`,
    fileName: `${name}.md`,
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    title: name,
    sourceUrl: url,
  };
}

const reading = {
  tldr: "Tldr.",
  tags: ["t"],
  keywords: ["keyword one", "keyword two", "keyword three"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "body",
};

// Scripted corpus and provider lifecycle, mirroring
// run.test.ts's harness but for the fresh-markdown front-end.
function harness(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
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
  const batch = {
    create: vi.fn(async () => ({ id: "msgbatch_fresh", processing_status: "in_progress", results_url: null })),
    get: vi.fn(async () => ({ id: "msgbatch_fresh", processing_status: "ended", results_url: "https://results" })),
    results: vi.fn(async () =>
      ((sidecar as Sidecar | null)?.targets ?? []).map((t) => ({
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
  let n = 0;
  let inputJsonl: string | null = null;
  const deps: FreshMarkdownRunDeps = {
    spend: batchSpendAuthority().spend,
    r2: r2 as any,
    corpus: stubBatchCorpus(store),
    batch: batch as any,
    embed: {
      embedMany: vi.fn(async (inputs: string[]) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0.1)),
        tokensByInput: inputs.map(() => 4),
      })),
    },
    extract: vi.fn(async () => {
      throw new Error("fresh-markdown path must never fetch a URL");
    }),
    model: "claude-opus-4-8",
    now: () => NOW,
    newId: vi.fn(() => `rd_FRESH${n++}`),
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
    reconcileAcquireLock: async () => ({
      release: async () => undefined,
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, batch, deps, getSidecar: () => sidecar, setSidecar: (s: PersistedSidecar | null) => (sidecar = s) };
}

describe("runFreshMarkdownBatch — fresh run", () => {
  it("uses one pinned OpenAI run identity across fresh activation, upload, and create", async () => {
    const h = harness();
    const checkpoints: PersistedSidecar[] = [];
    h.deps.configuredProvider = "openai";
    h.deps.model = "gpt-5.6-terra";
    h.deps.reasoningEffort = "low";
    h.deps.newRunId = vi.fn(() => "run_stable");
    h.deps.saveSidecar = vi.fn(async (sidecar) => {
      checkpoints.push(sidecar);
      h.setSidecar(sidecar);
    });
    const upload = vi.fn(async (jsonl: string, runId: string) => ({
      id: "file_input",
      filename: `reading-lite-${runId}.jsonl`,
      purpose: "batch",
      bytes: new TextEncoder().encode(jsonl).byteLength,
    }));
    const create = vi.fn(async (inputFileId: string, runId: string) => ({
      id: "batch_openai",
      input_file_id: inputFileId,
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      request_counts: { total: 1, completed: 0, failed: 0 },
      _runId: runId,
    }));
    h.deps.openaiBatch = {
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
                        text: JSON.stringify({ ...reading, title: "Alpha" }),
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
      listFiles: vi.fn(async () => ({ data: [], has_more: false })),
      listBatches: vi.fn(async () => ({ data: [], raw: [], has_more: false })),
    };

    const result = await runFreshMarkdownBatch(
      [article("alpha", "https://example.com/alpha")],
      h.deps,
    );

    expect(result.report).toContainEqual({
      id: "rd_FRESH0",
      status: "ready",
    });
    expect(h.deps.newRunId).toHaveBeenCalledOnce();
    expect(
      checkpoints.map((checkpoint) => ({
        phase: checkpoint.phase,
        provider: checkpoint.provider,
        runId:
          checkpoint.provider === "openai" ? checkpoint.runId : undefined,
      })),
    ).toEqual([
      { phase: "activating", provider: "openai", runId: "run_stable" },
      { phase: "uploading", provider: "openai", runId: "run_stable" },
      { phase: "creating", provider: "openai", runId: "run_stable" },
      { phase: "submitted", provider: "openai", runId: "run_stable" },
    ]);
    expect(upload).toHaveBeenCalledWith(expect.any(String), "run_stable");
    expect(create).toHaveBeenCalledWith("file_input", "run_stable");
  });

  it("rejects an oversized batch before activating by-url owners", async () => {
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");

    await expect(runFreshMarkdownBatch([a], { ...h.deps, maxBatchBytes: 100 })).rejects.toThrow(
      /re-run with --limit/,
    );

    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.corpus.activate).not.toHaveBeenCalled();
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized final payload before activating by-url owners", async () => {
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");
    h.deps.corpus.query = vi.fn(async () => [
      {
        id: "rd_RELATED",
        score: 0.9,
        metadata: {
          url: "https://example.com/related",
          title: "related ".repeat(20_000),
        },
      },
    ]) as any;

    await expect(runFreshMarkdownBatch([a], { ...h.deps, maxBatchBytes: 50_000 })).rejects.toThrow(
      /re-run with --limit/,
    );

    expect(h.deps.embed.embedMany).toHaveBeenCalledOnce();
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.corpus.activate).not.toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
  });
});

describe("runFreshMarkdownBatch — resume", () => {
  it("resumes an in-flight sidecar without re-planning or creating a new batch", async () => {
    const h = harness();
    const sc: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
      batchId: "msgbatch_fresh",
      model: "claude-opus-4-8",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [
        {
          customId: "rd_RESUME",
          keyPrefix: "readings/kp-resume",
          id: "rd_RESUME",
          url: "https://example.com/resume",
          urlHash: hex("https://example.com/resume"),
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceType: "markdown",
          contentType: "text/markdown; charset=utf-8",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 4,
        },
      ],
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    const result = await runFreshMarkdownBatch([article("alpha", "https://example.com/alpha")], h.deps);
    expect(result.resumed).toBe(true);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.deps.newId).not.toHaveBeenCalled();
    const m = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-resume/manifest.json")!));
    expect(m.status).toBe("ready");
    expect(m.source_type).toBe("markdown");
  });
});
