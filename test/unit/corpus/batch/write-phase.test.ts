import type { BatchCorpus } from "../../../../scripts/corpus-lib/batch/postgres";
import { describe, expect, it, vi } from "vitest";
import {
  writeOpenAIResults,
  writeResults,
} from "../../../../scripts/corpus-lib/batch/write-phase";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME, REJECT_SOURCE_TOOL_NAME } from "../../../../src/modules/anthropic";
import type {
  OpenAISubmittedSidecar,
  Sidecar,
  SidecarTarget,
} from "../../../../scripts/corpus-lib/batch/types";
import type { BatchResult } from "../../../../scripts/corpus-lib/batch/clients";

const NOW = "2026-06-18T12:00:00.000Z";

function sidecarTarget(over: Partial<SidecarTarget> = {}): SidecarTarget {
  return {
    customId: "rd_a",
    keyPrefix: "readings/2026/01/01T000000Z-rd_a",
    id: "rd_a",
    url: "https://example.com/a",
    urlHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceType: "url",
    contentType: "text/html",
    contentStatus: "captured",
    contentBytes: 42,
    contentSha256: "b".repeat(64),
    extractedBytes: 30,
    queryEmbedTokens: 50,
    ...over,
  };
}

function sidecar(targets: SidecarTarget[]): Sidecar {
  return {
    version: 2,
    provider: "anthropic",
    phase: "submitted",
    batchId: "msgbatch_1",
    model: "claude-opus-4-8",
    processingStatus: "ended",
    resultsUrl: "https://r",
    targets,
  };
}

const validReading = {
  title: "Resolved Title",
  tldr: "A crisp summary.",
  tags: ["ai", "infra"],
  keywords: ["k1", "k2", "k3"],
  people: [],
  orgs: ["OpenAI"],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "para one\n\npara two",
};

function succeeded(customId: string, input: unknown = validReading): BatchResult {
  return {
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "tool_use", id: "t", name: EMIT_READING_TOOL_NAME, input }],
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 400,
        },
      },
    },
  };
}

function errored(customId: string): BatchResult {
  return { custom_id: customId, result: { type: "errored", error: { type: "api_error", message: "boom" } } };
}

function openAIResponseBody(reading = validReading) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: JSON.stringify(reading) },
        ],
      },
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 },
      output_tokens_details: { reasoning_tokens: 50 },
    },
  };
}

function openAISidecar(
  targets: SidecarTarget[],
  over: Partial<OpenAISubmittedSidecar> = {},
): OpenAISubmittedSidecar {
  return {
    version: 2,
    provider: "openai",
    phase: "submitted",
    runId: "run_1",
    batchId: "batch_1",
    inputFileId: "file_input",
    outputFileId: "file_output",
    errorFileId: null,
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    processingStatus: "completed",
    targets,
    ...over,
  };
}

// In-memory R2 fake backed by a Map, recording the final state of each key.
function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, body: Uint8Array | string) => {
      store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    }),
    head: vi.fn(async (key: string) => store.has(key)),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const embedMany = (vecCount = 1536) =>
  vi.fn(async (inputs: string[]) => ({
    embeddings: inputs.map(() => Array.from({ length: vecCount }, () => 0.01)),
    tokensByInput: inputs.map(() => 8),
  }));

function deps(
  r2: ReturnType<typeof fakeR2>,
  embed = embedMany(),
) {
  return {
    r2,
    corpus: {
      disposition: async () => "active" as const,
      discardContent: async () => {},
      publish: async (target: SidecarTarget, manifest: Manifest) => { r2.store.set(`${target.keyPrefix}/manifest.json`, JSON.stringify(manifest)); return true; },
      fail: async (target: SidecarTarget, manifest: Manifest) => { r2.store.set(`${target.keyPrefix}/manifest.json`, JSON.stringify(manifest)); return true; },
    } as unknown as BatchCorpus,
    embedMany: embed,
    now: () => NOW,
  };
}

