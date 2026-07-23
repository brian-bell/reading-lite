import { describe, expect, it, vi } from "vitest";
import {
  writeOpenAIResults,
  writeResults,
} from "../../../../scripts/corpus-lib/batch/write-phase";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
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

function fakeVectorize() {
  const upserts: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
  return {
    upserts,
    upsert: vi.fn(async (vs: any[]) => {
      for (const v of vs) upserts.push(v);
    }),
    query: vi.fn(async () => []),
  };
}

const embedMany = (vecCount = 1536) =>
  vi.fn(async (inputs: string[]) => ({
    embeddings: inputs.map(() => Array.from({ length: vecCount }, () => 0.01)),
    tokensByInput: inputs.map(() => 8),
  }));

function deps(r2: ReturnType<typeof fakeR2>, vectorize: ReturnType<typeof fakeVectorize>, embed = embedMany()) {
  return { r2: r2 as any, vectorize: vectorize as any, embedMany: embed, now: () => NOW };
}

describe("writeResults — success path", () => {
  it("writes a ready manifest with the resolved reading fields", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, vec));
    const raw = r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!;
    const m: Manifest = ManifestSchema.parse(JSON.parse(raw));
    expect(m.status).toBe("ready");
    expect(m.title).toBe("Resolved Title");
    expect(m.tldr).toBe("A crisp summary.");
    expect(m.tags).toEqual(["ai", "infra"]);
    expect(m.content_type).toBe("text/html");
    expect(m.content_bytes).toBe(42);
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

  it("writes the by-url and by-id pointers on success", async () => {
    const r2 = fakeR2();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, fakeVectorize()));
    expect(JSON.parse(r2.store.get(`index/by-url/${"a".repeat(64)}`)!)).toEqual({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    expect(JSON.parse(r2.store.get("index/by-id/rd_a")!)).toEqual({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
  });

  it("embeds the tldr and upserts the persistent vector with metadata", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
    const embed = embedMany();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, vec, embed));
    expect(embed).toHaveBeenCalledWith(["A crisp summary."]);
    expect(vec.upserts).toHaveLength(1);
    expect(vec.upserts[0]!.id).toBe("rd_a");
    expect(vec.upserts[0]!.values).toHaveLength(1536);
    expect(vec.upserts[0]!.metadata).toMatchObject({ url: "https://example.com/a", title: "Resolved Title", tags: ["ai", "infra"] });
  });

  it("adds the reading to index/list.json, preserving unrelated items", async () => {
    const seed = {
      "index/list.json": JSON.stringify({ version: 1, items: [{ id: "rd_other", key_prefix: "kp", url: "https://o", status: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }] }),
    };
    const r2 = fakeR2(seed);
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, fakeVectorize()));
    const index = JSON.parse(r2.store.get("index/list.json")!);
    const ids = index.items.map((i: any) => i.id).sort();
    expect(ids).toEqual(["rd_a", "rd_other"]);
    const item = index.items.find((i: any) => i.id === "rd_a");
    expect(item.status).toBe("ready");
    expect(item.title).toBe("Resolved Title");
  });
});

