import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDeadLettered, type ProcessReadingArgs } from "../../src/process-reading";
import worker, { type Env } from "../../src/index";
import type { Services } from "../../src/services";
import { manifestToIndexItem, ReadingStore } from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";

const KEY_PREFIX = "readings/2026/05/07T120000Z-rd_DLQ";

function services(): Services {
  return {
    fetch: (() => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    now: () => "2026-05-07T13:00:00.000Z",
    newId: () => "rd_DLQ",
  };
}

function args(extra: Partial<ProcessReadingArgs> = {}): ProcessReadingArgs {
  return {
    id: "rd_DLQ",
    url: "https://example.com/dlq",
    urlHash: "d".repeat(64),
    createdAt: "2026-05-07T12:00:00.000Z",
    keyPrefix: KEY_PREFIX,
    trigger: "reprocess",
    ...extra,
  };
}

function pendingManifest(): Manifest {
  return {
    id: "rd_DLQ",
    url: "https://example.com/dlq",
    url_hash: "d".repeat(64),
    source_type: "url",
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-05-07T12:00:00.000Z",
    updated_at: "2026-05-07T12:00:05.000Z",
    active_attempt: {
      id: "at_rd_DLQ",
      trigger: "reprocess",
      status: "running",
      stage: "queued",
      started_at: "2026-05-07T12:00:05.000Z",
    },
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) await env.READINGS_BUCKET.delete(obj.key);
}

describe("markDeadLettered", () => {
  beforeEach(clearBucket);

  it("flips a stranded pending reading to a retryable failed manifest + updates the index", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    await markDeadLettered(args(), env as unknown as Env, services());

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    expect(after?.error?.retryable).toBe(true);

    const item = await reader.findListIndexItem("rd_DLQ");
    expect(item?.status).toBe("failed");

    // Failed readings must stay re-submittable: no by-url pointer.
    expect(await reader.readByUrlPointer("d".repeat(64))).toBeNull();
  });

  it("rolls back to the preserved ready snapshot when a reprocess of a ready reading is dead-lettered", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const ready: Manifest = { ...pendingManifest(), status: "ready", content_status: "captured" };
    await reader.writeManifest(KEY_PREFIX, pendingManifest());

    await markDeadLettered(args({ preserveReadyManifest: ready }), env as unknown as Env, services());

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("ready");
    expect(after?.active_attempt).toBeUndefined();
    expect(after?.last_attempt?.status).toBe("failed");
    expect(after?.last_attempt?.error?.code).toBe("QueueRetriesExhaustedError");
  });

  it("skips a stale dead-lettered message whose attempt was superseded by a newer one", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    // The reading was reprocessed again (a newer attempt) and is now ready (v2)
    // while the original message sat in the DLQ pipeline.
    const v2: Manifest = {
      ...pendingManifest(),
      status: "ready",
      title: "v2 (newer attempt)",
      active_attempt: undefined,
      last_attempt: {
        id: "at_NEWER",
        trigger: "reprocess",
        status: "succeeded",
        started_at: "2026-05-07T12:30:00.000Z",
      },
    };
    await reader.writeManifest(KEY_PREFIX, v2);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(v2, KEY_PREFIX));

    const v1: Manifest = { ...pendingManifest(), status: "ready", title: "v1 (stale)" };
    await markDeadLettered(
      args({ attemptId: "at_ORIGINAL", preserveReadyManifest: v1 }),
      env as unknown as Env,
      services(),
    );

    // The stale message must not roll back to v1 over the newer v2.
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("ready");
    expect(after?.title).toBe("v2 (newer attempt)");
    expect(after?.last_attempt?.id).toBe("at_NEWER");
  });
});

function dlqMessage(): Message<ProcessReadingArgs> {
  return {
    id: "m_dlq",
    timestamp: new Date(),
    body: args(),
    attempts: 4,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<ProcessReadingArgs>;
}

describe("queue() dead-letter routing", () => {
  beforeEach(clearBucket);

  it("routes a reading-lite-dlq batch through the mark path (not processReading) and acks", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const msg = dlqMessage();
    const batch = {
      queue: "reading-lite-dlq",
      messages: [msg],
    } as unknown as MessageBatch<ProcessReadingArgs>;

    // markDeadLettered touches only R2, so the real queue() handler runs here
    // with no network. If the branch ever fell through to dispatchQueueMessage,
    // processReading would try to fetch and the manifest would not flip cleanly.
    await worker.queue(batch, env as unknown as Env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
  });
});