describe("writeResults — success path", () => {
  it("finishes the sidecar attempt on a ready manifest", async () => {
    const r2 = fakeR2();
    const attempted = sidecarTarget({
      attemptId: "at_batch_1",
      attemptStartedAt: "2026-06-18T11:55:00.000Z",
      trigger: "reprocess",
    });
    await writeResults(sidecar([attempted]), [succeeded("rd_a")], deps(r2));
    const manifest = ManifestSchema.parse(JSON.parse(r2.store.get(`${attempted.keyPrefix}/manifest.json`)!));
    expect(manifest.last_attempt).toEqual({
      id: "at_batch_1",
      trigger: "reprocess",
      status: "succeeded",
      stage: "write_indexes",
      started_at: "2026-06-18T11:55:00.000Z",
      finished_at: NOW,
    });
  });

  it("writes enrichment_degradation from the sidecar onto a ready manifest", async () => {
    const r2 = fakeR2();
    const degradation = {
      source: "youtube" as const,
      tier: "transcript" as const,
      code: "OversizedResponseError",
      message: "response exceeded maxBytes=1000: https://www.youtube.com/api/timedtext",
    };
    await writeResults(
      sidecar([sidecarTarget({ enrichmentDegradation: degradation })]),
      [succeeded("rd_a")],
      deps(r2),
    );
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.enrichment_degradation).toEqual(degradation);
  });

  it("writes a prior source_date from the sidecar onto a ready manifest", async () => {
    const r2 = fakeR2();
    await writeResults(
      sidecar([sidecarTarget({ sourceDate: "2024-03-15" })]),
      [succeeded("rd_a")],
      deps(r2),
    );
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.source_date).toBe("2024-03-15");
  });

  it("writes a prior source_date from the sidecar onto a failed manifest", async () => {
    const r2 = fakeR2();
    await writeResults(
      sidecar([sidecarTarget({ sourceDate: "2024-03-15" })]),
      [errored("rd_a")],
      deps(r2),
    );
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.status).toBe("failed");
    expect(m.source_date).toBe("2024-03-15");
  });

  it("writes a ready manifest with the resolved reading fields", async () => {
    const r2 = fakeR2();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2));
    const raw = r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!;
    const m: Manifest = ManifestSchema.parse(JSON.parse(raw));
    expect(m.status).toBe("ready");
    expect(m.title).toBe("Resolved Title");
    expect(m.tldr).toBe("A crisp summary.");
    expect(m.tags).toEqual(["ai", "infra"]);
    expect(m.content_type).toBe("text/html");
    expect(m.content_bytes).toBe(42);
    expect(m.enrichment_degradation).toBeUndefined();
    expect("source_date" in m).toBe(false);
    expect(m.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(m.updated_at).toBe(NOW);
    // openai_embedding_tokens = query (sidecar, 50) + tldr (embedMany, 8).
    expect(m.usage?.openai_embedding_tokens).toBe(58);
    expect(m.usage).toMatchObject({
      summarization: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
      },
    });
  });

  it("persists judged candidate IDs from the sidecar, including uncited ones", async () => {
    const r2 = fakeR2();
    await writeResults(
      sidecar([
        sidecarTarget({
          neighbourhoodIds: ["rd_cited", "rd_rejected"],
        }),
      ]),
      [
        succeeded("rd_a", {
          ...validReading,
          novelty_verdict: "familiar",
          connections: [{ id: "rd_cited", reason: "same topic" }],
        }),
      ],
      deps(r2),
    );
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.connections).toEqual([{ id: "rd_cited", reason: "same topic" }]);
    expect(m.connections_neighbourhood_ids).toEqual(["rd_cited", "rd_rejected"]);
  });

  it("omits the ingest baseline when a pre-upgrade sidecar has no neighbourhood IDs", async () => {
    const r2 = fakeR2();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2));
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect("connections_neighbourhood_ids" in m).toBe(false);
  });

});

