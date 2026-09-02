import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestEnvelopeV1 } from "../../src/control-plane/digest-envelope";
import { getDigestDelivery } from "../../src/control-plane/digest-ledger";
import { fromD1 } from "../../src/control-plane/db";
import {
  consumeDigestMessage,
  fanOutDueDigests,
  handleDigestDeadLetter,
  processDigestJob,
} from "../../src/digest-pipeline";
import worker, { type Env } from "../../src/index";
import { buildKeyPrefix, manifestToIndexItem } from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  insertSecondTenant,
  testReadingStore,
} from "../helpers/tenant-fixtures";

const NOW_MS = Date.parse("2026-09-02T09:00:00.000Z");
const READING_ID = "rd_0123456780";
const KEY_PREFIX = buildKeyPrefix(READING_ID, "2026-05-07T12:00:00.000Z");

let queued: DigestEnvelopeV1[] = [];

function installDigestQueue(): DigestEnvelopeV1[] {
  queued = [];
  (env as unknown as { DIGEST_JOBS: Queue<DigestEnvelopeV1> }).DIGEST_JOBS = {
    send: vi.fn(async (msg: DigestEnvelopeV1) => {
      queued.push(msg);
    }),
  } as unknown as Queue<DigestEnvelopeV1>;
  return queued;
}

async function setDigest(
  userId: string,
  values: {
    cadence: string;
    timeZone?: string;
    hour?: number;
    weekday?: number;
    notifyImmediate?: number;
  },
): Promise<void> {
  await env.CONTROL_PLANE.prepare(
    `UPDATE user_settings
        SET digest_cadence = ?,
            time_zone = ?,
            digest_hour_local = ?,
            digest_weekday = ?,
            notify_immediate = ?
      WHERE user_id = ?`,
  )
    .bind(
      values.cadence,
      values.timeZone ?? "UTC",
      values.hour ?? 9,
      values.weekday ?? 1,
      values.notifyImmediate ?? 1,
      userId,
    )
    .run();
}

async function resetState(): Promise<void> {
  await env.CONTROL_PLANE.prepare("DELETE FROM digest_deliveries").run();
  await env.CONTROL_PLANE.prepare(
    "UPDATE user_settings SET digest_cadence = 'off', time_zone = 'UTC', digest_hour_local = 9, digest_weekday = 1",
  ).run();
  installDigestQueue();
}

