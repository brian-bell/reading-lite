import { describe, expect, it, vi } from "vitest";
import {
  runFreshMarkdownBatch,
  type FreshMarkdownRunDeps,
} from "../../../../scripts/corpus-lib/batch/run-fresh-markdown";
import { prepareFreshMarkdown } from "../../../../scripts/corpus-lib/batch/prepare-fresh-markdown";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { Sidecar, ExtractedTarget } from "../../../../scripts/corpus-lib/batch/types";

const NOW = "2026-06-22T12:00:00.000Z";

const reading = {
  title: "Title",
  tldr: "Tldr.",
  tags: ["t"],
  keywords: ["k"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "body",
};

// In-memory R2, recording vectorize, scripted batch lifecycle (mirrors run.test).
function harness() {
  const store = new Map<string, string>();
  const r2 = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, b: Uint8Array | string) => {
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    }),
    head: vi.fn(async (k: string) => store.has(k)),
  };
  const vectorize = {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
  };
  let sidecar: Sidecar | null = null;
  const batch = {
    create: vi.fn(async () => ({ id: "msgbatch_md", processing_status: "in_progress", results_url: null })),
    get: vi.fn(async () => ({ id: "msgbatch_md", processing_status: "ended", results_url: "https://results" })),
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
    model: "claude-opus-4-8",
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    loadSidecar: vi.fn(async () => null),
    saveSidecar: vi.fn(async (s: Sidecar) => {
      sidecar = s;
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, vectorize, batch, deps, getSidecar: () => sidecar, setSidecar: (s: Sidecar | null) => (sidecar = s) };
}

function target(id: string, urlHash = id.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0")): ExtractedTarget {
  const markdown = `# ${id}\n\nbody for ${id}`;
  const bytes = new TextEncoder().encode(markdown);
  const carrier: Manifest = {
    id,
    url: `https://example.com/${id}`,
    url_hash: urlHash,
    source_type: "markdown",
    status: "pending",
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: bytes.byteLength,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: NOW,
  };
  return {
    target: {
      readingId: id,
      url: `https://example.com/${id}`,
      urlHash,
      keyPrefix: `readings/kp-${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      manifest: carrier,
    },
    markdown,
    title: id,
    fresh: {
      raw: bytes,
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: bytes.byteLength,
      content_sha256: "b".repeat(64),
      markdown,
      title: id,
    },
  };
}

describe("runFreshMarkdownBatch — fresh run", () => {
  it("summarizes markdown via the batch API and writes ready markdown readings", async () => {
    const h = harness();
    const result = await runFreshMarkdownBatch([target("rd_a"), target("rd_b")], h.deps);

    expect(result.resumed).toBe(false);
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(2);

    const mA = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!));
    expect(mA.status).toBe("ready");
    expect(mA.source_type).toBe("markdown");
    expect(mA.content_status).toBe("captured");
    expect(mA.content_type).toBe("text/markdown; charset=utf-8");
    expect(mA.title).toBe("Title rd_a");
    // openai tokens = query embed (4) + tldr embed (4)
    expect(mA.usage!.openai_embedding_tokens).toBe(8);

    // raw.md + extracted.md persisted from the markdown in hand
    expect(h.store.get("readings/kp-rd_a/raw.md")).toContain("body for rd_a");
    expect(h.store.get("readings/kp-rd_a/extracted.md")).toContain("body for rd_a");

    // by-url + by-id pointers, vector, list index
    expect(h.store.has(`index/by-url/${mA.url_hash}`)).toBe(true);
    expect(h.store.has(`index/by-id/rd_a`)).toBe(true);
    expect(h.vectorize.upsert).toHaveBeenCalled();
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.map((i: any) => i.id).sort()).toEqual(["rd_a", "rd_b"]);
  });

  it("persists a pending sidecar before creating the batch (crash-window safety)", async () => {
    const h = harness();
    const calls: string[] = [];
    const origSave = h.deps.saveSidecar;
    h.deps.saveSidecar = vi.fn(async (s: Sidecar) => {
      calls.push(s.batchId === "" ? "save:pending" : "save:final");
      await origSave(s);
    });
    const origCreate = h.batch.create;
    h.batch.create = vi.fn(async () => {
      calls.push("create");
      return origCreate();
    });
    await runFreshMarkdownBatch([target("rd_a")], h.deps);
    expect(calls.indexOf("save:pending")).toBeLessThan(calls.indexOf("create"));
  });

  it("returns an empty report when there are no targets", async () => {
    const h = harness();
    const result = await runFreshMarkdownBatch([], h.deps);
    expect(result.report).toHaveLength(0);
    expect(h.batch.create).not.toHaveBeenCalled();
  });
});

describe("runFreshMarkdownBatch — resume", () => {
  it("resumes an existing sidecar without creating a new batch", async () => {
    const h = harness();
    const sc: Sidecar = {
      batchId: "msgbatch_md",
      model: "claude-opus-4-8",
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

    const result = await runFreshMarkdownBatch([target("rd_a")], h.deps);
    expect(result.resumed).toBe(true);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    const m = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!));
    expect(m.status).toBe("ready");
    expect(m.source_type).toBe("markdown");
  });

  it("aborts (no new batch) when a pending sidecar has no batch id — avoids double-billing", async () => {
    const h = harness();
    h.deps.loadSidecar = vi.fn(async () => ({
      batchId: "",
      model: "m",
      processingStatus: "pending",
      resultsUrl: null,
      targets: [],
    }));
    await expect(runFreshMarkdownBatch([target("rd_a")], h.deps)).rejects.toThrow(/pending batch sidecar/i);
    expect(h.batch.create).not.toHaveBeenCalled();
  });
});

describe("prepareFreshMarkdown + runFreshMarkdownBatch — end to end", () => {
  it("ingests an unclaimed URL to a ready markdown reading", async () => {
    const h = harness();
    const prep = await prepareFreshMarkdown(
      [{ sourceUrl: "https://example.com/fresh", markdown: "# Fresh\n\nhello", title: "Fresh" }],
      {
        readByUrlPointer: vi.fn(async () => null),
        readManifest: vi.fn(async () => null),
        mintId: () => "rd_fresh",
        now: () => NOW,
        sha256: async (s: string) => {
          let n = 0;
          for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
          return n.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
        },
      },
    );
    expect(prep.targets).toHaveLength(1);

    const result = await runFreshMarkdownBatch(prep.targets, h.deps);
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(1);
    const kp = prep.targets[0]!.target.keyPrefix;
    const m = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(m.id).toBe("rd_fresh");
    expect(m.source_type).toBe("markdown");
    expect(m.status).toBe("ready");
  });
});
