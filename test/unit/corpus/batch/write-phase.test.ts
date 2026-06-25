import { describe, expect, it, vi } from "vitest";
import { writeResults } from "../../../../scripts/corpus-lib/batch/write-phase";
import { PointerExistsError } from "../../../../scripts/lib/cf-clients";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { Sidecar, SidecarTarget } from "../../../../scripts/corpus-lib/batch/types";
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
  return { batchId: "msgbatch_1", model: "claude-opus-4-8", processingStatus: "ended", resultsUrl: "https://r", targets };
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
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
    },
  };
}

function errored(customId: string): BatchResult {
  return { custom_id: customId, result: { type: "errored", error: { type: "api_error", message: "boom" } } };
}

// In-memory R2 fake backed by a Map, recording the final state of each key.
function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const etags = new Map<string, number>();
  const etagOf = (key: string) => String(etags.get(key) ?? 0);
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getWithEtag: vi.fn(async (key: string) => (store.has(key) ? { body: store.get(key)!, etag: etagOf(key) } : null)),
    put: vi.fn(async (key: string, body: Uint8Array | string, opts?: { ifNoneMatch?: "*"; ifMatch?: string }) => {
      if (opts?.ifNoneMatch === "*" && store.has(key)) throw new PointerExistsError(key);
      if (opts?.ifMatch !== undefined && (!store.has(key) || opts.ifMatch !== etagOf(key))) throw new PointerExistsError(key);
      store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      etags.set(key, (etags.get(key) ?? 0) + 1);
    }),
    head: vi.fn(async (key: string) => store.has(key)),
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
    expect(m.usage?.anthropic_input_tokens).toBe(1000);
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

describe("writeResults — failure path", () => {
  it("writes a retryable failed manifest and NO by-url pointer when there is no prior ready snapshot", async () => {
    const r2 = fakeR2();
    await writeResults(sidecar([sidecarTarget()]), [errored("rd_a")], deps(r2, fakeVectorize()));
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("failed");
    expect(m.error?.retryable).toBe(true);
    expect(m.error?.stage).toBe("summarize");
    // Failed URLs must stay re-submittable: no by-url pointer.
    expect(r2.store.has(`index/by-url/${"a".repeat(64)}`)).toBe(false);
  });

  it("does not upsert a vector for a failed reading", async () => {
    const r2 = fakeR2();
    const vec = fakeVectorize();
    await writeResults(sidecar([sidecarTarget()]), [errored("rd_a")], deps(r2, vec));
    expect(vec.upserts).toHaveLength(0);
  });

  it("rolls forward to the preserved ready snapshot instead of nuking good data", async () => {
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
    const r2 = fakeR2();
    await writeResults(
      sidecar([sidecarTarget({ preserveReadyManifest: ready })]),
      [errored("rd_a")],
      deps(r2, fakeVectorize()),
    );
    const m: Manifest = ManifestSchema.parse(JSON.parse(r2.store.get("readings/2026/01/01T000000Z-rd_a/manifest.json")!));
    expect(m.status).toBe("ready");
    expect(m.title).toBe("Previously Good");
    expect(m.tldr).toBe("kept tldr");
    const index = JSON.parse(r2.store.get("index/list.json")!);
    expect(index.items.find((i: any) => i.id === "rd_a").status).toBe("ready");
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

describe("writeResults — externally-recovered guard (issue #66 resume race)", () => {
  it("does NOT overwrite a now-ready manifest with a failed batch result (online recovered it while the batch was down)", async () => {
    const target = sidecarTarget();
    const recovered = JSON.stringify(
      ManifestSchema.parse({
        ...sidecarManifestReady(target),
      }),
    );
    const r2 = fakeR2({ [`${target.keyPrefix}/manifest.json`]: recovered });
    const vectorize = fakeVectorize();

    const report = await writeResults(sidecar([target]), [errored("rd_a")], deps(r2, vectorize));

    // The recovered ready manifest is preserved (NOT overwritten to failed).
    expect(r2.store.get(`${target.keyPrefix}/manifest.json`)).toBe(recovered);
    expect(report).toEqual([{ id: "rd_a", status: "skipped", reason: expect.stringMatching(/already ready/) }]);
  });

  it("does NOT re-summarize / stomp a now-ready manifest on a success result either", async () => {
    const target = sidecarTarget();
    const recovered = JSON.stringify(ManifestSchema.parse({ ...sidecarManifestReady(target) }));
    const r2 = fakeR2({ [`${target.keyPrefix}/manifest.json`]: recovered });
    const vectorize = fakeVectorize();

    const report = await writeResults(sidecar([target]), [succeeded("rd_a")], deps(r2, vectorize));

    expect(r2.store.get(`${target.keyPrefix}/manifest.json`)).toBe(recovered);
    expect(report).toEqual([{ id: "rd_a", status: "skipped", reason: expect.stringMatching(/already ready/) }]);
  });

  it("repairs a stranded eager-pending list row to ready when the manifest is already ready (partial-write resume)", async () => {
    // Resume after a partial writeResults: the ready manifest was written but the
    // index/list.json merge never ran, so the list still carries the eager pending
    // row. The guard must publish the ready list row (not skip it) so list/search
    // doesn't show the reading as pending forever.
    const target = sidecarTarget();
    const ready = ManifestSchema.parse({ ...sidecarManifestReady(target) });
    const r2 = fakeR2({
      [`${target.keyPrefix}/manifest.json`]: JSON.stringify(ready),
      "index/list.json": JSON.stringify({
        version: 1,
        items: [
          { id: target.id, key_prefix: target.keyPrefix, url: target.url, status: "pending", created_at: target.createdAt, updated_at: target.createdAt },
        ],
      }),
    });
    const vectorize = fakeVectorize();

    await writeResults(sidecar([target]), [], deps(r2, vectorize));

    // Manifest still ready, and the list row was repaired to ready.
    expect(ManifestSchema.parse(JSON.parse(r2.store.get(`${target.keyPrefix}/manifest.json`)!)).status).toBe("ready");
    const list = JSON.parse(r2.store.get("index/list.json")!) as { items: Array<{ id: string; status: string }> };
    expect(list.items.find((i) => i.id === target.id)?.status).toBe("ready");
  });

  it("does NOT downgrade a now-ready manifest for a MISSING batch result", async () => {
    const target = sidecarTarget();
    const recovered = JSON.stringify(ManifestSchema.parse({ ...sidecarManifestReady(target) }));
    const r2 = fakeR2({ [`${target.keyPrefix}/manifest.json`]: recovered });
    const vectorize = fakeVectorize();

    const report = await writeResults(sidecar([target]), [], deps(r2, vectorize));

    expect(r2.store.get(`${target.keyPrefix}/manifest.json`)).toBe(recovered);
    expect(report).toEqual([{ id: "rd_a", status: "skipped", reason: expect.stringMatching(/already ready/) }]);
  });
});

function sidecarManifestReady(target: SidecarTarget): Manifest {
  return {
    id: target.id,
    url: target.url,
    url_hash: target.urlHash,
    source_type: "url",
    status: "ready",
    title: "Online Recovered",
    tldr: "recovered by the online path",
    tags: [],
    keywords: [],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: "recovered",
    content_type: target.contentType,
    content_status: "captured",
    content_bytes: target.contentBytes,
    content_sha256: target.contentSha256,
    created_at: target.createdAt,
    updated_at: "2026-06-19T00:00:00.000Z",
  } as Manifest;
}