describe("writeOpenAIResults — success path", () => {
  it("matches JSONL by custom_id and persists provider-normalized OpenAI usage", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
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

    await writeOpenAIResults(sc, jsonl, deps(r2, vec));

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
    const a = sidecarTarget({ releaseByUrlOnFailure: true });
    const b = sidecarTarget({
      customId: "rd_b",
      id: "rd_b",
      keyPrefix: "readings/kp-b",
      url: "https://example.com/b",
      urlHash: "c".repeat(64),
    });
    const pointerKey = `index/by-url/${a.urlHash}`;
    const r2 = fakeR2({
      [pointerKey]: JSON.stringify({
        id: a.id,
        key_prefix: a.keyPrefix,
      }),
    });
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
      deps(r2, fakeVectorize()),
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
    expect(r2.store.has("index/by-id/rd_a")).toBe(true);
    expect(r2.store.has(pointerKey)).toBe(false);
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
        deps(r2, fakeVectorize()),
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
      deps(r2, fakeVectorize()),
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
      deps(r2, fakeVectorize()),
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
      deps(r2, fakeVectorize()),
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
  it("does not create a by-url pointer for a non-eager failed batch result", async () => {
    const r2 = fakeR2();
    await writeResults(sidecar([sidecarTarget()]), [errored("rd_a")], deps(r2, fakeVectorize()));
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(m.error?.retryable).toBe(true);
    expect(m.error?.stage).toBe("summarize");
    // Failed URLs must stay re-submittable: no by-url pointer.
    expect(r2.store.has(`index/by-url/${"a".repeat(64)}`)).toBe(false);
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it("releases its eager by-url claim when a batch result fails", async () => {
    const existingPointer = JSON.stringify({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    const r2 = fakeR2({ [`index/by-url/${"a".repeat(64)}`]: existingPointer });

    const report = await writeResults(
      sidecar([sidecarTarget({ releaseByUrlOnFailure: true })]),
      [errored("rd_a")],
      deps(r2, fakeVectorize()),
    );

    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(JSON.parse(r2.store.get("index/by-id/rd_a")!)).toEqual({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    expect(r2.store.has(`index/by-url/${"a".repeat(64)}`)).toBe(false);
    expect(report).toEqual([{ id: "rd_a", status: "failed", reason: "boom" }]);
  });

  it("keeps an existing by-url owner on failed recover-style batch targets", async () => {
    const pointerKey = `index/by-url/${"a".repeat(64)}`;
    const existingPointer = JSON.stringify({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    const r2 = fakeR2({ [pointerKey]: existingPointer });

    await writeResults(sidecar([sidecarTarget()]), [errored("rd_a")], deps(r2, fakeVectorize()));

    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(r2.store.get(pointerKey)).toBe(existingPointer);
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "same id but different key_prefix",
      pointer: { id: "rd_a", key_prefix: "readings/2026/01/02T000000Z-rd_a" },
    },
    {
      name: "different id but same key_prefix",
      pointer: { id: "rd_b", key_prefix: "readings/2026/01/01T000000Z-rd_a" },
    },
    {
      name: "different id and different key_prefix",
      pointer: { id: "rd_b", key_prefix: "readings/2026/01/02T000000Z-rd_b" },
    },
  ])("does not release a by-url pointer that no longer points exactly at the failed batch target: $name", async ({ pointer }) => {
    const pointerKey = `index/by-url/${"a".repeat(64)}`;
    const existingPointer = JSON.stringify(pointer);
    const r2 = fakeR2({ [pointerKey]: existingPointer });

    const report = await writeResults(
      sidecar([sidecarTarget({ releaseByUrlOnFailure: true })]),
      [errored("rd_a")],
      deps(r2, fakeVectorize()),
    );

    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(JSON.parse(r2.store.get("index/by-id/rd_a")!)).toEqual({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    expect(r2.store.get(pointerKey)).toBe(existingPointer);
    expect(r2.delete).not.toHaveBeenCalled();
    const index = JSON.parse(r2.store.get("index/list.json")!);
    expect(index.items.find((i: any) => i.id === "rd_a").status).toBe("failed");
    expect(report).toEqual([{ id: "rd_a", status: "failed", reason: "boom" }]);
  });

  it.each([
    { name: "malformed JSON", rawPointer: "{not json" },
    { name: "missing key_prefix", rawPointer: JSON.stringify({ id: "rd_a" }) },
    { name: "missing id", rawPointer: JSON.stringify({ key_prefix: "readings/2026/01/01T000000Z-rd_a" }) },
    {
      name: "extra fields",
      rawPointer: JSON.stringify({
        id: "rd_a",
        key_prefix: "readings/2026/01/01T000000Z-rd_a",
        stale: true,
      }),
    },
  ])("does not release a damaged by-url pointer when a batch result fails: $name", async ({ rawPointer }) => {
    const pointerKey = `index/by-url/${"a".repeat(64)}`;
    const r2 = fakeR2({ [pointerKey]: rawPointer });

    await writeResults(
      sidecar([sidecarTarget({ releaseByUrlOnFailure: true })]),
      [errored("rd_a")],
      deps(r2, fakeVectorize()),
    );

    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(JSON.parse(r2.store.get("index/by-id/rd_a")!)).toEqual({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    const index = JSON.parse(r2.store.get("index/list.json")!);
    expect(index.items.find((i: any) => i.id === "rd_a").status).toBe("failed");
    expect(r2.store.get(pointerKey)).toBe(rawPointer);
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it("fails loudly when the by-url ownership read fails during release", async () => {
    const pointerKey = `index/by-url/${"a".repeat(64)}`;
    const r2 = fakeR2();
    r2.get.mockImplementation(async (key: string) => {
      if (key === pointerKey) throw new Error("R2 read unavailable");
      return r2.store.get(key) ?? null;
    });

    await expect(
      writeResults(
        sidecar([sidecarTarget({ releaseByUrlOnFailure: true })]),
        [errored("rd_a")],
        deps(r2, fakeVectorize()),
      ),
    ).rejects.toThrow("R2 read unavailable");
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it("does not upsert a vector for a failed reading", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
    await writeResults(sidecar([sidecarTarget()]), [errored("rd_a")], deps(r2, vec));
    expect(vec.upserts).toHaveLength(0);
  });

  it("keeps by-url ownership when a failed batch result rolls forward to a preserved ready manifest", async () => {
    const ready: Manifest = {
      id: "rd_a",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "ready",
      title: "Previously Good",
      tldr: "kept tldr",
      tags: ["keep"],
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 42,
      content_sha256: "b".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    const pointerKey = `index/by-url/${"a".repeat(64)}`;
    const existingPointer = JSON.stringify({
      id: "rd_a",
      key_prefix: "readings/2026/01/01T000000Z-rd_a",
    });
    const r2 = fakeR2({ [pointerKey]: existingPointer });
    await writeResults(
      sidecar([sidecarTarget({ preserveReadyManifest: ready, releaseByUrlOnFailure: true })]),
      [errored("rd_a")],
      deps(r2, fakeVectorize()),
    );
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("ready");
    expect(m.title).toBe("Previously Good");
    expect(m.tldr).toBe("kept tldr");
    const index = JSON.parse(r2.store.get("index/list.json")!);
    expect(index.items.find((i: any) => i.id === "rd_a").status).toBe("ready");
    expect(r2.store.get(pointerKey)).toBe(existingPointer);
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it("rolls an OpenAI error forward without touching vectors or a newer owner", async () => {
    const ready: Manifest = {
      id: "rd_a",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "ready",
      title: "Previously Good",
      tldr: "kept tldr",
      tags: ["keep"],
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 42,
      content_sha256: "b".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    const pointerKey = `index/by-url/${"a".repeat(64)}`;
    const newerOwner = JSON.stringify({
      id: "rd_newer",
      key_prefix: "readings/kp-newer",
    });
    const r2 = fakeR2({ [pointerKey]: newerOwner });
    const vectorize = fakeVectorize();

    const report = await writeOpenAIResults(
      openAISidecar([
        sidecarTarget({
          preserveReadyManifest: ready,
          releaseByUrlOnFailure: true,
        }),
      ]),
      {
        errorJsonl:
          JSON.stringify({
            custom_id: "rd_a",
            response: null,
            error: { message: "provider failed" },
          }) + "\n",
        batchStatus: "completed",
      },
      deps(r2, vectorize),
    );

    const final = ManifestSchema.parse(
      JSON.parse(
        r2.store.get(
          "readings/2026/01/01T000000Z-rd_a/manifest.json",
        )!,
      ),
    );
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("kept tldr");
    expect(r2.store.get(pointerKey)).toBe(newerOwner);
    expect(r2.delete).not.toHaveBeenCalled();
    expect(vectorize.upsert).not.toHaveBeenCalled();
    expect(
      JSON.parse(r2.store.get("index/list.json")!).items[0].status,
    ).toBe("ready");
    expect(report).toEqual([
      { id: "rd_a", status: "failed", reason: "provider failed" },
    ]);
  });
});

describe("writeResults — robustness", () => {
  it("reports a result whose custom_id has no sidecar target without throwing", async () => {
    const r2 = fakeR2();
    const report = await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_ghost")], deps(r2, fakeVectorize()));
    expect(report.find((r) => r.id === "rd_ghost")?.status).toBe("skipped");
  });

  it("marks a sidecar target with no batch result as failed (retryable), not dropped", async () => {
    const r2 = fakeR2();
    const report = await writeResults(sidecar([sidecarTarget()]), [], deps(r2, fakeVectorize()));
    expect(report.find((r) => r.id === "rd_a")?.status).toBe("failed");
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(m.error?.code).toBe("BatchResultMissing");
    expect(m.error?.retryable).toBe(true);
  });

  it("marks a success whose tool output fails validation as failed (retryable)", async () => {
    const r2 = fakeR2();
    const bad = succeeded("rd_a", { ...validReading, novelty_verdict: "nope" });
    const report = await writeResults(sidecar([sidecarTarget()]), [bad], deps(r2, fakeVectorize()));
    expect(report.find((r) => r.id === "rd_a")?.status).toBe("failed");
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(m.error?.retryable).toBe(true);
  });

  it("writes index/list.json exactly once regardless of result count", async () => {
    const r2 = fakeR2();
    await writeResults(
      sidecar([sidecarTarget(), sidecarTarget({ customId: "rd_b", id: "rd_b", urlHash: "c".repeat(64), keyPrefix: "readings/kp-b", url: "https://example.com/b" })]),
      [succeeded("rd_a"), succeeded("rd_b")],
      deps(r2, fakeVectorize()),
    );
    const listWrites = r2.put.mock.calls.filter((c) => c[0] === "index/list.json");
    expect(listWrites).toHaveLength(1);
  });
});