describe("writeOpenAIResults — success path", () => {
  it("matches JSONL by custom_id and persists provider-normalized OpenAI usage", async () => {
    const r2 = fakeR2();
    const sc = openAISidecar([sidecarTarget()]);
    const jsonl =
      JSON.stringify({
        id: "batch_req_1",
        custom_id: "rd_a",
        response: {
          status_code: 200,
          request_id: "req_1",
          body: openAIResponseBody(),
        },
        error: null,
      }) + "\n";

    await writeOpenAIResults(sc, jsonl, deps(r2));

    const ready = ManifestSchema.parse(
      JSON.parse(
        r2.store.get(
          "readings/2026/01/01T000000Z-rd_a/manifest.json",
        )!,
      ),
    );
    expect(ready.status).toBe("ready");
    expect(ready.usage).toMatchObject({
      summarization: {
        provider: "openai",
        model: "gpt-5.6-terra",
        input_tokens: 1000,
        output_tokens: 200,
        reasoning_tokens: 50,
        cached_input_tokens: 400,
        cache_write_tokens: 300,
      },
    });
  });

  it("merges output and error files by custom_id and writes every target once", async () => {
    const a = sidecarTarget();
    const b = sidecarTarget({
      customId: "rd_b",
      id: "rd_b",
      keyPrefix: "readings/kp-b",
      url: "https://example.com/b",
      urlHash: "c".repeat(64),
    });
    const r2 = fakeR2();
    const outputJsonl =
      JSON.stringify({
        custom_id: "rd_b",
        response: {
          status_code: 200,
          body: openAIResponseBody({ ...validReading, title: "B" }),
        },
        error: null,
      }) + "\n";
    const errorJsonl =
      JSON.stringify({
        custom_id: "rd_a",
        response: null,
        error: { code: "rate_limit_exceeded", message: "rate limited" },
      }) + "\n";

    const report = await writeOpenAIResults(
      openAISidecar([a, b]),
      { outputJsonl, errorJsonl, batchStatus: "completed" },
      deps(r2),
    );

    expect(report).toEqual([
      { id: "rd_b", status: "ready" },
      { id: "rd_a", status: "failed", reason: "rate limited" },
    ]);
    const failed = ManifestSchema.parse(
      JSON.parse(r2.store.get(`${a.keyPrefix}/manifest.json`)!),
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "OpenAIBatchRequestError",
        message: "rate limited",
        retryable: true,
      },
    });

  });

  it.each([
    {
      name: "non-2xx response",
      line: {
        custom_id: "rd_a",
        response: {
          status_code: 429,
          body: { error: { message: "retry after quota reset" } },
        },
        error: null,
      },
      code: "OpenAIBatchRequestError",
      message: /429.*retry after quota reset/i,
    },
    {
      name: "refusal",
      line: {
        custom_id: "rd_a",
        response: {
          status_code: 200,
          body: {
            ...openAIResponseBody(),
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "refusal", refusal: "cannot summarize" },
                ],
              },
            ],
          },
        },
        error: null,
      },
      code: "OpenAIRefusalError",
      message: /cannot summarize/i,
    },
    {
      name: "thin-source reject_source",
      line: {
        custom_id: "rd_a",
        response: {
          status_code: 200,
          body: {
            ...openAIResponseBody(),
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      result: "reject_source",
                      reason: "teaser of the URL, not the article",
                      reading: null,
                    }),
                  },
                ],
              },
            ],
          },
        },
        error: null,
      },
      code: "OpenAISourceRejectedError",
      message: /teaser of the URL, not the article/i,
    },
    {
      name: "incomplete response",
      line: {
        custom_id: "rd_a",
        response: {
          status_code: 200,
          body: {
            ...openAIResponseBody(),
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
          },
        },
        error: null,
      },
      code: "OpenAIIncompleteResponseError",
      message: /incomplete.*max_output_tokens/i,
    },
    {
      name: "known malformed line",
      line: {
        custom_id: "rd_a",
        response: null,
        error: null,
      },
      code: "OpenAIBatchResultMalformed",
      message: /neither a valid response nor an error/i,
    },
  ])(
    "turns a $name into an actionable retryable provider failure",
    async ({ line, code, message }) => {
      const r2 = fakeR2();
      await writeOpenAIResults(
        openAISidecar([sidecarTarget()]),
        {
          outputJsonl: JSON.stringify(line) + "\n",
          batchStatus: "completed",
        },
        deps(r2),
      );

      const failed = ManifestSchema.parse(
        JSON.parse(
          r2.store.get(
            "readings/2026/01/01T000000Z-rd_a/manifest.json",
          )!,
        ),
      );
      expect(failed).toMatchObject({
        status: "failed",
        error: { code, retryable: true },
      });
      expect(failed.error?.message).toMatch(message);
    },
  );

  it("marks a target missing when malformed JSON cannot identify a custom_id", async () => {
    const r2 = fakeR2();
    const report = await writeOpenAIResults(
      openAISidecar([sidecarTarget()]),
      {
        outputJsonl: "{not-json}\n",
        batchStatus: "completed",
      },
      deps(r2),
    );

    const failed = ManifestSchema.parse(
      JSON.parse(
        r2.store.get(
          "readings/2026/01/01T000000Z-rd_a/manifest.json",
        )!,
      ),
    );
    expect(failed.error?.code).toBe("OpenAIBatchResultMissing");
    expect(report).toEqual([
      {
        id: "rd_a",
        status: "failed",
        reason: "OpenAI batch completed without a result for this reading",
      },
    ]);
  });

  it("lets a valid success win over a duplicate error for the same custom_id", async () => {
    const r2 = fakeR2();
    const error = JSON.stringify({
      custom_id: "rd_a",
      response: null,
      error: { message: "stale duplicate error" },
    });
    const success = JSON.stringify({
      custom_id: "rd_a",
      response: { status_code: 200, body: openAIResponseBody() },
      error: null,
    });

    const report = await writeOpenAIResults(
      openAISidecar([sidecarTarget()]),
      {
        outputJsonl: `${error}\n${success}\n`,
        batchStatus: "completed",
      },
      deps(r2),
    );

    expect(report).toEqual([{ id: "rd_a", status: "ready" }]);
  });

  it("prefers an explicit error-file diagnostic over a malformed output duplicate", async () => {
    const r2 = fakeR2();
    await writeOpenAIResults(
      openAISidecar([sidecarTarget()]),
      {
        outputJsonl:
          JSON.stringify({
            custom_id: "rd_a",
            response: { status_code: 200, body: {} },
            error: null,
          }) + "\n",
        errorJsonl:
          JSON.stringify({
            custom_id: "rd_a",
            response: null,
            error: {
              code: "server_error",
              message: "provider request failed",
            },
          }) + "\n",
        batchStatus: "completed",
      },
      deps(r2),
    );

    const failed = ManifestSchema.parse(
      JSON.parse(
        r2.store.get(
          "readings/2026/01/01T000000Z-rd_a/manifest.json",
        )!,
      ),
    );
    expect(failed.error).toMatchObject({
      code: "OpenAIBatchRequestError",
      message: "provider request failed",
    });
  });
});

