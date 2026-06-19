import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateOne, runMigration } from "../../../scripts/migrate-lib/run";
import type { R2Client, VectorizeClient } from "../../../scripts/migrate-lib/clients";
import type { BacklitRow } from "../../../scripts/migrate-lib/plan";

function makeR2(): R2Client & { calls: Array<{ key: string; size: number; contentType?: string }> } {
  const calls: Array<{ key: string; size: number; contentType?: string }> = [];
  return {
    put: vi.fn(async (key, body, opts) => {
      const size = typeof body === "string" ? body.length : body.byteLength;
      calls.push({ key, size, contentType: opts?.contentType });
    }),
    head: vi.fn(async () => false),
    calls,
  } as unknown as R2Client & typeof calls extends never ? never : R2Client & { calls: typeof calls };
}

function makeVectorize(): VectorizeClient & { upserts: Array<{ id: string; metadata: Record<string, unknown> }> } {
  const upserts: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  return {
    upsert: vi.fn(async (vs) => {
      for (const v of vs) {
        upserts.push({ id: v.id, metadata: v.metadata });
      }
    }),
    upserts,
  } as unknown as VectorizeClient & { upserts: typeof upserts };
}

const baseRow: BacklitRow = {
  id: "rd_abc",
  url: "https://example.com/a",
  url_hash: "a".repeat(64),
  title: "Title",
  tldr: "tldr",
  tags: ["t"],
  keywords: ["k"],
  people: [],
  orgs: [],
  novelty_verdict: "novel",
  connections: [],
  summary_markdown: "body",
  embedding: new Array(1536).fill(0.1),
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 5,
  extracted_bytes: 4,
  content_sha256: "b".repeat(64),
  fetched_at: "2026-04-25T20:00:00.000Z",
  created_at: "2026-04-25T20:00:00.000Z",
  updated_at: "2026-04-25T20:00:01.000Z",
};

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-test-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixture(rowId: string, files: Record<string, string>) {
  const dir = path.join(tmpDir, "readings", rowId);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
}

describe("migrateOne", () => {
  it("writes manifest, raw, extracted, both pointers, and the vector", async () => {
    await writeFixture("rd_abc", { "raw.html": "<html>x</html>", "extracted.md": "# x" });
    const r2 = makeR2();
    const vectorize = makeVectorize();

    const r = await migrateOne(baseRow, { r2, vectorize, contentDir: tmpDir });
    expect(r.status).toBe("ok");

    const keys = (r2 as unknown as { calls: Array<{ key: string }> }).calls.map((c) => c.key);
    expect(keys).toContain("readings/2026/04/25T200000Z-rd_abc/manifest.json");
    expect(keys).toContain("readings/2026/04/25T200000Z-rd_abc/raw.html");
    expect(keys).toContain("readings/2026/04/25T200000Z-rd_abc/extracted.md");
    expect(keys).toContain(`index/by-url/${baseRow.url_hash}`);
    expect(keys).toContain(`index/by-id/${baseRow.id}`);

    const upserts = (vectorize as unknown as { upserts: Array<{ id: string; metadata: { url: string } }> }).upserts;
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.id).toBe("rd_abc");
    expect(upserts[0]!.metadata.url).toBe("https://example.com/a");
  });

  it("skips raw + extracted when files are missing on disk (idempotent partial migration)", async () => {
    // No fixture files written.
    const r2 = makeR2();
    const vectorize = makeVectorize();
    const r = await migrateOne(baseRow, { r2, vectorize, contentDir: tmpDir });
    expect(r.status).toBe("ok");
    const keys = (r2 as unknown as { calls: Array<{ key: string }> }).calls.map((c) => c.key);
    expect(keys).toContain("readings/2026/04/25T200000Z-rd_abc/manifest.json");
    expect(keys).not.toContain("readings/2026/04/25T200000Z-rd_abc/raw.html");
    expect(keys).not.toContain("readings/2026/04/25T200000Z-rd_abc/extracted.md");
  });

  it("captures errors instead of throwing", async () => {
    const r2: R2Client = {
      put: vi.fn(async () => {
        throw new Error("r2 down");
      }),
      get: vi.fn(async () => null),
      head: vi.fn(async () => false),
    };
    const vectorize = makeVectorize();
    const r = await migrateOne(baseRow, { r2, vectorize, contentDir: tmpDir });
    expect(r.status).toBe("error");
    expect(r.error).toContain("r2 down");
  });
});

