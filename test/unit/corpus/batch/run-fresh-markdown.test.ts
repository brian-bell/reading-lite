import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  runFreshMarkdownBatch,
  type FreshMarkdownRunDeps,
} from "../../../../scripts/corpus-lib/batch/run-fresh-markdown";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { Sidecar } from "../../../../scripts/corpus-lib/batch/types";
import { R2ConditionalPutError } from "../../../../scripts/lib/cf-clients";
import type { ListIndexItem } from "../../../../src/schemas/api";

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
  keywords: ["k"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "body",
};

// In-memory R2 + recording vectorize + scripted batch lifecycle, mirroring
// run.test.ts's harness but for the fresh-markdown front-end.
function harness(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const r2 = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, b: Uint8Array | string, opts?: { ifNotExists?: boolean }) => {
      if (opts?.ifNotExists && store.has(k)) throw new R2ConditionalPutError(k);
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    }),
    head: vi.fn(async (k: string) => store.has(k)),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    listKeys: vi.fn(async () => [...store.keys()]),
  };
  const vectorize = { upsert: vi.fn(async () => {}), query: vi.fn(async () => []) };
  let sidecar: Sidecar | null = null;
  const batch = {
    create: vi.fn(async () => ({ id: "msgbatch_fresh", processing_status: "in_progress", results_url: null })),
    get: vi.fn(async () => ({ id: "msgbatch_fresh", processing_status: "ended", results_url: "https://results" })),
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
  let n = 0;
  const deps: FreshMarkdownRunDeps = {
    r2: r2 as any,
    vectorize: vectorize as any,
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
    saveSidecar: vi.fn(async (s: Sidecar) => {
      sidecar = s;
    }),
    clearSidecar: vi.fn(async () => {
      sidecar = null;
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, vectorize, batch, deps, getSidecar: () => sidecar, setSidecar: (s: Sidecar | null) => (sidecar = s) };
}

describe("runFreshMarkdownBatch — fresh run", () => {
  it("ingests a markdown directory into ready markdown readings via the batch API", async () => {
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");
    const b = article("beta", "https://example.com/beta");
    const result = await runFreshMarkdownBatch([a, b], h.deps);

    expect(result.resumed).toBe(false);
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(2);

    // never fetched a URL (batch summarize only)
    expect(h.deps.extract).not.toHaveBeenCalled();

    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    const m = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(m.status).toBe("ready");
    expect(m.source_type).toBe("markdown");
    expect(m.content_type).toBe("text/markdown; charset=utf-8");
    expect(m.content_status).toBe("captured");
    expect(m.content_bytes).toBe(a.bytes);
    expect(m.content_sha256).toBe(createHash("sha256").update(a.markdown, "utf8").digest("hex"));
    // openai_embedding_tokens = query (similar) + tldr embed
    expect(m.usage!.openai_embedding_tokens).toBe(8);

    // raw.md + extracted.md persisted from the markdown in hand
    expect(h.store.get(`${kp}/raw.md`)).toBe(a.markdown);
    expect(h.store.get(`${kp}/extracted.md`)).toBe(a.markdown);

    // by-url + by-id pointers and a list.json entry
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(true);
    expect(h.store.has(`index/by-id/rd_FRESH0`)).toBe(true);
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.map((i: any) => i.id).sort()).toEqual(["rd_FRESH0", "rd_FRESH1"]);

    // a vector was upserted for each
    expect(h.vectorize.upsert).toHaveBeenCalled();
  });

  it("keeps the eager by-url claim for a fresh ingest whose batch result fails", async () => {
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");
    // the batch errors this item rather than emitting a reading (deps.batch and
    // h.batch are the same object, so this override is seen by the pipeline)
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    const result = await runFreshMarkdownBatch([a], h.deps);
    expect(result.report.filter((r) => r.status === "failed")).toHaveLength(1);

    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    const m = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(m.status).toBe("failed");
    // by-id MUST exist so detail/diagnostics/reprocess resolve (no dangling row)
    expect(h.store.has("index/by-id/rd_FRESH0")).toBe(true);
    // Failure-path claim release is a later slice; the eager claim remains and
    // points at the failed manifest so reruns can re-ingest the same reading.
    expect(h.store.get(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(
      JSON.stringify({ id: "rd_FRESH0", key_prefix: kp }),
    );
    // the list still carries the failed reading
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.map((i: any) => i.id)).toContain("rd_FRESH0");
  });

  it("saves a sidecar before creating the batch (crash-window safety)", async () => {
    const h = harness();
    const calls: string[] = [];
    const origSave = h.deps.saveSidecar;
    h.deps.saveSidecar = vi.fn(async (s: Sidecar) => {
      calls.push(s.batchId === "" ? "save:pending" : "save:final");
      await origSave(s);
    });
    const origCreate = h.batch.create;
    h.batch.create = vi.fn(async (...args: any[]) => {
      calls.push("create");
      return (origCreate as any)(...args);
    });
    await runFreshMarkdownBatch([article("alpha", "https://example.com/alpha")], h.deps);
    expect(calls.indexOf("save:pending")).toBeLessThan(calls.indexOf("create"));
  });

  it("eagerly claims fresh URLs as pending before creating the batch", async () => {
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");
    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    const pointer = JSON.stringify({ id: "rd_FRESH0", key_prefix: kp });
    h.batch.create = vi.fn(async () => {
      const m = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
      expect(m.status).toBe("pending");
      expect(m.source_type).toBe("markdown");
      expect(m.url).toBe(a.sourceUrl);
      expect(h.store.get("index/by-id/rd_FRESH0")).toBe(pointer);
      expect(h.store.get(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(pointer);
      const index = JSON.parse(h.store.get("index/list.json")!);
      expect(index.items).toEqual([
        expect.objectContaining({ id: "rd_FRESH0", key_prefix: kp, status: "pending" }),
      ]);
      return { id: "msgbatch_fresh", processing_status: "in_progress", results_url: null };
    });

    await runFreshMarkdownBatch([a], h.deps);
  });
});

describe("runFreshMarkdownBatch — idempotency", () => {
  it("skips a ready owner and never re-summarizes it", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const ready: Manifest = ManifestSchema.parse({
      id: "rd_OWNER",
      url: a.sourceUrl!,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "ready",
      title: "Owner",
      tldr: "x",
      tags: [],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "y",
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "a".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    const h = harness({
      [`index/by-url/${hex(a.sourceUrl!)}`]: JSON.stringify({ id: "rd_OWNER", key_prefix: "readings/kp-owner" }),
      "readings/kp-owner/manifest.json": JSON.stringify(ready),
    });
    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(result.dispositions.filter((d) => d.kind === "skip-ready")).toHaveLength(1);
  });

  it("skips a fresh target at submit time if the by-url slot became owned", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const other: Manifest = ManifestSchema.parse({
      id: "rd_OTHER",
      url: a.sourceUrl,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "ready",
      title: "Other",
      tldr: "x",
      tags: [],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "y",
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "a".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    const byUrlKey = `index/by-url/${hex(a.sourceUrl!)}`;
    const otherPointer = JSON.stringify({ id: "rd_OTHER", key_prefix: "readings/kp-other" });
    const h = harness();
    let byUrlReads = 0;
    h.r2.get.mockImplementation(async (k: string) => {
      if (k === byUrlKey) return byUrlReads++ === 0 ? null : otherPointer;
      if (k === "readings/kp-other/manifest.json") return JSON.stringify(other);
      return h.store.get(k) ?? null;
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(result.dispositions.filter((d) => d.kind === "ingest-new")).toHaveLength(1);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/manifest.json")).toBe(false);
  });

  it("skips a damaged by-url object at submit time rather than repairing without CAS", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness({
      [`index/by-url/${hex(a.sourceUrl!)}`]: "not json",
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(result.dispositions.filter((d) => d.kind === "ingest-new")).toHaveLength(1);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.get(`index/by-url/${hex(a.sourceUrl!)}`)).toBe("not json");
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/manifest.json")).toBe(false);
  });

  it("does not attempt submit-time repair while a damaged by-url object still exists", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness({
      [`index/by-url/${hex(a.sourceUrl!)}`]: "not json",
    });
    const byUrlKey = `index/by-url/${hex(a.sourceUrl!)}`;

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(result.dispositions.filter((d) => d.kind === "ingest-new")).toHaveLength(1);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.get(byUrlKey)).toBe("not json");
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/manifest.json")).toBe(false);
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/raw.md")).toBe(false);
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/extracted.md")).toBe(false);
  });

  it("skips a fresh missing-manifest by-url owner at submit time as initializing", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness();
    const byUrlKey = `index/by-url/${hex(a.sourceUrl!)}`;
    const initializingPointer = JSON.stringify({
      id: "rd_INIT",
      key_prefix: "readings/2026/06/22T115959Z-rd_INIT",
    });
    let byUrlReads = 0;
    h.r2.get.mockImplementation(async (k: string) => {
      if (k === byUrlKey) {
        if (byUrlReads++ === 0) return null;
        h.store.set(k, initializingPointer);
        return initializingPointer;
      }
      return h.store.get(k) ?? null;
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(result.dispositions.filter((d) => d.kind === "ingest-new")).toHaveLength(1);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.get(byUrlKey)).toBe(initializingPointer);
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/manifest.json")).toBe(false);
  });

  it("cleans up pending objects when the submit-time by-url claim loses a race", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness();
    const byUrlKey = `index/by-url/${hex(a.sourceUrl!)}`;
    const otherPointer = JSON.stringify({
      id: "rd_OTHER",
      key_prefix: "readings/2026/06/22T120000Z-rd_OTHER",
    });
    h.r2.put.mockImplementation(async (k: string, b: Uint8Array | string, opts?: { ifNotExists?: boolean }) => {
      if (k === byUrlKey && opts?.ifNotExists) {
        h.store.set(k, otherPointer);
        throw new R2ConditionalPutError(k);
      }
      h.store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.get(byUrlKey)).toBe(otherPointer);
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH0/manifest.json")).toBe(false);
    expect(h.store.has("index/by-id/rd_FRESH0")).toBe(false);
  });

  it("restores a failed owner when a submit-time by-url claim race is lost", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const kp = "readings/2025/12/01T000000Z-rd_OWNER";
    const failed: Manifest = ManifestSchema.parse({
      id: "rd_OWNER",
      url: a.sourceUrl,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "failed",
      error: { code: "X", message: "prior failure" },
      content_type: "text/markdown; charset=utf-8",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "a".repeat(64),
      created_at: "2025-12-01T00:00:00.000Z",
      updated_at: "2025-12-02T00:00:00.000Z",
    });
    const byIdPointer = JSON.stringify({ id: "rd_OWNER", key_prefix: kp });
    const byUrlKey = `index/by-url/${hex(a.sourceUrl!)}`;
    const otherPointer = JSON.stringify({ id: "rd_OTHER", key_prefix: "readings/kp-other" });
    const h = harness({
      [`${kp}/manifest.json`]: JSON.stringify(failed),
      "index/by-id/rd_OWNER": byIdPointer,
      "index/list.json": JSON.stringify({
        version: 1,
        items: [
          {
            id: "rd_OWNER",
            key_prefix: kp,
            url: a.sourceUrl,
            status: "failed",
            created_at: failed.created_at,
            updated_at: failed.updated_at,
          },
        ],
      }),
    });
    h.r2.put.mockImplementation(async (k: string, b: Uint8Array | string, opts?: { ifNotExists?: boolean }) => {
      if (k === byUrlKey && opts?.ifNotExists) {
        h.store.set(k, otherPointer);
        throw new R2ConditionalPutError(k);
      }
      h.store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.get(byUrlKey)).toBe(otherPointer);
    expect(h.store.get("index/by-id/rd_OWNER")).toBe(byIdPointer);
    expect(ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!)).status).toBe("failed");
  });

  it("rolls back a new eager claim if the immediate pending sidecar save fails", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness();
    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    h.deps.saveSidecar = vi.fn(async () => {
      throw new Error("sidecar write failed");
    });

    await expect(runFreshMarkdownBatch([a], h.deps)).rejects.toThrow(/sidecar write failed/);

    expect(h.deps.saveSidecar).toHaveBeenCalled();
    expect(h.deps.clearSidecar).not.toHaveBeenCalled();
    expect(h.getSidecar()).toBeNull();
    expect(h.store.has(`${kp}/manifest.json`)).toBe(false);
    expect(h.store.has("index/by-id/rd_FRESH0")).toBe(false);
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(false);
    expect(h.store.has("index/list.json")).toBe(false);
  });

  it("does not publish an eager claim if artifact writing fails", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness();
    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    h.r2.put.mockImplementation(async (k: string, b: Uint8Array | string, opts?: { ifNotExists?: boolean }) => {
      if (opts?.ifNotExists && h.store.has(k)) throw new R2ConditionalPutError(k);
      if (k === `${kp}/raw.md`) throw new Error("raw write failed");
      h.store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    });

    await expect(runFreshMarkdownBatch([a], h.deps)).rejects.toThrow(/raw write failed/);

    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.deps.saveSidecar).toHaveBeenCalled();
    expect(h.deps.clearSidecar).not.toHaveBeenCalled();
    expect(h.getSidecar()?.claimRollbackPhase).toBe("pre_create");
    expect(h.store.has(`${kp}/manifest.json`)).toBe(false);
    expect(h.store.has("index/by-id/rd_FRESH0")).toBe(false);
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(false);
    expect(h.store.has("index/list.json")).toBe(false);
  });

  it("preserves claim rollback metadata on the create-window pending sidecar", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness();
    h.batch.create = vi.fn(async () => {
      throw new Error("create failed");
    });

    await expect(runFreshMarkdownBatch([a], h.deps)).rejects.toThrow(/create failed/);

    expect(h.deps.clearSidecar).not.toHaveBeenCalled();
    expect(h.getSidecar()?.batchId).toBe("");
    expect(h.getSidecar()?.claimRollbackPhase).toBe("create_window");
    expect(h.getSidecar()?.claimRollback?.objects.map((o) => o.key)).toEqual(
      expect.arrayContaining([
        "readings/2026/06/22T120000Z-rd_FRESH0/manifest.json",
        "index/by-id/rd_FRESH0",
        `index/by-url/${hex(a.sourceUrl!)}`,
        "index/list.json",
      ]),
    );
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(true);
  });

  it("preserves a conditional-race winner when another claimed target rolls back", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const b = article("beta", "https://example.com/beta");
    const h = harness();
    const alphaKp = "readings/2026/06/22T120000Z-rd_FRESH0";
    const betaByUrlKey = `index/by-url/${hex(b.sourceUrl!)}`;
    const betaWinner = JSON.stringify({ id: "rd_OTHER", key_prefix: "readings/kp-other" });
    h.r2.put.mockImplementation(async (k: string, body: Uint8Array | string, opts?: { ifNotExists?: boolean }) => {
      if (k === betaByUrlKey && opts?.ifNotExists) {
        h.store.set(k, betaWinner);
        throw new R2ConditionalPutError(k);
      }
      h.store.set(k, typeof body === "string" ? body : new TextDecoder().decode(body));
    });
    let failedSave = false;
    h.deps.saveSidecar = vi.fn(async (s: Sidecar) => {
      h.setSidecar(s);
      if (!failedSave && h.store.has("index/list.json")) {
        failedSave = true;
        const current = JSON.parse(h.store.get("index/list.json")!) as { items: any[] };
        current.items.push({
          id: "rd_OTHER",
          key_prefix: "readings/kp-other",
          url: b.sourceUrl,
          status: "ready",
          created_at: NOW,
          updated_at: NOW,
        });
        h.store.set("index/list.json", JSON.stringify(current));
        throw new Error("sidecar write failed");
      }
    });

    await expect(runFreshMarkdownBatch([a, b], h.deps)).rejects.toThrow(/sidecar write failed/);

    expect(h.deps.saveSidecar).toHaveBeenCalled();
    expect(h.deps.clearSidecar).toHaveBeenCalled();
    expect(h.getSidecar()).toBeNull();
    expect(h.store.has(`${alphaKp}/manifest.json`)).toBe(false);
    expect(h.store.has("index/by-id/rd_FRESH0")).toBe(false);
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(false);
    expect(h.store.get(betaByUrlKey)).toBe(betaWinner);
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items).toEqual([
      expect.objectContaining({ id: "rd_OTHER", key_prefix: "readings/kp-other" }),
    ]);
    expect(h.store.has("readings/2026/06/22T120000Z-rd_FRESH1/manifest.json")).toBe(false);
    expect(h.store.has("index/by-id/rd_FRESH1")).toBe(false);
  });

  it("rolls back eager claims if the claim helper fails before returning to the pipeline", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const h = harness();
    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    h.r2.put.mockImplementation(async (k: string, body: Uint8Array | string, opts?: { ifNotExists?: boolean }) => {
      if (opts?.ifNotExists && h.store.has(k)) throw new R2ConditionalPutError(k);
      if (k === "index/list.json") throw new Error("list write failed");
      h.store.set(k, typeof body === "string" ? body : new TextDecoder().decode(body));
    });

    await expect(runFreshMarkdownBatch([a], h.deps)).rejects.toThrow(/list write failed/);

    expect(h.deps.saveSidecar).toHaveBeenCalled();
    expect(h.deps.clearSidecar).not.toHaveBeenCalled();
    expect(h.getSidecar()?.claimRollbackPhase).toBe("pre_create");
    expect(h.store.has(`${kp}/manifest.json`)).toBe(false);
    expect(h.store.has("index/by-id/rd_FRESH0")).toBe(false);
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(false);
    expect(h.store.has("index/list.json")).toBe(false);
  });

  it("re-ingests a failed owner in place, flipping its manifest to ready at the same key_prefix", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const failed: Manifest = ManifestSchema.parse({
      id: "rd_OWNER",
      url: a.sourceUrl,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "failed",
      error: { code: "X", message: "prior failure" },
      content_type: "text/markdown; charset=utf-8",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "a".repeat(64),
      created_at: "2025-12-01T00:00:00.000Z",
      updated_at: "2025-12-02T00:00:00.000Z",
    });
    const h = harness({
      [`index/by-url/${hex(a.sourceUrl!)}`]: JSON.stringify({ id: "rd_OWNER", key_prefix: "readings/kp-owner" }),
      "readings/kp-owner/manifest.json": JSON.stringify(failed),
    });
    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(h.deps.newId).not.toHaveBeenCalled(); // reuse the claimed id
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(1);
    const m = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-owner/manifest.json")!));
    expect(m.id).toBe("rd_OWNER");
    expect(m.status).toBe("ready");
    expect(m.created_at).toBe("2025-12-01T00:00:00.000Z"); // preserved
    expect(m.content_status).toBe("captured");
    // by-url pointer is (re)written on success, still pointing at the same id
    expect(JSON.parse(h.store.get(`index/by-url/${hex(a.sourceUrl!)}`)!).id).toBe("rd_OWNER");
  });

  it("skips a same-pointer owner that became ready after planning", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const kp = "readings/2025/12/01T000000Z-rd_OWNER";
    const failed: Manifest = ManifestSchema.parse({
      id: "rd_OWNER",
      url: a.sourceUrl,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "failed",
      error: { code: "X", message: "prior failure" },
      content_type: "text/markdown; charset=utf-8",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "a".repeat(64),
      created_at: "2025-12-01T00:00:00.000Z",
      updated_at: "2025-12-02T00:00:00.000Z",
    });
    const ready: Manifest = ManifestSchema.parse({
      ...failed,
      status: "ready",
      error: undefined,
      title: "Already ready",
      tldr: "x",
      tags: [],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "y",
      content_status: "captured",
      updated_at: "2025-12-03T00:00:00.000Z",
    });
    const h = harness({
      [`index/by-url/${hex(a.sourceUrl!)}`]: JSON.stringify({ id: "rd_OWNER", key_prefix: kp }),
    });
    let manifestReads = 0;
    h.r2.get.mockImplementation(async (k: string) => {
      if (k === `${kp}/manifest.json`) return JSON.stringify(manifestReads++ === 0 ? failed : ready);
      return h.store.get(k) ?? null;
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    expect(result.dispositions.filter((d) => d.kind === "ingest-failed")).toHaveLength(1);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(result.report).toHaveLength(0);
    expect(h.store.has(`${kp}/manifest.json`)).toBe(false);
  });

  it("re-ingests a prior failed fresh ingest in place on rerun instead of duplicating it", async () => {
    // The historical retry-after-failure flow: a pointerless failed row is still
    // recoverable through the list-index cold lookup instead of minting a SECOND
    // reading.
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");
    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";

    // First run: force the batch to error this item → failed manifest plus the
    // eager by-url claim from submit time.
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;
    await runFreshMarkdownBatch([a], h.deps);
    expect(ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!)).status).toBe("failed");
    expect(h.store.get(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(
      JSON.stringify({ id: "rd_FRESH0", key_prefix: kp }),
    );

    // Second run on the same markdown, with a succeeding batch this time.
    h.setSidecar(null);
    (h.deps.newId as any).mockClear();
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: {
          type: "succeeded" as const,
          message: {
            content: [{ type: "tool_use", id: "x", name: EMIT_READING_TOOL_NAME, input: { ...reading, title: "t" } }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      })),
    ) as any;

    const result = await runFreshMarkdownBatch([a], h.deps);

    // Re-ingested in place: no new id minted, same key_prefix flipped to ready.
    expect(h.deps.newId).not.toHaveBeenCalled();
    expect(result.dispositions.filter((d) => d.kind === "ingest-failed")).toHaveLength(1);
    const m = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(m.id).toBe("rd_FRESH0");
    expect(m.status).toBe("ready");
    // exactly one list row for this URL — no duplicate
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.filter((i: any) => i.url === a.sourceUrl)).toHaveLength(1);
    // by-url is (re)written on the successful re-ingest
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(true);
  });

  it("leaves exactly one list row when re-ingesting a cross-wired failed owner", async () => {
    // The full cross-wired lifecycle: index/list.json carries a stale row whose
    // id (rd_STALE) disagrees with the manifest its key_prefix points at
    // (rd_REAL), and there is no by-url pointer. The cold lookup resolves the
    // owner to the manifest's real id and re-ingests in place under rd_REAL. The
    // stale rd_STALE row must NOT survive beside the rewritten rd_REAL row —
    // both point at the same key_prefix, so list/search would show a bogus dup.
    const a = article("alpha", "https://example.com/alpha");
    const kp = "readings/2025/12/01T000000Z-rd_REAL";
    const failed: Manifest = ManifestSchema.parse({
      id: "rd_REAL",
      url: a.sourceUrl,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "failed",
      error: { code: "X", message: "prior failure" },
      content_type: "text/markdown; charset=utf-8",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "a".repeat(64),
      created_at: "2025-12-01T00:00:00.000Z",
      updated_at: "2025-12-02T00:00:00.000Z",
    });
    const h = harness({
      // stale/cross-wired: row id ≠ manifest id, same key_prefix + URL, no by-url
      "index/list.json": JSON.stringify({
        version: 1,
        items: [{ id: "rd_STALE", key_prefix: kp, url: a.sourceUrl, status: "failed", created_at: "2025-12-01T00:00:00.000Z", updated_at: "2025-12-02T00:00:00.000Z" }],
      }),
      [`${kp}/manifest.json`]: JSON.stringify(failed),
    });

    const result = await runFreshMarkdownBatch([a], h.deps);

    // resolved to the manifest's real id, re-ingested in place (no new id)
    expect(h.deps.newId).not.toHaveBeenCalled();
    expect(result.dispositions.filter((d) => d.kind === "ingest-failed")).toHaveLength(1);
    const m = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(m.id).toBe("rd_REAL");
    expect(m.status).toBe("ready");
    // exactly one list row for the URL, and it's the real id — the stale row is gone
    const index = JSON.parse(h.store.get("index/list.json")!);
    const rows = index.items.filter((i: any) => i.url === a.sourceUrl);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("rd_REAL");
  });

  it("caps submitted readings by --limit after the ownership check", async () => {
    const h = harness();
    const arts = [
      article("a", "https://example.com/a"),
      article("b", "https://example.com/b"),
      article("c", "https://example.com/c"),
    ];
    const result = await runFreshMarkdownBatch(arts, { ...h.deps, limit: 2 });
    // all three resolved to new dispositions, but only two submitted
    expect(result.dispositions.filter((d) => d.kind === "ingest-new")).toHaveLength(3);
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(2);
  });
});

