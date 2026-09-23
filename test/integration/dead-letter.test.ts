import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDeadLettered, type ProcessReadingArgs } from "../../src/process-reading";
import worker, { type Env } from "../../src/index";
import type { Services } from "../../src/services";
import { manifestToIndexItem } from "../../src/modules/stores/list-items";
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
} from "../helpers/tenant-fixtures";
import { rowStore } from "../helpers/row-store";
import { PgReadingStore } from "../../src/modules/stores/postgres/reading-store";
import type { Manifest } from "../../src/schemas/manifest";

import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { testControlPlane } from "../helpers/control-plane-db";
import { interceptSql, TENANT_STATUS_LOOKUP } from "../helpers/sql-faults";

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
    const reader = rowStore();
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));
    const pointer = { id: READING_ID, key_prefix: KEY_PREFIX };
    await reader.writeByUrlPointer(DLQ_URL_HASH, pointer);

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    expect(after?.error?.retryable).toBe(true);

    const item = await reader.findListIndexItem(READING_ID);
    expect(item?.status).toBe("failed");

    // Failed owners reprocess in place: the by-url claim survives the DLQ mark
    // so the next submit of this URL lands on this reading, not a new one.
    expect(await reader.readByUrlPointer(DLQ_URL_HASH)).toEqual(pointer);
  });

  it("writes nothing, and sweeps nothing it does not own, when the reading is confirmed absent", async () => {
    const reader = rowStore();
    const foreign = `${KEY_PREFIX}/extracted.md`;
    await reader.readings.content.put(foreign, "# not this attempt's", "text/markdown; charset=utf-8");

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    // No row means the reading was purged, or the envelope names a reading
    // this tenant never had. Either way only this attempt's own revision
    // prefix may be swept, so an object outside it is left alone.
    expect(await (await reader.readings.content.get(foreign))?.text()).toBe("# not this attempt's");
    expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
    expect(await reader.findListIndexItem(READING_ID)).toBeNull();
  });

  it("sweeps its own residue when the reading was purged", async () => {
    const reader = rowStore();
    await reader.readings.content.put(`${KEY_PREFIX}/revisions/at_${READING_ID}/extracted.md`, "# leftover after the purge", "text/markdown; charset=utf-8");
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

  it("sweeps its own residue and recreates nothing when the reading was purged after it started", async () => {
    const reader = rowStore();
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));
    // Written after the purge's own sweep, as a late consumer would.
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
    await reader.readings.content.put(`${KEY_PREFIX}/revisions/at_${READING_ID}/extracted.md`, "# leftover after purge sweep", "text/markdown; charset=utf-8");

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

    expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
    expect(await reader.readExtracted(KEY_PREFIX)).toBeNull();
    expect(await reader.listAttempts(KEY_PREFIX)).toEqual([]);
    expect(await reader.listReadingObjects(KEY_PREFIX)).toEqual([]);
    // Purged means gone: nothing is recreated, not even a failed row.
    expect(await reader.findListIndexItem(READING_ID)).toBeNull();
  });

  it("writes nothing when the tenant is already deleting", async () => {
    const reader = rowStore();
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));
    await testControlPlane(env).run("UPDATE users SET status = 'deleting' WHERE id = ?", FOUNDER_TENANT_ID);
    try {
      await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());
      expect((await reader.readManifest(KEY_PREFIX))?.status).toBe("pending");
      expect((await reader.findListIndexItem(READING_ID))?.status).toBe("pending");
    } finally {
      await testControlPlane(env).run("UPDATE users SET status = 'active' WHERE id = ?", FOUNDER_TENANT_ID);
    }
  });

  it("fail-opens and writes the failed manifest when the tenant-status lookup throws", async () => {
    const reader = rowStore();
    const manifest = pendingManifest();
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const lookup = interceptSql(TENANT_STATUS_LOOKUP, () => new Error("database hiccup"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());
    } finally {
      consoleErr.mockRestore();
      lookup.mockRestore();
    }

    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    expect(after?.error?.retryable).toBe(true);
    expect((await reader.findListIndexItem(READING_ID))?.status).toBe("failed");
  });

  it("still marks when the reading's row read fails transiently — an error is not confirmed absence", async () => {
    const reader = rowStore();
    await reader.writeManifest(KEY_PREFIX, pendingManifest());

    // The reading exists, but the ownership-guard read hits a one-off database
    // error. The DLQ message is acked either way, so treating the error as
    // absence would silently strand the reading; the mark must fall through
    // and still land.
    const load = PgReadingStore.prototype.loadReadingById;
    let threw = false;
    const spy = vi.spyOn(PgReadingStore.prototype, "loadReadingById").mockImplementation(async function (this: PgReadingStore, id) {
      if (!threw) {
        threw = true;
        throw new Error("transient database read failure");
      }
      return load.call(this, id);
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());
    spy.mockRestore();
    consoleErr.mockRestore();

    expect(threw).toBe(true);
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("QueueRetriesExhaustedError");
    const item = await reader.findListIndexItem(READING_ID);
    expect(item?.status).toBe("failed");
  });

  it("keeps a published reading published when its reprocess is dead-lettered", async () => {
    const reader = rowStore();
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
    // A reprocess leaves a published reading `ready` with a running attempt:
    // its revision holds the summary, so there is no snapshot to carry.
    await reader.writeManifest(KEY_PREFIX, { ...ready, connections: [], active_attempt: pendingManifest().active_attempt });

    await markDeadLettered(args(), env as unknown as Env, services(), founderTenant());

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
    const reader = rowStore();
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

    await markDeadLettered(
      args({ attemptId: "at_ORIGINAL" }),
      env as unknown as Env,
      services(),
      founderTenant(),
    );

    // The stale message must not touch the reading the newer attempt published.
    const after = await reader.readManifest(KEY_PREFIX);
    expect(after?.status).toBe("ready");
    expect(after?.title).toBe("v2 (newer attempt)");
    expect(after?.last_attempt?.id).toBe("at_NEWER");
  });

  it.each([
    {
      state: "pending manifest",
      attemptId: undefined,
      seed: async (reader: ReturnType<typeof rowStore>) => {
        await reader.writeManifest(KEY_PREFIX, pendingManifest());
      },
      check: async (reader: ReturnType<typeof rowStore>) => {
        expect((await reader.readManifest(KEY_PREFIX))?.status).toBe("failed");
      },
    },
    {
      state: "confirmed-absent manifest",
      attemptId: undefined,
      seed: async () => {},
      check: async (reader: ReturnType<typeof rowStore>) => {
        expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
      },
    },
    {
      state: "purge tombstone",
      attemptId: undefined,
      seed: async (reader: ReturnType<typeof rowStore>) => {
        await reader.writeManifest(KEY_PREFIX, pendingManifest());
        await reader.writePurgeTombstone(READING_ID);
      },
      check: async (reader: ReturnType<typeof rowStore>) => {
        expect(await reader.readManifest(KEY_PREFIX)).toBeNull();
      },
    },
    {
      state: "stale attempt that no longer owns the reading",
      attemptId: "at_ORIGINAL",
      seed: async (reader: ReturnType<typeof rowStore>) => {
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
      },
      check: async (reader: ReturnType<typeof rowStore>) => {
        expect((await reader.readManifest(KEY_PREFIX))?.title).toBe("v2 (newer attempt)");
      },
    },
  ])("releases a held reading slot on dead-letter: $state", async ({ attemptId, seed, check }) => {
    const { tenant, usage, reader } = await quotaUsage();
    await seed(reader);
    const held = attemptId ?? `at_${READING_ID}`;
    expect(await usage.reserveReading(held, Date.now())).toEqual({ ok: true });

    await markDeadLettered(args(attemptId ? { attemptId } : {}), env as unknown as Env, services(), tenant);

    await check(reader);
    expect(await usage.reserveReading("at_after_dlq", Date.now())).toEqual({ ok: true });
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
    reader: rowStore(tenant),
  };
}

function dlqMessage(): Message<unknown> {
  return {
    id: "m_dlq",
    timestamp: new Date(),
    body: {
      version: 1,
      tenant: { tenantId: FOUNDER_TENANT_ID },
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
    const reader = rowStore();
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
    const founder = rowStore(founderTenant());
    const other = rowStore(otherTenant());
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
    const founder = rowStore(founderTenant());
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
    expect(await rowStore(otherTenant()).readManifest(KEY_PREFIX)).toBeNull();
  });
});
