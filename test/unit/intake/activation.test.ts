import { describe, expect, it, vi } from "vitest";
import {
  activateAttempt,
  type ActivationArtifacts,
  type AttemptActivation,
} from "../../../src/intake/activation";
import type { ProcessReadingEnvelopeV1 } from "../../../src/control-plane/envelope";
import { createApiTokenPrincipal } from "../../../src/control-plane/principal";
import type { ProcessReadingArgs } from "../../../src/process-reading";
import type { Manifest, ProcessingAttemptSummary } from "../../../src/schemas/manifest";
import { sha256Hex, type Services } from "../../../src/services";
import { FOUNDER_TENANT_ID } from "../../helpers/file-tenants";
import { mintTenant } from "../../helpers/pg-fixtures";
import { testReadingsFor, type TestReadings } from "../../helpers/test-readings";

// activateAttempt runs AFTER the caller's transaction committed the attempt
// and its job row. Its own contract is what happens next: import content is
// written under the attempt's keys, the message is sent, and a throw at either
// step rolls the reading back in one transaction. Each test starts from a
// committed attempt on its own tenant.

const PRINCIPAL = createApiTokenPrincipal({
  tenantId: FOUNDER_TENANT_ID,
  userId: FOUNDER_TENANT_ID,
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
const URL_HASH = await sha256Hex(URL);
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
    manifest,
    rollbackManifest: manifest,
    rollbackAttempt: activeAttempt(),
    queueMessage: queueMessage(),
    principal: PRINCIPAL,
    ...overrides,
  };
}

const ARTIFACTS: ActivationArtifacts = {
  rawKey: `${KEY_PREFIX}/revisions/${ATTEMPT_ID}/raw.md`,
  rawBytes: new TextEncoder().encode("# Imported"),
  rawContentType: "text/markdown; charset=utf-8",
  extractedKey: `${KEY_PREFIX}/revisions/${ATTEMPT_ID}/extracted.md`,
  extractedMarkdown: "# Imported",
};

// The state intake leaves behind before it calls activateAttempt: the reading,
// its URL, the running attempt and a queued job, committed together.
async function committedAttempt(manifest: Manifest = pendingManifest()): Promise<TestReadings> {
  const readings = testReadingsFor(mintTenant());
  await readings.writer.claimUrl(manifest, KEY_PREFIX, { summary: activeAttempt(), payload: queueMessage() });
  return readings;
}

function activate(readings: TestReadings, queue: Queue<ProcessReadingEnvelopeV1>, a: AttemptActivation) {
  return activateAttempt(readings.writer, readings.content, queue, services(), a);
}

