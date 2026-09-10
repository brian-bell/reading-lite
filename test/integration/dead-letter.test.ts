import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDeadLettered, type ProcessReadingArgs } from "../../src/process-reading";
import worker, { type Env } from "../../src/index";
import type { Services } from "../../src/services";
import { manifestToIndexItem } from "../../src/modules/stores/reading-store";
import { parseTenantId } from "../../src/control-plane/ids";
import { tenantUsageFor } from "../../src/control-plane/tenant-usage-guard";
import {
  FOUNDER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  insertQuotaTenant,
  OTHER_TOKEN_ID,
  otherTenant,
  PUBLIC_LOOKUP,
  testReadingStore,
} from "../helpers/tenant-fixtures";
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
    lookup: PUBLIC_LOOKUP,
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

  it("writes nothing when the manifest is confirmed absent from the tenant's namespace", async () => {
    const reader = testReadingStore(env);
    await reader.writeExtracted(KEY_PREFIX, "# leftover without a tombstone");

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    // No tombstone: confirmed-absent is a mismatched envelope, not a purge.
    // Do not sweep a prefix this tenant may not own as a purged reading.
    expect(await (await reader.readExtracted(KEY_PREFIX))?.text()).toBe("# leftover without a tombstone");
    expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
    expect(await reader.findListIndexItem(READING_ID)).toBeNull();
  });

  it("sweeps prefix residue when a purge tombstone is present and the manifest is already gone", async () => {
    const reader = testReadingStore(env);
    await reader.writeExtracted(KEY_PREFIX, "# leftover after purge deleted the manifest");
    await reader.writeAttempt(KEY_PREFIX, {
      id: `at_${READING_ID}`,
      trigger: "reprocess",
      status: "running",
      started_at: "2026-05-07T12:00:05.000Z",
      reading_id: READING_ID,
      url: DLQ_URL,
      url_hash: DLQ_URL_HASH,
      key_prefix: KEY_PREFIX,
      events: [{ stage: "queued", status: "started", at: "2026-05-07T12:00:05.000Z" }],
    });
    await reader.writePurgeTombstone(READING_ID);

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
    expect(await reader.readExtracted(KEY_PREFIX)).toBeNull();
    expect(await reader.listAttempts(KEY_PREFIX)).toEqual([]);
    expect(await reader.listReadingObjects(KEY_PREFIX)).toEqual([]);
  });

  it("recovers full purged state — prefix, list row — and does not recreate failed objects when a purge tombstone is present", async () => {
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));
    await reader.writeExtracted(KEY_PREFIX, "# leftover after purge sweep");
    await reader.writeAttempt(KEY_PREFIX, {
      id: `at_${READING_ID}`,
      trigger: "reprocess",
      status: "running",
      started_at: "2026-05-07T12:00:05.000Z",
      reading_id: READING_ID,
      url: DLQ_URL,
      url_hash: DLQ_URL_HASH,
      key_prefix: KEY_PREFIX,
      events: [{ stage: "queued", status: "started", at: "2026-05-07T12:00:05.000Z" }],
    });
    await reader.writePurgeTombstone(READING_ID);

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
    expect(await reader.readExtracted(KEY_PREFIX)).toBeNull();
    expect(await reader.listAttempts(KEY_PREFIX)).toEqual([]);
    expect(await reader.listReadingObjects(KEY_PREFIX)).toEqual([]);
    // The list row goes too (#357 review P1): a confirmed tombstone means the
    // reading is committed to deletion, and this consumer may be the only
    // writer left that can remove a row the purge cannot see — its removal is
    // ungated by attempt ownership, mirroring purgeReading's own id-match rule.
    expect(await reader.findListIndexItem(READING_ID)).toBeNull();
  });

  it("fail-opens and writes the failed manifest when the purge-tombstone lookup throws", async () => {
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const tombstoneKey = `u/${FOUNDER_TENANT_ID}/index/deleted/${READING_ID}`;
    const bucket = env.READINGS_BUCKET;
    let threw = false;
    const flaky = {
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      head: async (key: string) => {
        if (key === tombstoneKey) {
          threw = true;
          throw new Error("tombstone HEAD failed");
        }
        return bucket.head(key);
      },
      list: bucket.list.bind(bucket),
    } as unknown as R2Bucket;

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await markDeadLettered(
        args(),
        { ...(env as unknown as Env), READINGS_BUCKET: flaky },
        services(),
        founderTenant(),
      );
    } finally {
      consoleErr.mockRestore();
    }

    expect(threw).toBe(true);
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    expect((await reader.findListIndexItem(READING_ID))?.status).toBe("failed");
  });

  it("writes nothing when the tenant is already deleting", async () => {
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));
    await env.CONTROL_PLANE.prepare("UPDATE users SET status = 'deleting' WHERE id = ?")
      .bind(FOUNDER_TENANT_ID)
      .run();
    try {
      await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());
      expect((await reader.readManifest(KEY_PREFIX))?.status).toBe("pending");
      expect((await reader.findListIndexItem(READING_ID))?.status).toBe("pending");
    } finally {
      await env.CONTROL_PLANE.prepare("UPDATE users SET status = 'active' WHERE id = ?")
        .bind(FOUNDER_TENANT_ID)
        .run();
    }
  });

  it("fail-opens and writes the failed manifest when the tenant-status lookup throws", async () => {
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const workerEnv = env as unknown as Env;
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: {
        prepare(sql: string) {
          const stmt = workerEnv.CONTROL_PLANE.prepare(sql);
          if (!/SELECT\s+status\s+FROM\s+users\s+WHERE\s+id\s*=\s*\?/i.test(sql)) return stmt;
          return {
            bind(...params: unknown[]) {
              const bound = stmt.bind(...params);
              return {
                first: async () => {
                  throw new Error("D1 hiccup");
                },
                run: () => bound.run(),
                all: () => bound.all(),
              };
            },
          };
        },
      } as unknown as D1Database,
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await markDeadLettered(args(), wrapped, services(), founderTenant());
    } finally {
      consoleErr.mockRestore();
    }

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    expect(after?.error?.retryable).toBe(true);
    expect((await reader.findListIndexItem(READING_ID))?.status).toBe("failed");
  });

  it("still marks when the manifest read fails transiently — an error is not confirmed absence", async () => {
    const reader = testReadingStore(env);
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    // The manifest exists, but the ownership-guard read hits a one-off R2
    // error. The DLQ message is acked either way, so treating the error as
    // absence would silently strand the reading; the mark must fall through
    // and still land.
    const manifestKey = `u/${FOUNDER_TENANT_ID}/${KEY_PREFIX}/manifest.json`;
    const bucket = env.READINGS_BUCKET;
    let threw = false;
    const flaky = {
      get: async (key: string, opts?: unknown) => {
        if (key === manifestKey && !threw) {
          threw = true;
          throw new Error("transient R2 read failure");
        }
        return bucket.get(key, opts as never);
      },
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket),
    } as unknown as R2Bucket;

    await markDeadLettered(
      args(),
      { ...(env as unknown as Env), READINGS_BUCKET: flaky },
      services(),
      founderTenant(),
    );

    expect(threw).toBe(true);
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    const item = await reader.findListIndexItem(READING_ID);
    expect(item?.status).toBe("failed");
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

  it("releases a held reading slot when retries are exhausted", async () => {
    const { tenant, usage, reader } = await quotaUsage();
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    const opId = `at_${READING_ID}`;
    expect(await usage.reserveReading(opId, Date.now())).toEqual({ ok: true });

    await markDeadLettered(args(), env as unknown as Env, services(), tenant);

    expect((await reader.readManifest(KEY_PREFIX))?.status).toBe("failed");
    expect(await usage.reserveReading("at_after_dlq", Date.now())).toEqual({ ok: true });
  });

  it("releases a held slot on a confirmed-absent dead-letter", async () => {
    const { tenant, usage } = await quotaUsage();
    expect(await usage.reserveReading(`at_${READING_ID}`, Date.now())).toEqual({ ok: true });

    await markDeadLettered(args(), env as unknown as Env, services(), tenant);

    expect(await usage.reserveReading("at_after_absent", Date.now())).toEqual({ ok: true });
  });

  it("releases a held slot when a purge tombstone is present", async () => {
    const { tenant, usage, reader } = await quotaUsage();
    await reader.writeManifest(KEY_PREFIX, pendingManifest());
    await reader.writePurgeTombstone(READING_ID);
    expect(await usage.reserveReading(`at_${READING_ID}`, Date.now())).toEqual({ ok: true });

    await markDeadLettered(args(), env as unknown as Env, services(), tenant);

    expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
    expect(await usage.reserveReading("at_after_tombstone", Date.now())).toEqual({ ok: true });
  });

  it("releases a held slot when a stale dead-lettered attempt no longer owns the reading", async () => {
    const { tenant, usage, reader } = await quotaUsage();
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
    expect(await usage.reserveReading("at_ORIGINAL", Date.now())).toEqual({ ok: true });

    await markDeadLettered(
      args({ attemptId: "at_ORIGINAL" }),
      env as unknown as Env,
      services(),
      tenant,
    );

    expect((await reader.readManifest(KEY_PREFIX))?.title).toBe("v2 (newer attempt)");
    expect(await usage.reserveReading("at_after_stale", Date.now())).toEqual({ ok: true });
  });
});

