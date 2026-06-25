import { describe, expect, it, vi } from "vitest";
import { runBatch, type BatchRunDeps } from "../../../../scripts/corpus-lib/batch/run";
import { PointerExistsError } from "../../../../scripts/lib/cf-clients";
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
  const etags = new Map<string, number>();
  const etagOf = (k: string) => String(etags.get(k) ?? 0);
  const r2 = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    getWithEtag: vi.fn(async (k: string) => (store.has(k) ? { body: store.get(k)!, etag: etagOf(k) } : null)),
    put: vi.fn(async (k: string, b: Uint8Array | string, opts?: { ifNoneMatch?: "*"; ifMatch?: string }) => {
      if (opts?.ifNoneMatch === "*" && store.has(k)) throw new PointerExistsError(k);
      if (opts?.ifMatch !== undefined && (!store.has(k) || opts.ifMatch !== etagOf(k))) throw new PointerExistsError(k);
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
      etags.set(k, (etags.get(k) ?? 0) + 1);
    }),
    head: vi.fn(async (k: string) => store.has(k)),
    listKeys: vi.fn(async () => [...store.keys()]),
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
    embed: {
      embedMany: vi.fn(async (inputs: string[]) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0.1)),
        tokensByInput: inputs.map(() => 4),
      })),
    },
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

  it("heartbeats the eager pending manifest while the batch is in flight (keeps it from going stale)", async () => {
    const h = harness({ h1: manifest("h1", { status: "failed" }) });
    // Stay in progress for two polls, then end — so the heartbeat onTick fires.
    let g = 0;
    h.batch.get = vi.fn(async () => {
      g++;
      const ended = g >= 3;
      return { id: "msgbatch_run", processing_status: ended ? "ended" : "in_progress", results_url: ended ? "https://results" : null };
    }) as any;
    // Advancing clock so the heartbeat gate elapses between polls.
    let t = Date.parse("2026-06-18T12:00:00.000Z");
    h.deps.now = () => {
      const iso = new Date(t).toISOString();
      t += 600_000;
      return iso;
    };
    h.deps.poll = { intervalMs: 1, maxPolls: 10, heartbeatMs: 1 };

    // Record every pending write to the in-flight manifest.
    const pendingUpdatedAts: string[] = [];
    const origPut = h.r2.put;
    h.r2.put = vi.fn(async (k: string, b: Uint8Array | string) => {
      if (k === "readings/kp-h1/manifest.json") {
        try {
          const m = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b));
          if (m.status === "pending") pendingUpdatedAts.push(m.updated_at);
        } catch {
          /* ignore */
        }
      }
      await (origPut as any)(k, b);
    }) as any;

    await runBatch([row("h1")], h.deps);

    // The eager claim wrote one pending manifest; the heartbeat refreshed it at
    // least once more with a strictly-later updated_at before the terminal write.
    expect(pendingUpdatedAts.length).toBeGreaterThanOrEqual(2);
    expect(Date.parse(pendingUpdatedAts.at(-1)!)).toBeGreaterThan(Date.parse(pendingUpdatedAts[0]!));
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

  it("logs each dropped reading with its reason (not just a count)", async () => {
    const lines: string[] = [];
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.log = (l) => lines.push(l);
    await runBatch([row("rd_a"), row("rd_missing")], h.deps);
    const dropLine = lines.find((l) => l.includes("rd_missing"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toMatch(/drop/i);
    expect(dropLine).toMatch(/manifest/i); // the reason from prepare
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
          queryEmbedTokens: 9,
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

  it("heartbeats the eager pending manifests on RESUME, refreshing an already-stale pending on the first poll (issue #66)", async () => {
    const h = harness({});
    const kp = "readings/kp-hb";
    // A pending left stamped by a previous (now-dead) process, long ago / stale.
    h.store.set(
      `${kp}/manifest.json`,
      JSON.stringify(
        ManifestSchema.parse(
          manifest("rd_hb", {
            status: "pending",
            content_status: "captured",
            created_at: "2026-06-18T00:00:00.000Z",
            updated_at: "2026-06-18T00:00:00.000Z",
          }),
        ),
      ),
    );
    const sc: Sidecar = {
      batchId: "msgbatch_run",
      model: "claude-opus-4-8",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [
        {
          customId: "rd_hb",
          keyPrefix: kp,
          id: "rd_hb",
          url: "https://example.com/rd_hb",
          urlHash: "a".repeat(64),
          createdAt: "2026-06-18T00:00:00.000Z",
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 9,
        },
      ],
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    // Stay in progress one poll, then end → the heartbeat onTick fires.
    let g = 0;
    h.batch.get = vi.fn(async () => {
      g++;
      const ended = g >= 2;
      return { id: "msgbatch_run", processing_status: ended ? "ended" : "in_progress", results_url: ended ? "https://results" : null };
    }) as any;
    // Resume happens much later than the stale stamp; advancing clock per call.
    let t = Date.parse("2026-06-18T12:00:00.000Z");
    h.deps.now = () => {
      const iso = new Date(t).toISOString();
      t += 1_000;
      return iso;
    };
    h.deps.poll = { intervalMs: 1, maxPolls: 10, heartbeatMs: 1 };

    const pendingUpdatedAts: string[] = [];
    const origPut = h.r2.put;
    h.r2.put = vi.fn(async (k: string, b: Uint8Array | string) => {
      if (k === `${kp}/manifest.json`) {
        try {
          const m = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b));
          if (m.status === "pending") pendingUpdatedAts.push(m.updated_at);
        } catch {
          /* ignore */
        }
      }
      await (origPut as any)(k, b);
    }) as any;

    const result = await runBatch([row("rd_hb")], h.deps);
    expect(result.resumed).toBe(true);
    // The resumed run never re-claimed, but it DID refresh the stale pending on the
    // first poll tick (resume safety) — with an updated_at far newer than the stale
    // stamp — before the terminal write.
    expect(pendingUpdatedAts.length).toBeGreaterThanOrEqual(1);
    expect(Date.parse(pendingUpdatedAts[0]!)).toBeGreaterThan(Date.parse("2026-06-18T00:00:00.000Z"));
  });

  it("refreshes a stale eager pending before the terminal write even when the batch is already ended on the first resume poll (issue #66)", async () => {
    // The narrow resume race: process died, pendings aged past TTL, AND the batch
    // finished while down — so the first poll returns `ended` and onTick never
    // fires. The pre-terminal-write refresh must still re-stamp the stale pending
    // before results-fetch/embed/write, or an online submit could reprocess it.
    const h = harness({});
    const kp = "readings/kp-stale";
    h.store.set(
      `${kp}/manifest.json`,
      JSON.stringify(
        ManifestSchema.parse(
          manifest("rd_stale", {
            status: "pending",
            content_status: "captured",
            created_at: "2026-06-18T00:00:00.000Z",
            updated_at: "2026-06-18T00:00:00.000Z",
          }),
        ),
      ),
    );
    const sc: Sidecar = {
      batchId: "msgbatch_run",
      model: "claude-opus-4-8",
      processingStatus: "ended",
      resultsUrl: "https://results",
      targets: [
        {
          customId: "rd_stale",
          keyPrefix: kp,
          id: "rd_stale",
          url: "https://example.com/rd_stale",
          urlHash: "a".repeat(64),
          createdAt: "2026-06-18T00:00:00.000Z",
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 9,
        },
      ],
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);
    // Batch is already ended on the very first poll → onTick never fires.
    h.batch.get = vi.fn(async () => ({ id: "msgbatch_run", processing_status: "ended", results_url: "https://results" })) as any;
    let t = Date.parse("2026-06-18T12:00:00.000Z");
    h.deps.now = () => {
      const iso = new Date(t).toISOString();
      t += 1_000;
      return iso;
    };

    const pendingUpdatedAts: string[] = [];
    const origPut = h.r2.put;
    h.r2.put = vi.fn(async (k: string, b: Uint8Array | string) => {
      if (k === `${kp}/manifest.json`) {
        try {
          const m = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b));
          if (m.status === "pending") pendingUpdatedAts.push(m.updated_at);
        } catch {
          /* ignore */
        }
      }
      await (origPut as any)(k, b);
    }) as any;

    await runBatch([row("rd_stale")], h.deps);

    // The stale pending was refreshed (updated_at advanced) before the terminal write.
    expect(pendingUpdatedAts.length).toBeGreaterThanOrEqual(1);
    expect(Date.parse(pendingUpdatedAts[0]!)).toBeGreaterThan(Date.parse("2026-06-18T00:00:00.000Z"));
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
