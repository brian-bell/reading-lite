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
const TENANT = "usr_11111111-1111-4111-8111-111111111111";

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
  // `order` records deletes and upserts in sequence, because retiring the
  // legacy bare id has to happen BEFORE the composed one is written.
  const order: string[] = [];
  const deleted: string[] = [];
  return {
    upserts,
    deleted,
    order,
    upsert: vi.fn(async (vs: any[]) => {
      order.push(`upsert:${vs.map((v) => v.id).join(",")}`);
      for (const v of vs) upserts.push(v);
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      order.push(`delete:${ids.join(",")}`);
      deleted.push(...ids);
    }),
    query: vi.fn(async () => []),
  };
}

const embedMany = (vecCount = 1536) =>
  vi.fn(async (inputs: string[]) => ({
    embeddings: inputs.map(() => Array.from({ length: vecCount }, () => 0.01)),
    tokensByInput: inputs.map(() => 8),
  }));

// Records the ledger writes and, in the suffix, how many upserts had already
// happened when each was made (issue #195 S3). This offline writer checks no
// `users.status`, so without a row written FIRST an operator running it against
// a tenant mid-wipe leaves a vector nothing can address.
function fakeLedger(vectorize: ReturnType<typeof fakeVectorize>) {
  const events: string[] = [];
  return {
    events,
    ledger: {
      markLive: async (ids: readonly string[]) => {
        for (const id of ids) events.push(`live:${id}:${vectorize.upserts.length}`);
      },
      markDeleteSubmitted: async () => {},
    },
  };
}