describe("digest fan-out + stub send", () => {
  beforeEach(resetState);

  it("enqueues one job per due tenant and ignores notify_immediate", async () => {
    await insertSecondTenant(env as unknown as Env);
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily", notifyImmediate: 0 });
    await setDigest(OTHER_TENANT_ID, { cadence: "daily", notifyImmediate: 0 });

    const result = await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    expect(result.enqueued).toBe(2);
    expect(queued.map((msg) => msg.tenantId).sort()).toEqual(
      [FOUNDER_TENANT_ID, OTHER_TENANT_ID].sort(),
    );
    expect(new Set(queued.map((msg) => msg.tenantId)).size).toBe(2);
    for (const msg of queued) {
      expect(msg).toMatchObject({
        version: 1,
        userId: msg.tenantId,
        cadence: "daily",
        period_key: "2026-09-02",
      });
      expect(msg).not.toHaveProperty("email");
    }
  });

  it("CAS on period_key so two due ticks still result in one sent row", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({
      enqueued: 1,
    });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS + 15 * 60_000 })).toEqual({
      enqueued: 1,
    });
    expect(queued).toHaveLength(2);
    expect(queued[0]).toEqual(queued[1]);

    for (const body of queued) {
      await processDigestJob(body, env as unknown as Env, { nowMs: NOW_MS });
    }
    const db = fromD1(env.CONTROL_PLANE);
    const row = await getDigestDelivery(db, {
      userId: FOUNDER_TENANT_ID,
      cadence: "daily",
      periodKey: "2026-09-02",
    });
    expect(row?.status).toBe("sent");
    expect(row?.skip_reason).toBeNull();
  });

  it("honors opt-out between enqueue and stub send", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    await setDigest(FOUNDER_TENANT_ID, { cadence: "off" });
    await processDigestJob(queued[0]!, env as unknown as Env, { nowMs: NOW_MS });

    const row = await getDigestDelivery(fromD1(env.CONTROL_PLANE), {
      userId: FOUNDER_TENANT_ID,
      cadence: "daily",
      periodKey: "2026-09-02",
    });
    expect(row).toMatchObject({ status: "skipped", skip_reason: "cadence_off" });
  });

  it("skips an invalid stored TZ at send without calling mail", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    await env.CONTROL_PLANE.prepare("UPDATE user_settings SET time_zone = ? WHERE user_id = ?")
      .bind("Not/A_Zone", FOUNDER_TENANT_ID)
      .run();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processDigestJob(queued[0]!, env as unknown as Env, { nowMs: NOW_MS });
    expect(warn.mock.calls.some((args) => {
      const line = String(args[0]);
      return line.includes(FOUNDER_TENANT_ID) && line.includes("invalid_time_zone");
    })).toBe(true);
    warn.mockRestore();

    expect(
      await getDigestDelivery(fromD1(env.CONTROL_PLANE), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "invalid_time_zone" });
  });

  it("is idempotent when the same pending job is redelivered after stub send", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    const msg = {
      body: queued[0],
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeDigestMessage(msg, env as unknown as Env, { nowMs: NOW_MS });
    await consumeDigestMessage(msg, env as unknown as Env, { nowMs: NOW_MS });
    expect(msg.ack).toHaveBeenCalledTimes(2);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(
      await getDigestDelivery(fromD1(env.CONTROL_PLANE), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "sent" });
  });

  it("skips a staging allowlist miss at send", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    await processDigestJob(
      queued[0]!,
      {
        ...(env as unknown as Env),
        APP_ENV: "staging",
        AUTH_MAIL_ALLOWLIST: "",
        FOUNDER_EMAIL: "other@example.com",
      },
      { nowMs: NOW_MS },
    );
    expect(
      await getDigestDelivery(fromD1(env.CONTROL_PLANE), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "allowlist" });
  });

  it("wires scheduled() to due+enqueue with frozen scheduledTime", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "weekly", weekday: 3 });
    await worker.scheduled(
      { scheduledTime: NOW_MS, cron: "*/15 * * * *" } as ScheduledController,
      env as unknown as Env,
    );
    expect(queued).toEqual([
      {
        version: 1,
        tenantId: FOUNDER_TENANT_ID,
        userId: FOUNDER_TENANT_ID,
        period_key: "2026-W36",
        cadence: "weekly",
      },
    ]);
  });
});

describe("digest DLQ does not touch reading manifests", () => {
  beforeEach(async () => {
    await resetState();
    const list = await env.READINGS_BUCKET.list();
    for (const obj of list.objects) await env.READINGS_BUCKET.delete(obj.key);
  });

  it("marks the digest ledger failed and leaves a pending reading alone", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });

    const reader = testReadingStore(env);
    const manifest: Manifest = {
      id: READING_ID,
      url: "https://example.com/dlq",
      url_hash: "b7dada632530beda9d7421510dc770125241cffc112dfdff1db0df8f991ebd78",
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
    await reader.writeManifest(KEY_PREFIX, manifest);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, KEY_PREFIX));

    const ack = vi.fn();
    const batch = {
      queue: "reading-lite-digest-dlq",
      messages: [
        {
          id: "m_digest_dlq",
          timestamp: new Date(),
          body: queued[0],
          attempts: 4,
          ack,
          retry: vi.fn(),
        },
      ],
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env as unknown as Env);

    expect(ack).toHaveBeenCalledOnce();
    expect((await reader.readManifest(KEY_PREFIX))?.status).toBe("pending");
    expect(
      await getDigestDelivery(fromD1(env.CONTROL_PLANE), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "failed" });
  });

  it("handleDigestDeadLetter acks even when the ledger write throws", async () => {
    const ack = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleDigestDeadLetter(
      {
        body: {
          version: 1,
          tenantId: FOUNDER_TENANT_ID,
          userId: FOUNDER_TENANT_ID,
          period_key: "2026-09-02",
          cadence: "daily",
        },
        ack,
      },
      {
        CONTROL_PLANE: {
          prepare: () => {
            throw new Error("D1 hiccup");
          },
        } as unknown as D1Database,
        EMAIL_FROM: "reading-lite@test.example",
      },
      { nowMs: NOW_MS },
    );
    expect(ack).toHaveBeenCalledOnce();
    consoleErr.mockRestore();
  });
});