describe("activateAttempt", () => {
  it("sends under the principal's envelope, marks the job sent, and derives the outcome from the manifest", async () => {
    const readings = await committedAttempt();
    const { queue, sent } = captureQueue();

    const out = await activate(readings, queue, baseActivation());

    expect(out).toEqual({ kind: "activated", id: ID, status: "pending", attemptId: ATTEMPT_ID });
    expect(sent).toEqual([
      {
        version: 1,
        tenant: { tenantId: PRINCIPAL.tenantId },
        actor: { kind: "api_token", credentialId: "tok_550e8400-e29b-41d4-a716-446655440000" },
        job: queueMessage(),
      },
    ]);
    expect(await readings.jobState(ID, ATTEMPT_ID)).toBe("sent");
  });

  it("derives a ready status for a reprocess of a published reading", async () => {
    const readings = await committedAttempt();
    const { queue } = captureQueue();
    const ready = pendingManifest({ status: "ready", connections: [] });

    const out = await activate(readings, queue, baseActivation({ manifest: ready }));

    expect(out).toMatchObject({ kind: "activated", status: "ready" });
  });

  // Ordering pin: the content is in R2 before the consumer can be told about it.
  it("import: writes raw and extracted under the attempt's keys before it sends", async () => {
    const readings = await committedAttempt();
    const seenAtSend: (string | null)[] = [];
    const queue = {
      send: vi.fn(async () => {
        seenAtSend.push(await (await readings.content.get(ARTIFACTS.rawKey))?.text() ?? null);
        seenAtSend.push(await (await readings.content.get(ARTIFACTS.extractedKey))?.text() ?? null);
      }),
    } as unknown as Queue<ProcessReadingEnvelopeV1>;

    const out = await activate(readings, queue, baseActivation({ artifacts: ARTIFACTS }));

    expect(out.kind).toBe("activated");
    expect(seenAtSend).toEqual(["# Imported", "# Imported"]);
    const raw = await readings.content.get(ARTIFACTS.rawKey);
    expect(raw!.contentType).toBe("text/markdown; charset=utf-8");
    // An unread R2 body breaks the pool's per-test storage isolation.
    await raw!.arrayBuffer();
  });

  it("setup failure: a content write that throws reports activation_failed, never sends, and fails the reading", async () => {
    const readings = await committedAttempt();
    const { queue, sent } = captureQueue();
    vi.spyOn(readings.content, "put").mockRejectedValue(new Error("R2 put failed"));

    const out = await activate(readings, queue, baseActivation({ artifacts: ARTIFACTS }));

    expect(out).toEqual({ kind: "unavailable", reason: "activation_failed", id: ID });
    expect(sent).toHaveLength(0);
    expect(queue.send).not.toHaveBeenCalled();
    expect(await readings.manifest(ID)).toMatchObject({ status: "failed", error: { retryable: true } });
    expect(await readings.jobState(ID, ATTEMPT_ID)).toBe("send_failed");
  });

  it("queue-send failure: reports queue_send_failed and leaves a failed, retryable owner with its job recorded", async () => {
    const readings = await committedAttempt();

    const out = await activate(readings, rejectingQueue(), baseActivation());

    expect(out).toEqual({ kind: "unavailable", reason: "queue_send_failed", id: ID });
    const manifest = await readings.manifest(ID);
    expect(manifest).toMatchObject({
      status: "failed",
      error: { code: "QueueSendError", retryable: true },
      last_attempt: { id: ATTEMPT_ID, status: "failed" },
    });
    expect(manifest!.active_attempt).toBeUndefined();
    // Recoverable: the URL is still owned, so a resubmit reprocesses in place,
    // and the job row records that the work was asked for and never queued.
    expect(await readings.urlOwnerId(URL)).toBe(ID);
    expect(await readings.jobState(ID, ATTEMPT_ID)).toBe("send_failed");
  });

  it("ready-reprocess rollback: a ready rollbackManifest stays ready with active_attempt cleared on send failure", async () => {
    const ready = pendingManifest({ status: "ready", connections: [], title: "Kept", last_attempt: undefined });
    const readings = testReadingsFor(mintTenant());
    await readings.seed({ ...ready, active_attempt: undefined }, { keyPrefix: KEY_PREFIX });
    await readings.writer.startAttempt(ready, { summary: activeAttempt("reprocess"), payload: queueMessage() }, undefined);

    const out = await activate(
      readings,
      rejectingQueue(),
      baseActivation({
        manifest: ready,
        rollbackManifest: { ...ready, active_attempt: undefined },
        rollbackAttempt: activeAttempt("reprocess"),
      }),
    );

    expect(out).toMatchObject({ kind: "unavailable", reason: "queue_send_failed" });
    const manifest = await readings.manifest(ID);
    expect(manifest).toMatchObject({ status: "ready", title: "Kept", last_attempt: { status: "failed" } });
    expect(manifest!.active_attempt).toBeUndefined();
  });

  // The deletion fence: the reading was purged between the commit and the send.
  it("purged before the rollback: recreates nothing", async () => {
    const readings = await committedAttempt();
    const queue = {
      send: vi.fn(async () => {
        await readings.writer.purge(ID, () => false);
        throw new Error("queue send failed");
      }),
    } as unknown as Queue<ProcessReadingEnvelopeV1>;

    const out = await activate(readings, queue, baseActivation());

    expect(out).toEqual({ kind: "unavailable", reason: "queue_send_failed", id: ID });
    expect(await readings.manifest(ID)).toBeNull();
    expect(await readings.ids()).toEqual([]);
  });

  it("a failed job-state update after a successful send still reports activated", async () => {
    const readings = await committedAttempt();
    const { queue, sent } = captureQueue();
    vi.spyOn(readings.writer, "markJobSent").mockRejectedValue(new Error("database blip"));

    const out = await activate(readings, queue, baseActivation());

    expect(out.kind).toBe("activated");
    expect(sent).toHaveLength(1);
  });
});
