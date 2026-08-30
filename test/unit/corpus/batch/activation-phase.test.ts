import { describe, expect, it, vi } from "vitest";
import {
  activateFreshTargets,
  activateRecoverTargets,
} from "../../../../scripts/corpus-lib/batch/activation-phase";
import { submitBatch } from "../../../../scripts/corpus-lib/batch/submit-phase";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import type { ExtractedTarget, SummarizeTarget } from "../../../../scripts/corpus-lib/batch/types";
import type { ExtractedContent } from "../../../../src/modules/extractor";

const NOW = "2026-06-22T00:00:00.000Z";
const URL_HASH = "a".repeat(64);
const KEY_PREFIX = "readings/2026/06/22T000000Z-rd_a";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: URL_HASH,
    source_type: "markdown",
    status: "pending",
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: 13,
    content_sha256: "b".repeat(64),
    created_at: NOW,
    updated_at: NOW,
    ...over,
  } as Manifest;
}

const fresh: ExtractedContent = {
  raw: new TextEncoder().encode("# A\n\nbody"),
  content_type: "text/markdown; charset=utf-8",
  content_status: "captured",
  content_bytes: 9,
  content_sha256: "c".repeat(64),
  markdown: "# A\n\nbody",
};

function target(over: Partial<ExtractedTarget> = {}): ExtractedTarget {
  return {
    target: {
      readingId: "rd_a",
      url: "https://example.com/a",
      urlHash: URL_HASH,
      keyPrefix: KEY_PREFIX,
      createdAt: NOW,
      manifest: manifest(),
    },
    markdown: "# A\n\nbody",
    fresh,
    freshActivation: { kind: "create-new" },
    ...over,
  };
}

function r2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  return {
    store,
    calls,
    get: vi.fn(async (key: string) => {
      calls.push(`get:${key}`);
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, body: Uint8Array | string) => {
      calls.push(`put:${key}`);
      store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    }),
    putIfAbsent: vi.fn(async (key: string, body: Uint8Array | string) => {
      calls.push(`putIfAbsent:${key}`);
      if (store.has(key)) return false;
      store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      return true;
    }),
    delete: vi.fn(async (key: string) => {
      calls.push(`delete:${key}`);
      store.delete(key);
    }),
  };
}