describe("writeResults — failure path", () => {
  it("finishes the sidecar attempt with the manifest failure", async () => {
    const r2 = fakeR2();
    const attempted = sidecarTarget({
      attemptId: "at_batch_failed",
      attemptStartedAt: "2026-06-18T11:55:00.000Z",
      trigger: "import",
    });
    await writeResults(sidecar([attempted]), [errored("rd_a")], deps(r2));
    const manifest = ManifestSchema.parse(JSON.parse(r2.store.get(`${attempted.keyPrefix}/manifest.json`)!));
    expect(manifest.last_attempt).toEqual({
      id: "at_batch_failed",
      trigger: "import",
      status: "failed",
      stage: "summarize",
      started_at: "2026-06-18T11:55:00.000Z",
      finished_at: NOW,
      error: manifest.error,
    });
  });

});

describe("writeResults — robustness", () => {
  it("reports a result whose custom_id has no sidecar target without throwing", async () => {
    const r2 = fakeR2();
    const report = await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_ghost")], deps(r2));
    expect(report.find((r) => r.id === "rd_ghost")?.status).toBe("skipped");
  });

  it("marks a sidecar target with no batch result as failed (retryable), not dropped", async () => {
    const r2 = fakeR2();
    const report = await writeResults(sidecar([sidecarTarget()]), [], deps(r2));
    expect(report.find((r) => r.id === "rd_a")?.status).toBe("failed");
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(m.error?.code).toBe("BatchResultMissing");
    expect(m.error?.retryable).toBe(true);
  });

  it("marks a success whose tool output fails validation as failed (retryable)", async () => {
    const r2 = fakeR2();
    const bad = succeeded("rd_a", { ...validReading, novelty_verdict: "nope" });
    const report = await writeResults(sidecar([sidecarTarget()]), [bad], deps(r2));
    expect(report.find((r) => r.id === "rd_a")?.status).toBe("failed");
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(m.error?.retryable).toBe(true);
  });

  it("marks a reject_source tool call as failed with SourceRejectedError", async () => {
    const r2 = fakeR2();
    const rejected: BatchResult = {
      custom_id: "rd_a",
      result: {
        type: "succeeded",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: REJECT_SOURCE_TOOL_NAME,
              input: { reason: "teaser of the URL, not the article" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      },
    };
    const report = await writeResults(
      sidecar([sidecarTarget()]),
      [rejected],
      deps(r2),
    );
    expect(report.find((r) => r.id === "rd_a")?.status).toBe("failed");
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.status).toBe("failed");
    expect(m.error?.code).toBe("SourceRejectedError");
    expect(m.error?.message).toBe("teaser of the URL, not the article");
    expect(m.error?.retryable).toBe(true);
  });

});
