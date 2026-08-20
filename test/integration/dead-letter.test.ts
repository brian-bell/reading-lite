import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDeadLettered, type ProcessReadingArgs } from "../../src/process-reading";
import worker, { type Env } from "../../src/index";
import type { Services } from "../../src/services";
import { manifestToIndexItem } from "../../src/modules/stores/reading-store";
import { founderTenant, testReadingStore } from "../helpers/tenant-fixtures";
import type { Manifest } from "../../src/schemas/manifest";

import { buildKeyPrefix } from "../../src/modules/stores/reading-store";

const READING_ID = "rd_0123456780";
const KEY_PREFIX = buildKeyPrefix(READING_ID, "2026-05-07T12:00:00.000Z");
const DLQ_URL = "https://example.com/dlq";
const DLQ_URL_HASH = "b7dada632530beda9d7421510dc770125241cffc112dfdff1db0df8f991ebd78";

function services(): Services {
  return {
    fetch: (() => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    now: () => "2026-05-07T13:00:00.000Z",
    newId: () => READING_ID,
  };
}

function args(extra: Partial<ProcessReadingArgs> = {}): ProcessReadingArgs {
  return {
    id: READING_ID,
    url: DLQ_URL,
    urlHash: DLQ_URL_HASH,
    createdAt: "2026-05-07T12:00:00.000Z",
    keyPrefix: KEY_PREFIX,
    trigger: "reprocess",
    ...extra,
  };
}

function pendingManifest(): Manifest {
  return {
    id: READING_ID,
    url: DLQ_URL,
    url_hash: DLQ_URL_HASH,
    source_type: "url",
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-05-07T12:00:00.000Z",
    updated_at: "2026-05-07T12:00:05.000Z",
    active_attempt: {
      id: `at_${READING_ID}`,
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
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    expect(after?.error?.retryable).toBe(true);

    const item = await reader.findListIndexItem(READING_ID);
    expect(item?.status).toBe("failed");

    // Failed readings must stay re-submittable: no by-url pointer.
    expect(await reader.readByUrlPointer("d".repeat(64))).toBeNull();
  });

  it("rolls back to the preserved ready snapshot when a reprocess of a ready reading is dead-lettered", async () => {
    const reader = testReadingStore(env);
    const ready: Manifest = {
      ...pendingManifest(),
      status: "ready",
      content_status: "captured",
      title: "Preserved Title",
      tldr: "preserved tldr",
      tags: ["alpha", "beta"],
      summary_markdown: "# Preserved\n\nbody",
      active_attempt: undefined,
    };
    await reader.writeManifest(KEY_PREFIX, pendingManifest());

    // The DLQ delivers args as JSON, so preserveReadyManifest reaches
    // markDeadLettered as a parsed plain object, not the live one. Round-trip
    // it the same way to prove the deep fields survive the rollback.
    const queued = JSON.parse(
      JSON.stringify(args({ preserveReadyManifest: ready })),
    ) as ProcessReadingArgs;
    await markDeadLettered(queued, env as unknown as Env, services(), founderTenant());

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("ready");
    expect(after?.active_attempt).toBeUndefined();
    expect(after?.title).toBe("Preserved Title");
    expect(after?.tags).toEqual(["alpha", "beta"]);
    expect(after?.summary_markdown).toBe("# Preserved\n\nbody");
    expect(after?.last_attempt?.status).toBe("failed");
    expect(after?.last_attempt?.error?.code).toBe("QueueRetriesExhaustedError");
  });

  it("skips a stale dead-lettered message whose attempt was superseded by a newer one", async () => {
    const reader = testReadingStore(env);
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
      founderTenant(),
    );

    // The stale message must not roll back to v1 over the newer v2.
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("ready");
    expect(after?.title).toBe("v2 (newer attempt)");
    expect(after?.last_attempt?.id).toBe("at_NEWER");
  });
});

function dlqMessage(): Message<unknown> {
  return {
    id: "m_dlq",
    timestamp: new Date(),
    body: {
      version: 1,
      tenant: { tenantId: "usr_550e8400-e29b-41d4-a716-446655440000" },
      actor: { kind: "api_token" as const, credentialId: "tok_550e8400-e29b-41d4-a716-446655440000" },
      job: args(),
    },
    attempts: 4,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>;
}

describe("queue() dead-letter routing", () => {
  beforeEach(clearBucket);

  it("routes a reading-lite-dlq batch through the mark path (not processReading) and acks", async () => {
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const msg = dlqMessage();
    const batch = {
      queue: "reading-lite-dlq",
      messages: [msg],
    } as unknown as MessageBatch<unknown>;

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