describe("runMigration", () => {
  it("processes valid rows + emits CSV header + per-row lines", async () => {
    await writeFixture("rd_abc", { "raw.html": "x", "extracted.md": "# x" });
    const r2 = makeR2();
    const vectorize = makeVectorize();
    const log = vi.fn<(line: string) => void>();
    const report = await runMigration([baseRow], { r2, vectorize, contentDir: tmpDir, log });
    expect(report).toEqual([{ id: "rd_abc", status: "ok" }]);
    expect(log).toHaveBeenNthCalledWith(1, "id,status,error");
    expect(log).toHaveBeenNthCalledWith(2, 'rd_abc,ok,""');
  });

  it("reports rows that fail schema validation", async () => {
    const r2 = makeR2();
    const vectorize = makeVectorize();
    const log = vi.fn<(line: string) => void>();
    const bad = { ...baseRow, url_hash: "not-hex" };
    const report = await runMigration([bad], { r2, vectorize, contentDir: tmpDir, log });
    expect(report[0]!.status).toBe("error");
    expect(report[0]!.error).toContain("schema");
  });

  it("writes index/list.json at end-of-run with one entry per ok row", async () => {
    const r2 = makeR2();
    const vectorize = makeVectorize();
    const rowB: BacklitRow = {
      ...baseRow,
      id: "rd_def",
      url: "https://example.com/b",
      url_hash: "c".repeat(64),
      created_at: "2026-04-25T20:00:01.000Z",
    };
    await runMigration([baseRow, rowB], { r2, vectorize, contentDir: tmpDir });

    const calls = (r2 as unknown as { calls: Array<{ key: string; size: number }> }).calls;
    const indexCalls = calls.filter((c) => c.key === "index/list.json");
    expect(indexCalls).toHaveLength(1);

    const putMock = (r2 as unknown as { put: { mock: { calls: Array<[string, string | Uint8Array]> } } }).put.mock;
    const indexCall = putMock.calls.find((c) => c[0] === "index/list.json");
    expect(indexCall).toBeDefined();
    const body = indexCall![1] as string;
    const parsed = JSON.parse(body) as {
      version: number;
      items: Array<{ id: string; url: string; status: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.items.map((i) => i.id).sort()).toEqual(["rd_abc", "rd_def"]);
    expect(parsed.items.every((i) => i.status === "ready")).toBe(true);
  });

  it("does not include errored rows in index/list.json", async () => {
    const r2 = makeR2();
    const vectorize = makeVectorize();
    const bad = { ...baseRow, id: "rd_bad", url_hash: "not-hex" };
    await runMigration([baseRow, bad], { r2, vectorize, contentDir: tmpDir });

    const putMock = (r2 as unknown as { put: { mock: { calls: Array<[string, string | Uint8Array]> } } }).put.mock;
    const indexCall = putMock.calls.find((c) => c[0] === "index/list.json");
    expect(indexCall).toBeDefined();
    const parsed = JSON.parse(indexCall![1] as string) as { items: Array<{ id: string }> };
    expect(parsed.items.map((i) => i.id)).toEqual(["rd_abc"]);
  });

  it("does not write index/list.json when no rows succeed", async () => {
    // Mirrors the live listManifests behavior: don't create an empty index
    // file. Otherwise a future cold list call won't take the rebuild path.
    const r2 = makeR2();
    const vectorize = makeVectorize();
    const bad = { ...baseRow, url_hash: "not-hex" };
    await runMigration([bad], { r2, vectorize, contentDir: tmpDir });

    const putMock = (r2 as unknown as { put: { mock: { calls: Array<[string, string | Uint8Array]> } } }).put.mock;
    const indexCall = putMock.calls.find((c) => c[0] === "index/list.json");
    expect(indexCall).toBeUndefined();
  });
});