async function quotaUsage() {
  const { tenantId } = await insertQuotaTenant(env as unknown as Env, {
    submissions_per_hour: 20,
    monthly_readings: 1,
  });
  const parsed = parseTenantId(tenantId);
  if (!parsed) throw new Error(`expected tenant id, got ${tenantId}`);
  const tenant = { tenantId: parsed };
  return {
    tenant,
    usage: tenantUsageFor(env as unknown as Env, tenantId),
    reader: testReadingStore(env, tenant),
  };
}

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

  it("marks only the admitted tenant's matching DLQ artifact", async () => {
    await insertSecondTenant(env as unknown as Env);
    const founder = testReadingStore(env, founderTenant());
    const other = testReadingStore(env, otherTenant());
    const founderManifest: Manifest = { ...pendingManifest(), title: "founder pending" };
    const otherManifest: Manifest = { ...pendingManifest(), title: "other pending" };
    await founder.writeManifest(KEY_PREFIX, founderManifest);
    await founder.appendOrReplaceListIndexItem(manifestToIndexItem(founderManifest, KEY_PREFIX));
    await other.writeManifest(KEY_PREFIX, otherManifest);
    await other.appendOrReplaceListIndexItem(manifestToIndexItem(otherManifest, KEY_PREFIX));

    const msg = {
      ...dlqMessage(),
      body: {
        version: 1,
        tenant: otherTenant(),
        actor: { kind: "api_token" as const, credentialId: OTHER_TOKEN_ID },
        job: args(),
      },
    } as Message<unknown>;
    await worker.queue({
      queue: "reading-lite-dlq", messages: [msg],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(), retryAll: vi.fn(),
    }, env as Env);

    // Positive control: the admitted owner receives the terminal failure.
    expect((await other.readManifest(KEY_PREFIX))?.status).toBe("failed");
    expect((await other.findListIndexItem(READING_ID))?.status).toBe("failed");
    // A same-id artifact under the other tenant is not a DLQ target.
    expect((await founder.readManifest(KEY_PREFIX))?.status).toBe("pending");
    expect((await founder.readManifest(KEY_PREFIX))?.title).toBe("founder pending");
    expect((await founder.findListIndexItem(READING_ID))?.status).toBe("pending");
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks a cross-tenant actor envelope before processing or mutating its claimed tenant", async () => {
    await insertSecondTenant(env as unknown as Env);
    const founder = testReadingStore(env, founderTenant());
    const manifest: Manifest = { ...pendingManifest(), title: "founder pending" };
    await founder.writeManifest(KEY_PREFIX, manifest);
    await founder.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const msg = {
      ...dlqMessage(),
      body: {
        version: 1,
        tenant: founderTenant(),
        actor: { kind: "api_token" as const, credentialId: OTHER_TOKEN_ID },
        job: args(),
      },
    } as Message<unknown>;
    await worker.queue({
      queue: "reading-lite", messages: [msg],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(), retryAll: vi.fn(),
    }, env as Env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect((await founder.readManifest(KEY_PREFIX))?.status).toBe("pending");
    expect((await founder.readManifest(KEY_PREFIX))?.title).toBe("founder pending");
    expect((await founder.findListIndexItem(READING_ID))?.status).toBe("pending");
    expect(await testReadingStore(env, otherTenant()).readManifest(KEY_PREFIX)).toBeNull();
  });
});