function deps(
  r2: ReturnType<typeof fakeR2>,
  vectorize: ReturnType<typeof fakeVectorize>,
  embed = embedMany(),
  ledger?: ReturnType<typeof fakeLedger>["ledger"],
) {
  return {
    r2: r2 as any,
    vectorize: vectorize as any,
    embedMany: embed,
    now: () => NOW,
    ...(ledger ? { ledger } : {}),
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
    await writeResults(sidecar([attempted]), [succeeded("rd_a")], deps(r2, fakeVectorize()));
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
      deps(r2, fakeVectorize()),
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
      deps(r2, fakeVectorize()),
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
      deps(r2, fakeVectorize()),
    );
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.status).toBe("failed");
    expect(m.source_date).toBe("2024-03-15");
  });

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
      deps(r2, fakeVectorize()),
    );
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect(m.connections).toEqual([{ id: "rd_cited", reason: "same topic" }]);
    expect(m.connections_neighbourhood_ids).toEqual(["rd_cited", "rd_rejected"]);
  });

  it("omits the ingest baseline when a pre-upgrade sidecar has no neighbourhood IDs", async () => {
    const r2 = fakeR2();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, fakeVectorize()));
    const m: Manifest = ManifestSchema.parse(
      JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!),
    );
    expect("connections_neighbourhood_ids" in m).toBe(false);
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

  // `deps()` supplies no ledger unless a test passes one, so every success case
  // here also proves the no-ledger default writes vectors — which is what
  // `--tenant global` wants: the pre-tenant corpus has no tenant id to key
  // ledger rows by, and no account wipe addresses it, so the default is the
  // no-op rather than a throw.
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

  // A pre-existing corpus bug, found while reviewing issue #195 S3. Every other
  // vector writer composes the ADR 0002 tenant-scoped id, but
  // `makeVectorizeClient.upsert` only attaches `namespace`, so this pipeline
  // wrote tenant vectors under the BARE reading id. Inert until the ledger
  // arrived; with it, the wipe composes `{tenantId}:{readingId}` for both the
  // delete and the confirmation, so a bare-id vector would be missed by the
  // delete AND read as absent by the confirmation — clearing its ledger row and
  // declaring gone a vector that is still live.
  it("upserts the tenant-scoped vector id and its audit stamp under a namespace", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], {
      ...deps(r2, vec),
      vectorNamespace: TENANT,
    });
    expect(vec.upserts[0]!.id).toBe(`${TENANT}:rd_a`);
    // The stamp preserves tenant ownership evidence alongside the scoped ID.
    expect(vec.upserts[0]!.metadata).toMatchObject({ tenant_id: TENANT });
  });

  it("never deletes the bare id, because that id may be a retained legacy vector", async () => {
    // Composing the id writes a NEW vector rather than replacing the old one,
    // so a tenant holding bare-id vectors ends up with two for one reading and
    // it turns up twice in its own neighbourhood. Deleting the bare id first is
    // the obvious fix and it is wrong HERE: Vectorize ids are index-unique and
    // `deleteByIds` is namespace-blind, so for a reading this pipeline has
    // never touched, `delete("rd_a")` removes the LEGACY pre-cutover vector —
    // explicitly retained as the TENANT_DATA_PLANE rollback set pending a
    // signed-off deletion, and something tenant-scoped operations "are not
    // meant to reach" (CLAUDE.md). A routine `corpus ingest --tenant … --execute`
    // would have eroded it silently. Both halves of the bare-id problem stay
    // with slice S5.
    const r2 = fakeR2();
    const vec = fakeVectorize();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], {
      ...deps(r2, vec),
      vectorNamespace: TENANT,
    });
    expect(vec.deleted).toEqual([]);
    expect(vec.order).toEqual([`upsert:${TENANT}:rd_a`]);
  });

  it("keeps the bare id with no namespace, so the pre-tenant layout is unchanged", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, vec));
    expect(vec.upserts[0]!.id).toBe("rd_a");
    expect(vec.upserts[0]!.metadata).not.toHaveProperty("tenant_id");
  });

  it("ledgers the BARE reading id BEFORE upserting its composed vector", async () => {
    // The ledger stores reading ids and the wipe re-composes through
    // `tenantVectorId`, so there is one spelling of that rule and no stored
    // copy of its output to drift.
    const r2 = fakeR2();
    const vec = fakeVectorize();
    const { ledger, events } = fakeLedger(vec);
    await writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], {
      ...deps(r2, vec, embedMany(), ledger),
      vectorNamespace: TENANT,
    });
    // `:0` — no upsert had landed when the row was written. The reverse order
    // would leave a vector unaddressable if the process died between them.
    expect(events).toEqual(["live:rd_a:0"]);
    expect(vec.upserts).toHaveLength(1);
    expect(vec.upserts[0]!.id).toBe(`${TENANT}:rd_a`);
  });

  it("does not upsert vectors it could not ledger", async () => {
    // Fail closed, like the publisher: a vector with no row is the stranding
    // the ledger exists to make impossible, and the batch pass is resumable.
    const r2 = fakeR2();
    const vec = fakeVectorize();
    const ledger = {
      markLive: async () => {
        throw new Error("D1 unavailable");
      },
      markDeleteSubmitted: async () => {},
    };
    await expect(
      writeResults(sidecar([sidecarTarget()]), [succeeded("rd_a")], deps(r2, vec, embedMany(), ledger)),
    ).rejects.toThrow(/D1 unavailable/);
    expect(vec.upserts).toHaveLength(0);
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
  it("finishes the sidecar attempt with the manifest failure", async () => {
    const r2 = fakeR2();
    const attempted = sidecarTarget({
      attemptId: "at_batch_failed",
      attemptStartedAt: "2026-06-18T11:55:00.000Z",
      trigger: "import",
    });
    await writeResults(sidecar([attempted]), [errored("rd_a")], deps(r2, fakeVectorize()));
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
      sidecar([sidecarTarget({
        preserveReadyManifest: ready,
        releaseByUrlOnFailure: true,
        attemptId: "at_ready_retry",
        attemptStartedAt: "2026-06-18T11:55:00.000Z",
        trigger: "reprocess",
      })]),
      [errored("rd_a")],
      deps(r2, fakeVectorize()),
    );
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("ready");
    expect(m.title).toBe("Previously Good");
    expect(m.tldr).toBe("kept tldr");
    expect(m.last_attempt).toMatchObject({
      id: "at_ready_retry",
      trigger: "reprocess",
      status: "failed",
      stage: "summarize",
      finished_at: NOW,
    });
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
      deps(r2, fakeVectorize()),
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
