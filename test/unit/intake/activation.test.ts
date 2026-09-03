import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateAttempt,
  type AttemptActivation,
} from "../../../src/intake/activation";
import { ReadingStore } from "../../../src/modules/stores/reading-store";
import type { ProcessReadingEnvelopeV1 } from "../../../src/control-plane/envelope";
import { createApiTokenPrincipal } from "../../../src/control-plane/principal";
import type { ProcessReadingArgs } from "../../../src/process-reading";
import type { Manifest, ProcessingAttemptSummary } from "../../../src/schemas/manifest";
import { sha256Hex, type Services } from "../../../src/services";

const PRINCIPAL = createApiTokenPrincipal({
  tenantId: "usr_550e8400-e29b-41d4-a716-446655440000",
  userId: "usr_550e8400-e29b-41d4-a716-446655440000",
  tokenId: "tok_550e8400-e29b-41d4-a716-446655440000",
  scopes: ["readings:write"],
});

const NOW = "2026-04-26T20:00:05.000Z";

function services(): Services {
  return {
    fetch: vi.fn() as unknown as typeof fetch,
    lookup: async () => [{ address: "93.184.216.34" }],
    now: () => NOW,
    newId: () => "rd_UNUSED",
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

// A capturing queue stub mirroring installQueueStub() from the integration suite.
function captureQueue(): { queue: Queue<ProcessReadingEnvelopeV1>; sent: ProcessReadingEnvelopeV1[] } {
  const sent: ProcessReadingEnvelopeV1[] = [];
  const queue = {
    send: vi.fn(async (msg: ProcessReadingEnvelopeV1) => {
      sent.push(msg);
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
  return { queue, sent };
}

function rejectingQueue(error: unknown = new Error("queue send failed")): Queue<ProcessReadingEnvelopeV1> {
  return {
    send: vi.fn(async () => {
      throw error;
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
}

const ID = "rd_TEST01";
const URL = "https://example.com/activate";
const URL_HASH = "a".repeat(64);
const KEY_PREFIX = "readings/2026/04/26T200000Z-rd_TEST01";
const ATTEMPT_ID = "at_TEST01";
const STARTED_AT = "2026-04-26T20:00:00.000Z";

function activeAttempt(trigger: "submit" | "reprocess" | "import" = "submit"): ProcessingAttemptSummary {
  return {
    id: ATTEMPT_ID,
    trigger,
    status: "running",
    stage: "queued",
    started_at: STARTED_AT,
  };
}

function pendingManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: ID,
    url: URL,
    url_hash: URL_HASH,
    source_type: "url",
    status: "pending",
    active_attempt: activeAttempt(),
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: STARTED_AT,
    updated_at: STARTED_AT,
    ...overrides,
  };
}

function queueMessage(): ProcessReadingArgs {
  return {
    id: ID,
    url: URL,
    urlHash: URL_HASH,
    createdAt: STARTED_AT,
    keyPrefix: KEY_PREFIX,
    attemptId: ATTEMPT_ID,
    attemptStartedAt: STARTED_AT,
    trigger: "submit",
    email: false,
  };
}

function baseActivation(overrides: Partial<AttemptActivation> = {}): AttemptActivation {
  const manifest = overrides.manifest ?? pendingManifest();
  return {
    keyPrefix: KEY_PREFIX,
    manifest,
    writeByIdPointer: true,
    rollbackManifest: manifest,
    rollbackAttempt: activeAttempt(),
    queueMessage: queueMessage(),
    principal: PRINCIPAL,
    ...overrides,
  };
}

beforeEach(clearBucket);
afterEach(clearBucket);

describe("activateAttempt", () => {
  it("submit shape: writes manifest, by-id pointer, index, sends, returns activated derived from manifest", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const { queue, sent } = captureQueue();

    const result = await activateAttempt(reader, queue, services(), baseActivation());

    expect(result).toEqual({
      kind: "activated",
      id: ID,
      status: "pending",
      attemptId: ATTEMPT_ID,
    });
    await expect(reader.readManifest(KEY_PREFIX)).resolves.toMatchObject({ id: ID, status: "pending" });
    await expect(reader.readByIdPointer(ID)).resolves.toEqual({ id: ID, key_prefix: KEY_PREFIX });
    const index = await reader.readListIndex();
    expect(index?.items.map((i) => i.id)).toContain(ID);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      version: 1,
      tenant: { tenantId: PRINCIPAL.tenantId },
      actor: { kind: "api_token", credentialId: PRINCIPAL.tokenId },
      job: { id: ID, attemptId: ATTEMPT_ID },
    });
    expect(sent[0]).not.toHaveProperty("scopes");
  });

  it("reprocess shape: writeByIdPointer false skips the by-id pointer write", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const { queue, sent } = captureQueue();

    const result = await activateAttempt(
      reader,
      queue,
      services(),
      baseActivation({ writeByIdPointer: false }),
    );

    expect(result.kind).toBe("activated");
    await expect(reader.readManifest(KEY_PREFIX)).resolves.toMatchObject({ id: ID });
    await expect(reader.readByIdPointer(ID)).resolves.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("import shape: writes the full sequence raw → extracted → manifest → by-id → index → send", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const { queue, sent } = captureQueue();
    const markdown = "# Imported\n\nbody";
    // Capture the entire canonical write order, not just the artifact prefix, so
    // a future reordering of the by-id pointer vs the list index is caught.
    const order: string[] = [];
    const trace = (method: keyof ReadingStore, label: string) => {
      const original = (reader[method] as (...a: unknown[]) => unknown).bind(reader);
      vi.spyOn(reader, method).mockImplementation((async (...args: unknown[]) => {
        order.push(label);
        return original(...args);
      }) as never);
    };
    trace("writeRaw", "raw");
    trace("writeExtracted", "extracted");
    trace("writeManifest", "manifest");
    trace("writeByIdPointer", "byId");
    trace("appendOrReplaceListIndexItem", "index");
    vi.spyOn(queue, "send").mockImplementation((async (msg: ProcessReadingEnvelopeV1) => {
      order.push("send");
      sent.push(msg);
    }) as unknown as Queue<ProcessReadingEnvelopeV1>["send"]);

    const result = await activateAttempt(
      reader,
      queue,
      services(),
      baseActivation({
        manifest: pendingManifest({
          source_type: "markdown",
          content_type: "text/markdown; charset=utf-8",
          content_bytes: new TextEncoder().encode(markdown).byteLength,
          content_sha256: await sha256Hex(markdown),
        }),
        artifacts: {
          rawExt: "md",
          rawBytes: new TextEncoder().encode(markdown),
          rawContentType: "text/markdown; charset=utf-8",
          extractedMarkdown: markdown,
        },
      }),
    );

    expect(result.kind).toBe("activated");
    expect(order).toEqual(["raw", "extracted", "manifest", "byId", "index", "send"]);
    const extracted = await reader.readExtracted(KEY_PREFIX);
    expect(await extracted?.text()).toBe(markdown);
    expect(sent).toHaveLength(1);
  });

  it("import-existing rollback: a failed prior rolls back to a failed manifest (not a prior ready)", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const markdown = "# Re-imported\n\nbody";
    // enqueueMarkdownImport rolls back to the freshly-built pending manifest, not
    // to the prior (failed) manifest — so the slot lands `failed`, retryable.
    const pending = pendingManifest({
      source_type: "markdown",
      content_type: "text/markdown; charset=utf-8",
      active_attempt: activeAttempt("import"),
    });

    const result = await activateAttempt(
      reader,
      rejectingQueue(),
      services(),
      baseActivation({
        manifest: pending,
        rollbackManifest: pending,
        rollbackAttempt: activeAttempt("import"),
        artifacts: {
          rawExt: "md",
          rawBytes: new TextEncoder().encode(markdown),
          rawContentType: "text/markdown; charset=utf-8",
          extractedMarkdown: markdown,
        },
      }),
    );

    expect(result).toEqual({ kind: "unavailable", reason: "queue_send_failed", id: ID });
    const manifest = await reader.readManifest(KEY_PREFIX);
    expect(manifest).toMatchObject({
      status: "failed",
      content_status: "failed",
      error: { code: "QueueSendError", retryable: true },
    });

    consoleErr.mockRestore();
  });

  it("setup failure: a pre-send write throw reports unavailable(activation_failed) and commits a failed manifest", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const { queue, sent } = captureQueue();
    const byIdKey = `index/by-id/${ID}`;
    const originalPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let failedOnce = false;
    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put").mockImplementation(
      (async (key: string, value: unknown, options?: R2PutOptions) => {
        if (key === byIdKey && !failedOnce) {
          failedOnce = true;
          throw new Error("simulated setup failure");
        }
        return originalPut(key, value as Parameters<R2Bucket["put"]>[1], options);
      }) as R2Bucket["put"],
    );
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await activateAttempt(reader, queue, services(), baseActivation());

    expect(result).toEqual({ kind: "unavailable", reason: "activation_failed", id: ID });
    expect(sent).toHaveLength(0);
    const manifest = await reader.readManifest(KEY_PREFIX);
    expect(manifest).toMatchObject({
      id: ID,
      status: "failed",
      error: { code: "QueueSendError", retryable: true },
    });
    const index = await reader.readListIndex();
    expect(index?.items.find((i) => i.id === ID)?.status).toBe("failed");

    putSpy.mockRestore();
    consoleErr.mockRestore();
  });

  it("queue-send failure: a rejecting queue reports unavailable(queue_send_failed) and commits a failed manifest", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await activateAttempt(reader, rejectingQueue(), services(), baseActivation());

    expect(result).toEqual({ kind: "unavailable", reason: "queue_send_failed", id: ID });
    const manifest = await reader.readManifest(KEY_PREFIX);
    expect(manifest).toMatchObject({
      status: "failed",
      error: { code: "QueueSendError", retryable: true },
    });

    consoleErr.mockRestore();
  });

  it("ready-reprocess rollback: a ready rollbackManifest stays ready with active_attempt cleared on send failure", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const ready = pendingManifest({ status: "ready", active_attempt: undefined, last_attempt: undefined });

    const result = await activateAttempt(
      reader,
      rejectingQueue(),
      services(),
      baseActivation({
        writeByIdPointer: false,
        manifest: pendingManifest({ status: "ready", active_attempt: activeAttempt("reprocess") }),
        rollbackManifest: ready,
        rollbackAttempt: activeAttempt("reprocess"),
      }),
    );

    expect(result.kind).toBe("unavailable");
    const manifest = await reader.readManifest(KEY_PREFIX);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.active_attempt).toBeUndefined();
    expect(manifest?.last_attempt).toMatchObject({ status: "failed", error: { code: "QueueSendError" } });

    consoleErr.mockRestore();
  });

  it("response derives status: a ready 'next' manifest returns status 'ready' in the activated outcome", async () => {
    const reader = new ReadingStore(env.READINGS_BUCKET);
    const { queue } = captureQueue();

    const result = await activateAttempt(
      reader,
      queue,
      services(),
      baseActivation({
        writeByIdPointer: false,
        manifest: pendingManifest({ status: "ready", active_attempt: activeAttempt("reprocess") }),
      }),
    );

    expect(result).toEqual({
      kind: "activated",
      id: ID,
      status: "ready",
      attemptId: ATTEMPT_ID,
    });
  });
});
