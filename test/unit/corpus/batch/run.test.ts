import { describe, expect, it, vi } from "vitest";
import { runBatch, type BatchRunDeps } from "../../../../scripts/corpus-lib/batch/run";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { AuditRow } from "../../../../scripts/corpus-lib/types";
import type { ExtractedContent } from "../../../../src/modules/extractor";
import type { Sidecar } from "../../../../scripts/corpus-lib/batch/types";

const NOW = "2026-06-18T12:00:00.000Z";

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
  keywords: ["k"],
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
    head: vi.fn(async (k: string) => store.has(k)),
  };
  const vectorize = {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
  };
  let sidecar: Sidecar | null = null;
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
    batch: batch as any,
    embed: { embedMany: vi.fn(async (inputs: string[]) => inputs.map(() => Array.from({ length: 1536 }, () => 0.1))) },
    extract,
    model: "claude-opus-4-8",
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    loadSidecar: vi.fn(async () => null),
    saveSidecar: vi.fn(async (s: Sidecar) => {
      sidecar = s;
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, vectorize, batch, extract, deps, getSidecar: () => sidecar, setSidecar: (s: Sidecar | null) => (sidecar = s) };
}

describe("runBatch — fresh run", () => {
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
    // sidecar saved before polling
    expect(h.deps.saveSidecar).toHaveBeenCalled();
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
});

describe("runBatch — resume", () => {
  it("resumes an existing sidecar without creating a new batch", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: Sidecar = {
      batchId: "msgbatch_run",
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
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
        },
      ],
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    const result = await runBatch([row("rd_a")], h.deps);
    expect(result.resumed).toBe(true);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    const m = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!));
    expect(m.status).toBe("ready");
  });

  it("aborts (no new batch) when a pending sidecar has no batch id — avoids double-billing", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.loadSidecar = vi.fn(async () => ({
      batchId: "",
      model: "m",
      processingStatus: "pending",
      resultsUrl: null,
      targets: [],
    }));
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/pending batch sidecar/i);
    expect(h.batch.create).not.toHaveBeenCalled();
  });

  it("persists a sidecar before creating the batch (crash-window safety)", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const calls: string[] = [];
    const origSave = h.deps.saveSidecar;
    h.deps.saveSidecar = vi.fn(async (s: Sidecar) => {
      calls.push(s.batchId === "" ? "save:pending" : "save:final");
      await origSave(s);
    });
    const origCreate = h.batch.create;
    h.batch.create = vi.fn(async (r: any) => {
      calls.push("create");
      return origCreate(r);
    });
    await runBatch([row("rd_a")], h.deps);
    expect(calls.indexOf("save:pending")).toBeLessThan(calls.indexOf("create"));
  });
});
