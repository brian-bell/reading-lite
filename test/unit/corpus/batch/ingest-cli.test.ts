import { describe, expect, it, vi } from "vitest";
import { runIngest, type IngestArgs, type IngestDeps } from "../../../../scripts/corpus-lib/batch/ingest-cli";
import { urlHash } from "../../../../scripts/corpus-lib/url-hash";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { BatchConfig } from "../../../../scripts/corpus-lib/config";
import type { FreshMarkdownDeps } from "../../../../scripts/corpus-lib/batch/fresh-markdown";
import type { BatchRunResult } from "../../../../scripts/corpus-lib/batch/run";
import type { Manifest } from "../../../../src/schemas/manifest";

function article(name: string, url: string): MarkdownArticle {
  const markdown = `# ${name}\n\n**Source:** ${url}\n\nbody`;
  return { filePath: `/tmp/${name}`, fileName: name, markdown, bytes: markdown.length, sourceUrl: url };
}

const cfg = {} as BatchConfig;

const nullFreshDeps: FreshMarkdownDeps = {
  readPointer: async () => null,
  readManifest: async () => null,
  now: () => "2026-06-22T00:00:00.000Z",
  newId: (() => {
    let n = 0;
    return () => `rd_new${n++}`;
  })(),
};

function deps(over: Partial<IngestDeps> = {}): { deps: IngestDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const base: IngestDeps = {
    readMarkdownDir: async () => [article("a.md", "https://example.com/a")],
    resolveConfig: () => cfg,
    freshDepsFromConfig: () => nullFreshDeps,
    offlineFreshDeps: nullFreshDeps,
    runBatch: async (targets) => ({
      report: targets.map((t) => ({ id: t.target.readingId, status: "ready" as const })),
      dropped: [],
      resumed: false,
      batchId: "msgbatch_x",
    }),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { deps: base, out, err };
}

const args = (over: Partial<IngestArgs> = {}): IngestArgs => ({ dir: "/tmp", execute: false, limit: Infinity, ...over });

function lastJson(out: string[]): any {
  return JSON.parse(out[out.length - 1]!);
}

describe("runIngest — dry-run", () => {
  it("prints the plan and does not run the batch", async () => {
    const h = deps();
    const runBatch = vi.fn(h.deps.runBatch);
    h.deps.runBatch = runBatch;
    const code = await runIngest(args(), h.deps);
    expect(code).toBe(0);
    expect(runBatch).not.toHaveBeenCalled();
    const summary = lastJson(h.out);
    expect(summary).toMatchObject({ executed: false, wouldSubmit: 1, idempotencyChecked: true });
  });

  it("falls back to offline planning (idempotencyChecked: false) when creds are missing", async () => {
    const offline = vi.fn(async () => null);
    const h = deps({
      resolveConfig: () => {
        throw new Error("missing batch config: CORPUS_R2_ACCOUNT_ID");
      },
      offlineFreshDeps: { ...nullFreshDeps, readPointer: offline },
    });
    const code = await runIngest(args(), h.deps);
    expect(code).toBe(0);
    expect(offline).toHaveBeenCalled();
    expect(lastJson(h.out)).toMatchObject({ executed: false, idempotencyChecked: false });
    expect(h.err.join("\n")).toMatch(/skipping idempotency check/i);
  });
});

describe("runIngest — execute", () => {
  it("runs the batch and reports ready/failed counts", async () => {
    const h = deps();
    const code = await runIngest(args({ execute: true }), h.deps);
    expect(code).toBe(0);
    expect(lastJson(h.out)).toMatchObject({ executed: true, mode: "batch", ready: 1, failed: 0 });
  });

  it("exits 2 when creds are missing for --execute (never runs the batch)", async () => {
    const runBatch = vi.fn(async (): Promise<BatchRunResult> => ({ report: [], dropped: [], resumed: false }));
    const h = deps({
      resolveConfig: () => {
        throw new Error("missing batch config");
      },
      runBatch,
    });
    const code = await runIngest(args({ execute: true }), h.deps);
    expect(code).toBe(2);
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("exits 1 when some readings failed", async () => {
    const h = deps({
      runBatch: async () => ({
        report: [
          { id: "rd_new0", status: "ready" },
          { id: "rd_x", status: "failed", reason: "boom" },
        ],
        dropped: [],
        resumed: false,
      }),
    });
    const code = await runIngest(args({ execute: true }), h.deps);
    expect(code).toBe(1);
    expect(lastJson(h.out)).toMatchObject({ ready: 1, failed: 1 });
  });

  it("short-circuits to ready:0 when every URL was skipped (nothing to submit)", async () => {
    const readyHash = urlHash("https://example.com/a");
    const runBatch = vi.fn(async (): Promise<BatchRunResult> => ({ report: [], dropped: [], resumed: false }));
    const h = deps({
      freshDepsFromConfig: () => ({
        ...nullFreshDeps,
        readPointer: async (hash: string) =>
          hash === readyHash ? { id: "rd_old", key_prefix: "readings/kp-old" } : null,
        readManifest: async () => ({ status: "ready" } as Manifest),
      }),
      runBatch,
    });
    const code = await runIngest(args({ execute: true }), h.deps);
    expect(code).toBe(0);
    expect(runBatch).not.toHaveBeenCalled();
    expect(lastJson(h.out)).toMatchObject({ executed: true, ready: 0, skipped: 1 });
  });

  it("applies --limit after idempotency skips (caps submitted targets)", async () => {
    const captured: number[] = [];
    const h = deps({
      readMarkdownDir: async () => [
        article("a.md", "https://example.com/a"),
        article("b.md", "https://example.com/b"),
        article("c.md", "https://example.com/c"),
      ],
      runBatch: async (targets) => {
        captured.push(targets.length);
        return { report: targets.map((t) => ({ id: t.target.readingId, status: "ready" as const })), dropped: [], resumed: false };
      },
    });
    const code = await runIngest(args({ execute: true, limit: 2 }), h.deps);
    expect(code).toBe(0);
    expect(captured).toEqual([2]);
  });
});
