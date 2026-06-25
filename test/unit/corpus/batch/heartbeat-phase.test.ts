import { describe, expect, it, vi } from "vitest";
import { makePendingHeartbeat } from "../../../../scripts/corpus-lib/batch/heartbeat-phase";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";
import type { Sidecar, SidecarTarget } from "../../../../scripts/corpus-lib/batch/types";

const MD = "text/markdown; charset=utf-8";

function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    put: vi.fn(async (key: string, body: Uint8Array | string) => {
      store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getWithEtag: vi.fn(async (key: string) => (store.has(key) ? { body: store.get(key)!, etag: "0" } : null)),
    head: vi.fn(async (key: string) => store.has(key)),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    listKeys: vi.fn(async () => [...store.keys()]),
  };
}

function target(over: Partial<SidecarTarget> = {}): SidecarTarget {
  return {
    customId: "rd_a",
    keyPrefix: "readings/2026/01/01T000000Z-rd_a",
    id: "rd_a",
    url: "https://example.com/a",
    urlHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceType: "markdown",
    contentType: MD,
    contentStatus: "captured",
    contentBytes: 10,
    contentSha256: "b".repeat(64),
    queryEmbedTokens: 0,
    ...over,
  };
}

function sidecar(targets: SidecarTarget[]): Sidecar {
  return { batchId: "msgbatch_x", model: "m", processingStatus: "in_progress", resultsUrl: null, targets };
}

function pendingJson(keyPrefix: string, updatedAt: string): string {
  const m = {
    id: keyPrefix.split("-").pop()!,
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    source_type: "markdown",
    status: "pending",
    content_type: MD,
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: updatedAt,
  } as Manifest;
  return JSON.stringify(ManifestSchema.parse(m));
}

// A clock that advances by `stepMs` each call.
function advancingNow(startIso: string, stepMs: number): () => string {
  let ms = Date.parse(startIso);
  return () => {
    const iso = new Date(ms).toISOString();
    ms += stepMs;
    return iso;
  };
}