describe("activateFreshTargets", () => {
  it("claims by-url before writing fresh content, pending manifest, by-id, and list row", async () => {
    const fakeR2 = r2();
    const sidecars: any[] = [];

    const result = await activateFreshTargets([target()], {
      r2: fakeR2 as any,
      model: "claude-opus-4-8",
      now: () => NOW,
      saveSidecar: vi.fn(async (s) => {
        fakeR2.calls.push(`sidecar:${s.processingStatus}`);
        sidecars.push(s);
      }),
    });

    expect(result.skipped).toEqual([]);
    expect(result.activated[0]!.contentAlreadyWritten).toBe(true);
    expect(fakeR2.calls).toEqual([
      "sidecar:activating",
      `putIfAbsent:index/by-url/${URL_HASH}`,
      `${"put"}:${KEY_PREFIX}/raw.md`,
      `${"put"}:${KEY_PREFIX}/extracted.md`,
      `${"put"}:${KEY_PREFIX}/manifest.json`,
      "put:index/by-id/rd_a",
      "get:index/list.json",
      "put:index/list.json",
    ]);

    expect(sidecars[0]).toMatchObject({
      version: 2,
      provider: "anthropic",
      phase: "activating",
      batchId: "",
      processingStatus: "activating",
      targets: [{ id: "rd_a", customId: "rd_a", keyPrefix: KEY_PREFIX }],
    });

    expect(JSON.parse(fakeR2.store.get(`index/by-url/${URL_HASH}`)!)).toEqual({
      id: "rd_a",
      key_prefix: KEY_PREFIX,
    });
    expect(Object.keys(JSON.parse(fakeR2.store.get(`index/by-url/${URL_HASH}`)!))).toEqual(["id", "key_prefix"]);

    const pending = ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!));
    expect(pending.status).toBe("pending");
    expect(pending.active_attempt).toMatchObject({
      id: "batch_rd_a",
      trigger: "import",
      status: "running",
      stage: "summarize",
      started_at: NOW,
    });
    expect(JSON.parse(fakeR2.store.get("index/list.json")!).items[0]).toMatchObject({
      id: "rd_a",
      status: "pending",
      active_attempt: pending.active_attempt,
    });
  });

  it("pins the OpenAI run identity before the first eager ownership write", async () => {
    const fakeR2 = r2();
    const sidecars: any[] = [];

    await activateFreshTargets([target()], {
      r2: fakeR2 as any,
      identity: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        runId: "run_stable",
      },
      now: () => NOW,
      saveSidecar: vi.fn(async (sidecar) => {
        sidecars.push(sidecar);
      }),
    });

    expect(sidecars[0]).toMatchObject({
      provider: "openai",
      phase: "activating",
      runId: "run_stable",
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      inputFileId: null,
    });
    expect(fakeR2.calls[0]).toBe(`putIfAbsent:index/by-url/${URL_HASH}`);
  });

  it("skips a new target if the by-url conditional claim loses", async () => {
    const fakeR2 = r2({ [`index/by-url/${URL_HASH}`]: JSON.stringify({ id: "rd_other", key_prefix: "kp" }) });

    const result = await activateFreshTargets([target()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "rd_a", status: "skipped", reason: "by-url slot already owned at batch submit" },
    ]);
    expect(fakeR2.store.has(`${KEY_PREFIX}/manifest.json`)).toBe(false);
  });

  it("verifies an existing failed owner before activating in place", async () => {
    const failed = manifest({ status: "failed", created_at: "2026-01-01T00:00:00.000Z" });
    const fakeR2 = r2({
      [`index/by-url/${URL_HASH}`]: JSON.stringify({ id: "rd_a", key_prefix: KEY_PREFIX }),
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed),
    });
    const existing = target({
      target: { ...target().target, createdAt: failed.created_at, manifest: failed },
      freshActivation: {
        kind: "verify-existing-failed",
        expected: {
          id: "rd_a",
          keyPrefix: KEY_PREFIX,
          url: "https://example.com/a",
          urlHash: URL_HASH,
          createdAt: failed.created_at,
        },
      },
    });

    const result = await activateFreshTargets([existing], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated).toHaveLength(1);
    const pending = ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!));
    expect(pending.status).toBe("pending");
  });

  it("does not let submitBatch rewrite content for activated fresh targets", async () => {
    const batch = { create: vi.fn(async () => ({ id: "msgbatch_1", processing_status: "in_progress", results_url: null })) };
    const putObject = vi.fn(async () => {});
    const summarize: SummarizeTarget = {
      extracted: { ...target(), contentAlreadyWritten: true },
      similar: [],
      queryEmbedTokens: 0,
      similarity: { count: 0, computed_at: "2026-08-22T00:00:00.000Z" },
    };

    await submitBatch([summarize], {
      model: "m",
      effort: "low",
      batch: batch as any,
      putObject,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(putObject).not.toHaveBeenCalled();
    expect(batch.create).toHaveBeenCalledOnce();
  });
});

// A failed recover manifest: zeroed/failed content descriptors (markFailed), a
// `url` source type, and a real id/url/url_hash that the activation revalidates.
function recoverManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: URL_HASH,
    source_type: "url",
    status: "failed",
    error: { code: "X", message: "prior failure" },
    content_type: "text/html",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

// A re-extracted HTML article in hand (carries real content descriptors that must
// override the failed manifest's zeros in the pending write).
const freshHtml: ExtractedContent = {
  raw: new TextEncoder().encode("<html>body</html>"),
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 17,
  content_sha256: "c".repeat(64),
  markdown: "# A\n\nbody",
};

// A recover target carries no freshActivation policy (recover treats every target
// uniformly) and resolves descriptors from the live manifest + fresh extract.
function recoverTarget(over: Partial<ExtractedTarget> = {}): ExtractedTarget {
  const m = recoverManifest();
  return {
    target: {
      readingId: m.id,
      url: m.url,
      urlHash: m.url_hash,
      keyPrefix: KEY_PREFIX,
      createdAt: m.created_at,
      manifest: m,
    },
    markdown: "# A\n\nbody",
    fresh: freshHtml,
    ...over,
  };
}

