import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch, runBatchPipeline, type BatchRunDeps } from "../../../../scripts/corpus-lib/batch/run";
import { activateRecoverTargets } from "../../../../scripts/corpus-lib/batch/activation-phase";
import { loadSidecar } from "../../../../scripts/corpus-lib/batch/sidecar";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type { AuditRow } from "../../../../scripts/corpus-lib/types";
import type { ExtractedContent } from "../../../../src/modules/extractor";
import type {
  ExtractedTarget,
  PersistedSidecar,
  Sidecar,
} from "../../../../scripts/corpus-lib/batch/types";

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
  keywords: ["keyword one", "keyword two", "keyword three"],
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
    putIfAbsent: vi.fn(async (k: string, b: Uint8Array | string) => {
      if (store.has(k)) return false;
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
      return true;
    }),
    head: vi.fn(async (k: string) => store.has(k)),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
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
    clearSidecar: vi.fn(async () => {
      sidecar = null;
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, vectorize, batch, extract, deps, getSidecar: () => sidecar, setSidecar: (s: Sidecar | null) => (sidecar = s) };
}

describe("runBatch — fresh run", () => {
  it("rejects a new OpenAI batch before planning or activation in the Anthropic-only path", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.configuredProvider = "openai";

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /OpenAI batch.*not supported/i,
    );

    expect(h.extract).not.toHaveBeenCalled();
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
    expect(h.deps.saveSidecar).not.toHaveBeenCalled();
    expect(h.r2.put).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.batch.create).not.toHaveBeenCalled();
  });

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
  it("loads a legacy sidecar and resumes its pinned Anthropic model under an OpenAI default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reading-lite-run-legacy-"));
    try {
      const path = join(dir, "index.batch.json");
      const legacy = {
        batchId: "msgbatch_legacy",
        model: "claude-legacy-pinned",
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
      await writeFile(path, JSON.stringify(legacy));
      const loaded = await loadSidecar(path);
      expect(loaded).toMatchObject({
        version: 2,
        provider: "anthropic",
        phase: "submitted",
      });

      const h = harness({ rd_a: manifest("rd_a") });
      h.setSidecar(loaded as Sidecar);
      h.deps.loadSidecar = vi.fn(async () => loaded);
      h.deps.configuredProvider = "openai";
      h.deps.model = "gpt-current-default";

      const result = await runBatch([row("rd_a")], h.deps);

      expect(result.resumed).toBe(true);
      expect(h.batch.create).not.toHaveBeenCalled();
      expect(h.batch.get).toHaveBeenCalledWith("msgbatch_legacy");
      expect(h.batch.results).toHaveBeenCalled();
      const ready = ManifestSchema.parse(
        JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!),
      );
      expect(ready.usage).toEqual({
        summarization: {
          provider: "anthropic",
          model: "claude-legacy-pinned",
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        openai_embedding_tokens: 13,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes an existing sidecar without creating a new batch", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
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

  it("aborts (no new batch) when a pending sidecar has no batch id — avoids double-billing", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    h.deps.loadSidecar = vi.fn(async (): Promise<PersistedSidecar> => ({
      version: 2,
      provider: "anthropic",
      phase: "creating",
      batchId: "",
      model: "m",
      processingStatus: "pending",
      resultsUrl: null,
      targets: [],
    }));
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/sidecar with no batch id/i);
    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.r2.put).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.deps.embed.embedMany).not.toHaveBeenCalled();
  });

  it("fails clearly before mutation when a submitted Anthropic sidecar has no client credentials", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const sc: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
      batchId: "msgbatch_pinned",
      model: "claude-pinned",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [],
    };
    h.deps.loadSidecar = vi.fn(async () => sc);
    h.deps.batch = undefined as any;

    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(
      /Anthropic.*credentials/i,
    );

    expect(h.batch.create).not.toHaveBeenCalled();
    expect(h.r2.put).not.toHaveBeenCalled();
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.vectorize.upsert).not.toHaveBeenCalled();
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