describe("runFreshMarkdownBatch — resume", () => {
  it("rolls back a recoverable pre-create claim sidecar, clears it, and asks for a re-run", async () => {
    const h = harness();
    const a = article("alpha", "https://example.com/alpha");
    const kp = "readings/2026/06/22T120000Z-rd_FRESH0";
    const pending = ManifestSchema.parse({
      id: "rd_FRESH0",
      url: a.sourceUrl,
      url_hash: hex(a.sourceUrl!),
      source_type: "markdown",
      status: "pending",
      title: "alpha",
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: a.bytes,
      content_sha256: "a".repeat(64),
      created_at: NOW,
      updated_at: NOW,
    });
    const pointer = JSON.stringify({ id: "rd_FRESH0", key_prefix: kp });
    const listItem: ListIndexItem = {
      id: "rd_FRESH0",
      key_prefix: kp,
      url: a.sourceUrl!,
      status: "pending" as const,
      created_at: NOW,
      updated_at: NOW,
    };
    h.store.set(`${kp}/manifest.json`, JSON.stringify(pending));
    h.store.set("index/by-id/rd_FRESH0", pointer);
    h.store.set(`index/by-url/${hex(a.sourceUrl!)}`, pointer);
    h.store.set("index/list.json", JSON.stringify({ version: 1, items: [listItem] }));
    const sc: Sidecar = {
      batchId: "",
      model: "claude-opus-4-8",
      processingStatus: "pending",
      resultsUrl: null,
      targets: [],
      claimRollbackPhase: "pre_create",
      claimRollback: {
        objects: [
          { key: `${kp}/manifest.json`, body: null },
          { key: "index/by-id/rd_FRESH0", body: null },
          { key: `index/by-url/${hex(a.sourceUrl!)}`, body: null },
          { key: "index/list.json", body: null },
        ],
        touchedListItems: [listItem],
      },
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    await expect(runFreshMarkdownBatch([a], h.deps)).rejects.toThrow(/rerun corpus-ingest/i);

    expect(h.deps.clearSidecar).toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.store.has(`${kp}/manifest.json`)).toBe(false);
    expect(h.store.has(`index/by-url/${hex(a.sourceUrl!)}`)).toBe(false);
  });

  it("does not auto-recover a create-window pending sidecar", async () => {
    const h = harness();
    const sc: Sidecar = {
      batchId: "",
      model: "claude-opus-4-8",
      processingStatus: "pending",
      resultsUrl: null,
      targets: [],
      claimRollbackPhase: "create_window",
      claimRollback: { objects: [], touchedListItems: [] },
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    await expect(
      runFreshMarkdownBatch([article("alpha", "https://example.com/alpha")], h.deps),
    ).rejects.toThrow(/do NOT delete it by itself/i);
    expect(h.deps.clearSidecar).not.toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
  });

  it("resumes an in-flight sidecar without re-planning or creating a new batch", async () => {
    const h = harness();
    const sc: Sidecar = {
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