describe("makePendingHeartbeat", () => {
  it("sweeps immediately on the first tick, then gates subsequent sweeps to the interval, preserving other fields", async () => {
    const kp = "readings/2026/01/01T000000Z-rd_a";
    const r2 = fakeR2({ [`${kp}/manifest.json`]: pendingJson(kp, "2026-01-01T00:00:00.000Z") });
    // now() advances 200s per tick; gate intervalMs = 300_000 (300s).
    const beat = makePendingHeartbeat(sidecar([target()]), {
      r2,
      now: advancingNow("2026-01-01T00:00:00.000Z", 200_000),
      intervalMs: 300_000,
    });

    await beat(); // t=0s   → FIRST tick always sweeps (resume safety)
    expect(r2.put).toHaveBeenCalledTimes(1);
    await beat(); // t=200s (only 200s < 300s since last sweep → no sweep)
    expect(r2.put).toHaveBeenCalledTimes(1);
    await beat(); // t=400s (>= 300s since last sweep → sweep)
    expect(r2.put).toHaveBeenCalledTimes(2);

    const m = ManifestSchema.parse(JSON.parse(r2.store.get(`${kp}/manifest.json`)!));
    expect(m.status).toBe("pending");
    expect(m.updated_at).not.toBe("2026-01-01T00:00:00.000Z"); // refreshed
    expect(m.created_at).toBe("2026-01-01T00:00:00.000Z"); // preserved
    expect(m.content_sha256).toBe("b".repeat(64)); // preserved
  });

  it("refreshes an already-stale pending on the very first tick (resume after a long sleep — issue #66)", async () => {
    // A resumed run: the manifest was last stamped by a previous process long ago
    // (older than any TTL). The heartbeat must refresh it on the FIRST poll, not a
    // full interval later, or an online submit would reprocess the stale pending.
    const kp = "readings/2026/01/01T000000Z-rd_a";
    const r2 = fakeR2({ [`${kp}/manifest.json`]: pendingJson(kp, "2026-01-01T00:00:00.000Z") });
    const beat = makePendingHeartbeat(sidecar([target()]), {
      r2,
      // Resume happens hours later.
      now: advancingNow("2026-01-01T05:00:00.000Z", 1_000),
      intervalMs: 300_000,
    });

    await beat(); // first tick on resume

    expect(r2.put).toHaveBeenCalledTimes(1);
    const m = ManifestSchema.parse(JSON.parse(r2.store.get(`${kp}/manifest.json`)!));
    expect(Date.parse(m.updated_at)).toBe(Date.parse("2026-01-01T05:00:00.000Z"));
  });

  it("never touches a ready-kept target (preserveReadyManifest set)", async () => {
    const kp = "readings/2026/01/01T000000Z-rd_ready";
    const ready = JSON.stringify(
      ManifestSchema.parse({
        id: "rd_ready",
        url: "https://example.com/a",
        url_hash: "a".repeat(64),
        source_type: "markdown",
        status: "ready",
        title: "T",
        tldr: "x",
        tags: [],
        keywords: [],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "s",
        content_type: MD,
        content_status: "captured",
        content_bytes: 10,
        content_sha256: "b".repeat(64),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } as Manifest),
    );
    const r2 = fakeR2({ [`${kp}/manifest.json`]: ready });
    const beat = makePendingHeartbeat(
      sidecar([target({ id: "rd_ready", keyPrefix: kp, preserveReadyManifest: JSON.parse(ready) as Manifest })]),
      { r2, now: advancingNow("2026-01-01T00:00:00.000Z", 1_000_000), intervalMs: 1 },
    );

    await beat();
    await beat();
    expect(r2.put).not.toHaveBeenCalled();
    expect(r2.store.get(`${kp}/manifest.json`)).toBe(ready);
  });

  it("skips a target whose manifest is no longer pending", async () => {
    const kp = "readings/2026/01/01T000000Z-rd_a";
    const failed = JSON.stringify(
      ManifestSchema.parse({
        id: "rd_a",
        url: "https://example.com/a",
        url_hash: "a".repeat(64),
        source_type: "markdown",
        status: "failed",
        error: { code: "X", message: "boom" },
        content_type: MD,
        content_status: "failed",
        content_bytes: 0,
        content_sha256: "b".repeat(64),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } as Manifest),
    );
    const r2 = fakeR2({ [`${kp}/manifest.json`]: failed });
    const beat = makePendingHeartbeat(sidecar([target()]), {
      r2,
      now: advancingNow("2026-01-01T00:00:00.000Z", 1_000_000),
      intervalMs: 1,
    });

    await beat();
    await beat();
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("skips a pending whose manifest has a live foreign active_attempt (online reprocess in flight)", async () => {
    // Batch was down long enough for an online submit to start reprocessing this
    // id → a pending with a running active_attempt the online worker owns + is
    // CASing. Re-stamping would change the etag under its replaceManifestIfCurrent
    // and make it drop a good result, so the heartbeat must leave it alone.
    const kp = "readings/2026/01/01T000000Z-rd_a";
    const onlinePending = JSON.stringify(
      ManifestSchema.parse({
        id: "rd_a",
        url: "https://example.com/a",
        url_hash: "a".repeat(64),
        source_type: "markdown",
        status: "pending",
        active_attempt: { id: "at_online1", trigger: "submit", status: "running", started_at: "2026-01-01T00:00:00.000Z" },
        content_type: MD,
        content_status: "captured",
        content_bytes: 10,
        content_sha256: "b".repeat(64),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } as Manifest),
    );
    const r2 = fakeR2({ [`${kp}/manifest.json`]: onlinePending });
    const beat = makePendingHeartbeat(sidecar([target()]), {
      r2,
      now: advancingNow("2026-01-01T05:00:00.000Z", 1_000_000),
      intervalMs: 1,
    });

    await beat();
    await beat();
    expect(r2.put).not.toHaveBeenCalled();
    expect(r2.store.get(`${kp}/manifest.json`)).toBe(onlinePending);
  });
});