describe("runBatch — eager recover claim", () => {
  it("claims by-url and writes the pending manifest before creating the batch", async () => {
    const h = harness({ rd_a: manifest("rd_a") }); // failed, no by-url
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

    let atCreate: { byUrl?: string; manifest?: string } = {};
    const origCreate = h.batch.create;
    h.batch.create = vi.fn(async (r: any) => {
      atCreate = {
        byUrl: h.store.get(byUrlKey),
        manifest: h.store.get("readings/kp-rd_a/manifest.json"),
      };
      return origCreate(r);
    });

    const result = await runBatch([row("rd_a")], h.deps);

    // by-url claimed == {id, key_prefix} and the pending manifest exists BEFORE create
    expect(atCreate.byUrl).toBeDefined();
    expect(JSON.parse(atCreate.byUrl!)).toEqual({ id: "rd_a", key_prefix: "readings/kp-rd_a" });
    expect(JSON.parse(atCreate.manifest!).status).toBe("pending");

    // final manifest lands ready
    expect(result.report.filter((r) => r.status === "ready")).toHaveLength(1);
    expect(ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!)).status).toBe("ready");
  });

  it("keeps the by-url claim on batch failure so the failed recover URL stays re-submittable", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    const result = await runBatch([row("rd_a")], h.deps);
    expect(result.report.filter((r) => r.status === "failed")).toHaveLength(1);

    const final = ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!));
    expect(final.status).toBe("failed");
    // by-id present (no dangling row); by-url kept (contrast fresh ingest's release)
    expect(h.store.has("index/by-id/rd_a")).toBe(true);
    expect(h.store.has(byUrlKey)).toBe(true);
    expect(h.r2.delete).not.toHaveBeenCalledWith(byUrlKey);
    // the kept pointer still resolves the failed reading as owner
    expect(JSON.parse(h.store.get(byUrlKey)!)).toEqual({ id: "rd_a", key_prefix: "readings/kp-rd_a" });
    // failed list row present
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.find((i: any) => i.id === "rd_a").status).toBe("failed");
  });

  it("rolls a ready reading forward on failure (defensive: stale in-memory manifest invariant)", async () => {
    // corpus-audit never routes ready rows into recover, so this injects a ready
    // target.manifest straight at the runBatch/activateRecoverTargets seam. The
    // invariant: activation must flip only the live R2 manifest, never the
    // in-memory snapshot submit-phase reads to compute preserveReadyManifest.
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const ready = manifest("rd_a", { status: "ready", title: "Ready", tldr: "keep me" });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(ready));
    h.store.set(`index/by-url/${ready.url_hash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));

    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: ready.url,
        urlHash: ready.url_hash,
        keyPrefix: kp,
        createdAt: ready.created_at,
        manifest: ready,
      },
      markdown: "# rd_a\n\nbody",
      fresh: {
        raw: new TextEncoder().encode("<html>new body</html>"),
        content_type: "text/html",
        content_status: "captured",
        content_bytes: 999,
        content_sha256: "c".repeat(64),
        markdown: "# rd_a\n\nbody",
      },
    };

    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    await runBatchPipeline(async () => ({ extracted: [injected], dropped: [] }), {
      ...h.deps,
      activateExtracted: (targets) =>
        activateRecoverTargets(targets, {
          r2: h.deps.r2,
          model: h.deps.model,
          now: h.deps.now,
          saveSidecar: h.deps.saveSidecar,
        }),
    });

    // rolled FORWARD to ready (preserveReadyManifest), not down to failed
    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("keep me");
    expect(final.active_attempt).toBeUndefined();
  });

  it("rolls forward when the live manifest becomes ready before activation", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const failedAtPrepare = manifest("rd_a", { status: "failed" });
    const liveReady = manifest("rd_a", {
      status: "ready",
      title: "Ready before activation",
      tldr: "keep live ready",
      tags: ["saved"],
      keywords: ["live manifest", "recovery state", "ownership check"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "live summary",
    });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(liveReady));
    h.store.set(`${kp}/extracted.md`, "# rd_a\n\nsaved markdown");
    h.store.set(`index/by-url/${liveReady.url_hash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));

    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: failedAtPrepare.url,
        urlHash: failedAtPrepare.url_hash,
        keyPrefix: kp,
        createdAt: failedAtPrepare.created_at,
        manifest: failedAtPrepare,
      },
      markdown: "# rd_a\n\nbody",
    };

    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    await runBatchPipeline(async () => ({ extracted: [injected], dropped: [] }), {
      ...h.deps,
      activateExtracted: (targets) =>
        activateRecoverTargets(targets, {
          r2: h.deps.r2,
          model: h.deps.model,
          now: h.deps.now,
          saveSidecar: h.deps.saveSidecar,
        }),
    });

    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("keep live ready");
    expect(final.title).toBe("Ready before activation");
    expect(final.active_attempt).toBeUndefined();
  });

  it("preserves a ready snapshot across an activation-window crash and rerun", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const ready = manifest("rd_a", {
      status: "ready",
      title: "Ready before batch",
      tldr: "keep me",
      tags: ["saved"],
      keywords: ["ready snapshot", "rollback state", "recovery batch"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "previous summary",
    });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(ready));
    h.store.set(`${kp}/extracted.md`, "# rd_a\n\nsaved markdown");
    h.store.set(`index/by-url/${ready.url_hash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));

    const injected: ExtractedTarget = {
      target: {
        readingId: "rd_a",
        url: ready.url,
        urlHash: ready.url_hash,
        keyPrefix: kp,
        createdAt: ready.created_at,
        manifest: ready,
      },
      markdown: "# rd_a\n\nbody",
    };

    await expect(
      runBatchPipeline(async () => ({ extracted: [injected], dropped: [] }), {
        ...h.deps,
        activateExtracted: async (targets) => {
          await activateRecoverTargets(targets, {
            r2: h.deps.r2,
            model: h.deps.model,
            now: h.deps.now,
            saveSidecar: h.deps.saveSidecar,
          });
          throw new Error("simulated crash after activation");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    expect(ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!)).status).toBe("pending");
    h.setSidecar(null);

    await expect(
      runBatch([row("rd_a")], {
        ...h.deps,
        activateExtracted: async (targets) => {
          await activateRecoverTargets(targets, {
            r2: h.deps.r2,
            model: h.deps.model,
            now: h.deps.now,
            saveSidecar: h.deps.saveSidecar,
          });
          throw new Error("simulated second crash after activation");
        },
      }),
    ).rejects.toThrow(/simulated second crash/);

    expect(ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!)).status).toBe("pending");
    h.setSidecar(null);
    h.batch.results = vi.fn(async () =>
      (h.getSidecar()?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: { type: "errored" as const, error: { message: "boom" } },
      })),
    ) as any;

    await runBatch([row("rd_a")], h.deps);

    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    expect(final.tldr).toBe("keep me");
    expect(final.title).toBe("Ready before batch");
    expect(final.content_bytes).toBe(ready.content_bytes);
    expect(final.content_sha256).toBe(ready.content_sha256);
    expect(final.active_attempt).toBeUndefined();
  });

  it("activates one target and skips another (foreign-owned) in the same run", async () => {
    const h = harness({ rd_a: manifest("rd_a"), rd_b: manifest("rd_b") });
    // rd_b's by-url slot is owned by a different reading → activation skips it,
    // and only rd_a is summarized + flipped to ready.
    h.store.set(`index/by-url/${manifest("rd_b").url_hash}`, JSON.stringify({ id: "rd_other", key_prefix: "readings/kp-other" }));

    const result = await runBatch([row("rd_a"), row("rd_b")], h.deps);

    expect(result.report.find((r) => r.id === "rd_b")).toMatchObject({
      status: "skipped",
      reason: "by-url owned by a different reading",
    });
    expect(result.report.filter((r) => r.status === "ready").map((r) => r.id)).toEqual(["rd_a"]);
    // only the activated target was submitted, and rd_b stays untouched (still failed)
    expect(h.batch.create.mock.calls[0]![0]).toHaveLength(1);
    expect(ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_a/manifest.json")!)).status).toBe("ready");
    expect(ManifestSchema.parse(JSON.parse(h.store.get("readings/kp-rd_b/manifest.json")!)).status).toBe("failed");
    // rd_b never clobbered rd_other's by-url slot
    expect(JSON.parse(h.store.get(`index/by-url/${manifest("rd_b").url_hash}`)!).id).toBe("rd_other");
  });

  it("rejects an oversized payload before any by-url claim or batch create", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

    await expect(runBatch([row("rd_a")], { ...h.deps, maxBatchBytes: 100 })).rejects.toThrow(/re-run with --limit/);

    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.store.has(byUrlKey)).toBe(false);
    expect(h.batch.create).not.toHaveBeenCalled();
  });
});

describe("runBatch — recover resume", () => {
  it("resumes a post-create sidecar and flips its eager-claim pending to ready (no re-create)", async () => {
    const h = harness({});
    const kp = "readings/kp-rd_a";
    const urlHash = "a".repeat(64);
    const pending: Manifest = ManifestSchema.parse({
      id: "rd_a",
      url: "https://example.com/rd_a",
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: { id: "batch_rd_a", trigger: "reprocess", status: "running", stage: "summarize", started_at: NOW },
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "b".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: NOW,
    });
    h.store.set(`${kp}/manifest.json`, JSON.stringify(pending));
    h.store.set(`index/by-url/${urlHash}`, JSON.stringify({ id: "rd_a", key_prefix: kp }));
    h.store.set("index/by-id/rd_a", JSON.stringify({ id: "rd_a", key_prefix: kp }));

    // A second eager-claim pending that is NOT in this batch's sidecar. Resume must
    // key off the sidecar's targets, not blindly sweep every pending manifest — so
    // this one must be left untouched (proves the rd_a flip is sidecar-driven).
    const otherKp = "readings/kp-rd_other";
    const otherPending: Manifest = ManifestSchema.parse({
      ...pending,
      id: "rd_other",
      url: "https://example.com/rd_other",
      url_hash: "c".repeat(64),
      active_attempt: { id: "batch_rd_other", trigger: "reprocess", status: "running", stage: "summarize", started_at: NOW },
    });
    h.store.set(`${otherKp}/manifest.json`, JSON.stringify(otherPending));
    h.store.set(
      "index/list.json",
      JSON.stringify({
        version: 1,
        items: [
          { id: "rd_a", key_prefix: kp, url: pending.url, status: "pending", created_at: pending.created_at, updated_at: NOW },
          { id: "rd_other", key_prefix: otherKp, url: otherPending.url, status: "pending", created_at: pending.created_at, updated_at: NOW },
        ],
      }),
    );

    const sc: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
      batchId: "msgbatch_run",
      model: "claude-opus-4-8",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [
        {
          customId: "rd_a",
          keyPrefix: kp,
          id: "rd_a",
          url: pending.url,
          urlHash,
          createdAt: pending.created_at,
          sourceType: "url",
          contentType: "text/html",
          contentStatus: "captured",
          contentBytes: 10,
          contentSha256: "b".repeat(64),
          queryEmbedTokens: 7,
        },
      ],
    };
    h.setSidecar(sc);
    h.deps.loadSidecar = vi.fn(async () => sc);

    const result = await runBatch([row("rd_a")], h.deps);

    expect(result.resumed).toBe(true);
    expect(h.batch.create).not.toHaveBeenCalled();
    // the sidecar's specific eager-claim pending (rd_a, batch_rd_a) flips to ready
    const final = ManifestSchema.parse(JSON.parse(h.store.get(`${kp}/manifest.json`)!));
    expect(final.status).toBe("ready");
    // the unrelated pending NOT in the sidecar is left untouched (no blind sweep)
    const other = ManifestSchema.parse(JSON.parse(h.store.get(`${otherKp}/manifest.json`)!));
    expect(other.status).toBe("pending");
    expect(other.active_attempt?.id).toBe("batch_rd_other");
    // by-url / by-id stay consistent for the flipped reading
    expect(JSON.parse(h.store.get(`index/by-url/${urlHash}`)!)).toEqual({ id: "rd_a", key_prefix: kp });
    expect(JSON.parse(h.store.get("index/by-id/rd_a")!)).toEqual({ id: "rd_a", key_prefix: kp });
  });

  it("aborts on an activating-window sidecar, then re-runs cleanly to a single claim", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const byUrlKey = `index/by-url/${manifest("rd_a").url_hash}`;

    // activating-window crash: a sidecar with no batch id
    h.deps.loadSidecar = vi.fn(async (): Promise<PersistedSidecar> => ({
      version: 2,
      provider: "anthropic",
      phase: "activating",
      batchId: "",
      model: "m",
      processingStatus: "activating",
      resultsUrl: null,
      targets: [],
    }));
    await expect(runBatch([row("rd_a")], h.deps)).rejects.toThrow(/sidecar with no batch id/i);
    expect(h.batch.create).not.toHaveBeenCalled();

    // operator clears the sidecar and re-runs — idempotent, single claim + list row
    h.deps.loadSidecar = vi.fn(async () => null);
    await runBatch([row("rd_a")], h.deps);

    expect([...h.store.keys()].filter((k) => k.startsWith("index/by-url/"))).toHaveLength(1);
    expect(h.store.has(byUrlKey)).toBe(true);
    const index = JSON.parse(h.store.get("index/list.json")!);
    expect(index.items.filter((i: any) => i.id === "rd_a")).toHaveLength(1);
  });
});
