import { describe, expect, it, vi } from "vitest";
import { activateFreshTargets } from "../../../../scripts/corpus-lib/batch/activation-phase";
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
    };

    await submitBatch([summarize], {
      model: "m",
      batch: batch as any,
      putObject,
      saveSidecar: vi.fn(async () => {}),
    });

    expect(putObject).not.toHaveBeenCalled();
    expect(batch.create).toHaveBeenCalledOnce();
  });
});