describe("activateRecoverTargets", () => {
  it("claims an unclaimed by-url and flips the failed manifest to pending", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "claude-opus-4-8",
      now: () => NOW,
      saveSidecar: vi.fn(async (s) => {
        fakeR2.calls.push(`sidecar:${s.processingStatus}`);
      }),
    });

    expect(result.skipped).toEqual([]);
    expect(result.activated[0]!.contentAlreadyWritten).toBe(true);
    expect(fakeR2.putIfAbsent).toHaveBeenCalledWith(
      `index/by-url/${URL_HASH}`,
      JSON.stringify({ id: "rd_a", key_prefix: KEY_PREFIX }),
      expect.anything(),
    );

    const pending = ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!));
    expect(pending.status).toBe("pending");
    expect(pending.source_type).toBe("url");
    expect(pending.content_status).toBe("captured");
    // content descriptors come from the re-extracted fresh, not the failed zeros
    expect(pending.content_bytes).toBe(freshHtml.content_bytes);
    expect(pending.content_sha256).toBe(freshHtml.content_sha256);
    expect(pending.extracted_bytes).toBe(new TextEncoder().encode("# A\n\nbody").byteLength);
    expect(pending.active_attempt).toMatchObject({
      id: "batch_rd_a",
      trigger: "reprocess",
      status: "running",
      stage: "summarize",
      started_at: NOW,
    });

    // by-id pointer + a pending list row
    expect(JSON.parse(fakeR2.store.get("index/by-id/rd_a")!)).toEqual({ id: "rd_a", key_prefix: KEY_PREFIX });
    expect(JSON.parse(fakeR2.store.get("index/list.json")!).items[0]).toMatchObject({
      id: "rd_a",
      status: "pending",
    });
  });

  it("is idempotent for an already-owned by-url: proceeds without a claim write", async () => {
    const failed = recoverManifest();
    const ownedPointer = JSON.stringify({ id: "rd_a", key_prefix: KEY_PREFIX });
    const fakeR2 = r2({
      [`index/by-url/${URL_HASH}`]: ownedPointer,
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed),
    });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.skipped).toEqual([]);
    expect(result.activated).toHaveLength(1);
    // owns-slot branch never writes/overwrites the pointer
    expect(fakeR2.putIfAbsent).not.toHaveBeenCalled();
    const pointer = JSON.parse(fakeR2.store.get(`index/by-url/${URL_HASH}`)!);
    expect(Object.keys(pointer).sort()).toEqual(["id", "key_prefix"]);
    expect(pointer).toEqual({ id: "rd_a", key_prefix: KEY_PREFIX });
    expect(JSON.parse(fakeR2.store.get("index/list.json")!).items).toHaveLength(1);
  });

  it("proceeds when putIfAbsent loses but the winning pointer is ours (concurrent identical claim)", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });
    // getByUrl is initially null, so activation attempts the claim; putIfAbsent
    // loses, but a concurrent writer wrote the identical {id, key_prefix}, so the
    // re-read equals ours → proceed (idempotent), not a "claimed by another" skip.
    fakeR2.putIfAbsent = vi.fn(async (key: string, body: Uint8Array | string) => {
      fakeR2.store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      return false;
    }) as any;

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.skipped).toEqual([]);
    expect(result.activated).toHaveLength(1);
    expect(ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!)).status).toBe("pending");
  });

  it("skips a by-url owned by a different reading without clobbering it", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({
      [`index/by-url/${URL_HASH}`]: JSON.stringify({ id: "rd_other", key_prefix: "readings/kp-other" }),
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed),
    });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "rd_a", status: "skipped", reason: "by-url owned by a different reading" },
    ]);
    // foreign pointer untouched, our manifest left failed (no pending write)
    expect(JSON.parse(fakeR2.store.get(`index/by-url/${URL_HASH}`)!).id).toBe("rd_other");
    expect(ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!)).status).toBe("failed");
  });

  it("skips a damaged by-url pointer without writing", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({
      [`index/by-url/${URL_HASH}`]: "{not json",
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed),
    });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "rd_a", status: "skipped", reason: "by-url pointer is damaged" },
    ]);
    expect(fakeR2.putIfAbsent).not.toHaveBeenCalled();
    expect(ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!)).status).toBe("failed");
  });

  it("skips when the live manifest no longer belongs to this reading", async () => {
    const fakeR2 = r2({
      [`index/by-url/${URL_HASH}`]: JSON.stringify({ id: "rd_a", key_prefix: KEY_PREFIX }),
      // live manifest moved to a different id (changed before activation)
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(recoverManifest({ id: "rd_moved" })),
    });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "rd_a", status: "skipped", reason: "reading changed before activation" },
    ]);
    // pre-existing pointer (not created by this run) is left intact
    expect(fakeR2.delete).not.toHaveBeenCalled();
    expect(JSON.parse(fakeR2.store.get(`index/by-url/${URL_HASH}`)!)).toEqual({ id: "rd_a", key_prefix: KEY_PREFIX });
  });

  it("releases a self-created claim when revalidation then fails (no stranded pointer)", async () => {
    // Unclaimed slot, so this run claims it via putIfAbsent; but the live manifest
    // has since moved to a different id, so revalidation fails. The claim we just
    // wrote must be released — when every target skips, the sidecar is cleared and
    // no write phase would otherwise repair the stale pointer.
    const fakeR2 = r2({
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(recoverManifest({ id: "rd_moved" })),
    });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "rd_a", status: "skipped", reason: "reading changed before activation" },
    ]);
    // the eager claim it created was rolled back — no stranded by-url pointer
    expect(fakeR2.delete).toHaveBeenCalledWith(`index/by-url/${URL_HASH}`);
    expect(fakeR2.store.has(`index/by-url/${URL_HASH}`)).toBe(false);
  });

  it("preserves source_type and the original created_at on the pending flip", async () => {
    const failed = recoverManifest({ created_at: "2025-03-04T05:06:07.000Z" });
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });
    const t = recoverTarget();
    t.target.createdAt = failed.created_at;
    t.target.manifest = failed;

    await activateRecoverTargets([t], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    const pending = ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!));
    expect(pending.source_type).toBe("url");
    expect(pending.created_at).toBe("2025-03-04T05:06:07.000Z");
    expect(pending.updated_at).toBe(NOW);
  });

  it("preserves a markdown source_type on the pending flip", async () => {
    const failed = recoverManifest({ source_type: "markdown" });
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });
    const t = recoverTarget();
    t.target.manifest = failed;

    await activateRecoverTargets([t], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    const pending = ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!));
    expect(pending.source_type).toBe("markdown");
  });

  it("saves the activating sidecar before the first by-url claim or write", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });

    await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async (s) => {
        fakeR2.calls.push(`sidecar:${s.processingStatus}`);
      }),
    });

    const sidecarIdx = fakeR2.calls.indexOf("sidecar:activating");
    const firstWriteIdx = fakeR2.calls.findIndex((c) => c.startsWith("putIfAbsent:") || c.startsWith("put:"));
    expect(sidecarIdx).toBeGreaterThanOrEqual(0);
    expect(sidecarIdx).toBeLessThan(firstWriteIdx);
  });

  it("is idempotent across a re-run: single by-url, by-id, and list row", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });
    const deps = {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    };

    await activateRecoverTargets([recoverTarget()], deps);
    await activateRecoverTargets([recoverTarget()], deps);

    expect([...fakeR2.store.keys()].filter((k) => k.startsWith("index/by-url/"))).toHaveLength(1);
    expect([...fakeR2.store.keys()].filter((k) => k.startsWith("index/by-id/"))).toHaveLength(1);
    expect(JSON.parse(fakeR2.store.get("index/list.json")!).items).toHaveLength(1);
  });

  it("writes the re-extracted content and marks contentAlreadyWritten", async () => {
    const failed = recoverManifest();
    const fakeR2 = r2({ [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(failed) });

    const result = await activateRecoverTargets([recoverTarget()], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(result.activated[0]!.contentAlreadyWritten).toBe(true);
    expect(fakeR2.store.get(`${KEY_PREFIX}/raw.html`)).toBe("<html>body</html>");
    expect(fakeR2.store.get(`${KEY_PREFIX}/extracted.md`)).toBe("# A\n\nbody");
  });

  it("takes pending descriptors from a ready manifest when markdown was reused (no fresh)", async () => {
    const ready = recoverManifest({
      status: "ready",
      content_status: "captured",
      content_bytes: 4321,
      content_sha256: "d".repeat(64),
      tldr: "old tldr",
    });
    const fakeR2 = r2({
      [`index/by-url/${URL_HASH}`]: JSON.stringify({ id: "rd_a", key_prefix: KEY_PREFIX }),
      [`${KEY_PREFIX}/manifest.json`]: JSON.stringify(ready),
    });
    const reused = recoverTarget();
    delete reused.fresh; // reused saved markdown, no re-extract

    await activateRecoverTargets([reused], {
      r2: fakeR2 as any,
      model: "m",
      now: () => NOW,
      saveSidecar: vi.fn(async () => {}),
    });

    const pending = ManifestSchema.parse(JSON.parse(fakeR2.store.get(`${KEY_PREFIX}/manifest.json`)!));
    expect(pending.status).toBe("pending");
    expect(pending.content_status).toBe("captured");
    expect(pending.content_bytes).toBe(4321);
    expect(pending.content_sha256).toBe("d".repeat(64));
    // stale summary fields are not carried into the pending
    expect(pending.tldr).toBeUndefined();
    // no content re-written (no fresh)
    expect(fakeR2.store.has(`${KEY_PREFIX}/raw.html`)).toBe(false);
  });
});
