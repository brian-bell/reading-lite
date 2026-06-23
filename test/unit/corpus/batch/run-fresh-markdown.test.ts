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
    put: vi.fn(async (k: string, b: Uint8Array | string) => {
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    }),
    head: vi.fn(async (k: string) => store.has(k)),
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
});

describe("runFreshMarkdownBatch — idempotency", () => {
  it("skips a ready owner and never re-summarizes it", async () => {
    const a = article("alpha", "https://example.com/alpha");
    const ready: Manifest = ManifestSchema.parse({
      id: "rd_OWNER",
      url: a.sourceUrl,
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
