import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestEnvelopeV1 } from "../../src/control-plane/digest-envelope";
import { digestDeliveryKeyId, getDigestDelivery } from "../../src/control-plane/digest-ledger";
import {
  consumeDigestMessage,
  DIGEST_PENDING_STALE_MS,
  fanOutDueDigests,
  handleDigestDeadLetter,
  isStaleDigestPending,
  processDigestJob,
} from "../../src/digest-pipeline";
import worker, { type Env } from "../../src/index";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import type { Manifest } from "../../src/schemas/manifest";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import type { ListIndexItem } from "../../src/schemas/api";
import { testControlPlane } from "../helpers/control-plane-db";
import { interceptSql } from "../helpers/sql-faults";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { clearBucket } from "./readings-harness";

afterEach(() => vi.restoreAllMocks());

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

function installRejectingDigestQueue(error: unknown = new Error("queue send failed")): void {
  queued = [];
  (env as unknown as { DIGEST_JOBS: Queue<DigestEnvelopeV1> }).DIGEST_JOBS = {
    send: vi.fn(async () => {
      throw error;
    }),
  } as unknown as Queue<DigestEnvelopeV1>;
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
  await testControlPlane(env).run(
    `UPDATE user_settings
        SET digest_cadence = ?,
            time_zone = ?,
            digest_hour_local = ?,
            digest_weekday = ?,
            notify_immediate = ?
      WHERE user_id = ?`,
    values.cadence,
      values.timeZone ?? "UTC",
      values.hour ?? 9,
      values.weekday ?? 1,
      values.notifyImmediate ?? 1,
      userId,
  );
}

async function resetState(): Promise<void> {
  await testControlPlane(env).run("DELETE FROM digest_deliveries");
  await testControlPlane(env).run(
    "UPDATE user_settings SET digest_cadence = 'off', time_zone = 'UTC', digest_hour_local = 9, digest_weekday = 1",
  );
  installDigestQueue();
}

describe("isStaleDigestPending", () => {
  it("treats one cron interval as stale and younger rows as fresh", () => {
    expect(isStaleDigestPending(NOW_MS, NOW_MS)).toBe(false);
    expect(isStaleDigestPending(NOW_MS, NOW_MS + DIGEST_PENDING_STALE_MS - 1)).toBe(false);
    expect(isStaleDigestPending(NOW_MS, NOW_MS + DIGEST_PENDING_STALE_MS)).toBe(true);
  });
});

describe("digest fan-out + send-time skips", () => {
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

  it("CAS on period_key so two due ticks still result in one terminal row", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({
      enqueued: 1,
    });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS + DIGEST_PENDING_STALE_MS - 1 })).toEqual({
      enqueued: 0,
    });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS + DIGEST_PENDING_STALE_MS })).toEqual({
      enqueued: 1,
    });
    expect(queued).toHaveLength(2);
    expect(queued[0]).toEqual(queued[1]);

    for (const body of queued) {
      await processDigestJob(body, env as unknown as Env, { nowMs: NOW_MS });
    }
    const db = testControlPlane(env);
    const row = await getDigestDelivery(db, {
      userId: FOUNDER_TENANT_ID,
      cadence: "daily",
      periodKey: "2026-09-02",
    });
    expect(row?.status).toBe("skipped");
    expect(row?.skip_reason).toBe("empty_window");
  });

  it("does not enqueue a deleting tenant and skips an already-queued digest", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({ enqueued: 1 });
    const inflight = queued[0]!;
    await testControlPlane(env).run("UPDATE users SET status = 'deleting' WHERE id = ?", FOUNDER_TENANT_ID);
    try {
      expect(
        await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS + DIGEST_PENDING_STALE_MS }),
      ).toEqual({ enqueued: 0 });
      await processDigestJob(inflight, env as unknown as Env, { nowMs: NOW_MS });
      const row = await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      });
      expect(row).toMatchObject({ status: "skipped", skip_reason: "inactive_user" });
    } finally {
      await testControlPlane(env).run("UPDATE users SET status = 'active' WHERE id = ?", FOUNDER_TENANT_ID);
    }
  });

  it("skips an invalid stored TZ at send without calling mail", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    await testControlPlane(env).run(
      "UPDATE user_settings SET time_zone = ? WHERE user_id = ?",
      "Not/A_Zone", FOUNDER_TENANT_ID,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processDigestJob(queued[0]!, env as unknown as Env, { nowMs: NOW_MS });
    expect(warn.mock.calls.some((args) => {
      const line = String(args[0]);
      return line.includes(FOUNDER_TENANT_ID) && line.includes("invalid_time_zone");
    })).toBe(true);
    warn.mockRestore();

    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "invalid_time_zone" });
  });

  it("is idempotent when the same pending job is redelivered after skip", async () => {
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
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "empty_window" });
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
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "allowlist" });
  });

  it("skips when the local period_key has rolled even if cadence is still on", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    await processDigestJob(queued[0]!, env as unknown as Env, {
      nowMs: Date.parse("2026-09-03T09:00:00.000Z"),
    });
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "schedule_mismatch" });
  });

  it("continues fan-out when claim throws for one tenant", async () => {
    await insertSecondTenant(env as unknown as Env);
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await setDigest(OTHER_TENANT_ID, { cadence: "daily" });

    interceptSql(/INSERT INTO digest_deliveries/, (_call, values) =>
      values[0] === OTHER_TENANT_ID ? new Error("claim boom") : "pass",
    );

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    consoleErr.mockRestore();

    expect(result.enqueued).toBe(1);
    expect(queued.map((msg) => msg.tenantId)).toEqual([FOUNDER_TENANT_ID]);
  });

  it("deletes a pending ledger row this tick inserted when queue.send fails so a later tick can claim", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    installRejectingDigestQueue();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({
      enqueued: 0,
    });
    consoleErr.mockRestore();
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toBeNull();

    installDigestQueue();
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({
      enqueued: 1,
    });
    expect(queued).toHaveLength(1);
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "pending" });
  });

  it("does not re-enqueue a fresh pending claim on a later due tick", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({
      enqueued: 1,
    });
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "pending" });

    installRejectingDigestQueue();
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS + 60_000 })).toEqual({
      enqueued: 0,
    });
    expect(queued).toHaveLength(0);

    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "pending" });
  });

  it("re-enqueues a stale current-period pending row after the due hour", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    const laterMs = Date.parse("2026-09-02T10:30:00.000Z");
    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: laterMs })).toEqual({
      enqueued: 0,
    });

    await testControlPlane(env).run(
      `INSERT INTO digest_deliveries
         (user_id, cadence, period_key, status, created_at, updated_at)
       VALUES (?, 'daily', '2026-09-02', 'pending', ?, ?)`,
      FOUNDER_TENANT_ID,
      toTimestamp(laterMs - DIGEST_PENDING_STALE_MS),
      toTimestamp(laterMs - DIGEST_PENDING_STALE_MS),
    );

    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: laterMs })).toEqual({
      enqueued: 1,
    });
    expect(queued).toEqual([
      {
        version: 1,
        tenantId: FOUNDER_TENANT_ID,
        userId: FOUNDER_TENANT_ID,
        period_key: "2026-09-02",
        cadence: "daily",
      },
    ]);
  });

  it("does not re-enqueue a fresh leftover pending row after the due hour", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    const laterMs = Date.parse("2026-09-02T10:30:00.000Z");
    await testControlPlane(env).run(
      `INSERT INTO digest_deliveries
         (user_id, cadence, period_key, status, created_at, updated_at)
       VALUES (?, 'daily', '2026-09-02', 'pending', ?, ?)`,
      FOUNDER_TENANT_ID,
      toTimestamp(laterMs),
      toTimestamp(laterMs),
    );

    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: laterMs })).toEqual({
      enqueued: 0,
    });
    expect(queued).toEqual([]);
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

    const reader = testReadingsFor(founderTenant());
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
    await reader.seed(manifest, { keyPrefix: KEY_PREFIX });

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
    expect((await reader.manifest(READING_ID))?.status).toBe("pending");
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "failed" });
  });

  it("handleDigestDeadLetter acks even when the ledger write throws", async () => {
    interceptSql(/digest_deliveries/, () => new Error("database hiccup"));
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
      { HYPERDRIVE: env.HYPERDRIVE, EMAIL_FROM: "reading-lite@test.example" },
      { nowMs: NOW_MS },
    );
    expect(ack).toHaveBeenCalledOnce();
    consoleErr.mockRestore();
  });
});

const FOUNDER_TITLE = "Founder Only Title";
const OTHER_TITLE = "Other Only Secret Title";
const IN_WINDOW_AT = "2026-09-02T08:00:00.000Z";
const OLD_AT = "2026-01-01T00:00:00.000Z";
const WEB_BASE = "https://reading.test.example";

function digestItem(
  id: string,
  title: string,
  at: string,
  status: ListIndexItem["status"] = "ready",
): ListIndexItem {
  return {
    id,
    key_prefix: `readings/${id}`,
    url: `https://example.com/${id}`,
    title,
    tldr: `${title} tldr`,
    status,
    created_at: at,
    updated_at: at,
  };
}

function resendOkFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  let n = 0;
  return vi.fn<typeof fetch>(async () => {
    n += 1;
    return new Response(JSON.stringify({ id: `re_digest_${n}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function resendBodies(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>): Array<{
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}> {
  return fetchFn.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as {
    to: string;
    from: string;
    subject: string;
    html: string;
    text: string;
  });
}

async function seedList(
  tenant: ReturnType<typeof founderTenant>,
  items: ListIndexItem[],
): Promise<void> {
  await testReadingsFor(tenant).seedListItems(items);
}

describe("digest send isolation (196 B2)", () => {
  beforeEach(async () => {
    await resetState();
    await clearBucket();
    await insertSecondTenant(env as unknown as Env);
  });

  it("sends one Resend mail per tenant from that tenant's index and never EMAIL_TO", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily", notifyImmediate: 0 });
    await setDigest(OTHER_TENANT_ID, { cadence: "daily", notifyImmediate: 0 });
    await seedList(founderTenant(), [
      digestItem("rd_FNDR01", FOUNDER_TITLE, IN_WINDOW_AT),
      digestItem("rd_FNDR02", "Founder Corpus Dump", OLD_AT),
    ]);
    await seedList(otherTenant(), [digestItem("rd_OTHR01", OTHER_TITLE, IN_WINDOW_AT)]);

    expect(await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS })).toEqual({
      enqueued: 2,
    });
    const fetchFn = resendOkFetch();
    for (const body of queued) {
      await processDigestJob(body, env as unknown as Env, { nowMs: NOW_MS, fetch: fetchFn });
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const bodies = resendBodies(fetchFn);
    const keys = fetchFn.mock.calls.map((call) => new Headers(call[1]?.headers).get("Idempotency-Key"));
    expect(keys.sort()).toEqual(
      [
        digestDeliveryKeyId({
          userId: FOUNDER_TENANT_ID,
          cadence: "daily",
          periodKey: "2026-09-02",
        }),
        digestDeliveryKeyId({
          userId: OTHER_TENANT_ID,
          cadence: "daily",
          periodKey: "2026-09-02",
        }),
      ].sort(),
    );
    expect(bodies.map((b) => b.to).sort()).toEqual(
      ["founder@test.example", "other@test.example"].sort(),
    );

    const founderMail = bodies.find((b) => b.to === "founder@test.example")!;
    const otherMail = bodies.find((b) => b.to === "other@test.example")!;
    expect(founderMail.html).toContain(FOUNDER_TITLE);
    expect(founderMail.html).toContain(`${WEB_BASE}/readings/rd_FNDR01`);
    expect(founderMail.html).not.toContain(OTHER_TITLE);
    expect(founderMail.html).not.toContain("rd_OTHR01");
    expect(founderMail.html).not.toContain("Founder Corpus Dump");
    expect(otherMail.html).toContain(OTHER_TITLE);
    expect(otherMail.html).toContain(`${WEB_BASE}/readings/rd_OTHR01`);
    expect(otherMail.html).not.toContain(FOUNDER_TITLE);
    expect(otherMail.html).not.toContain("rd_FNDR01");
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain("reader@test.example");
      expect(JSON.stringify(body)).not.toContain("EMAIL_TO");
      expect(body.to).not.toBe((env as unknown as Env).EMAIL_TO);
    }

    await processDigestJob(queued[0]!, env as unknown as Env, { nowMs: NOW_MS, fetch: fetchFn });
    await processDigestJob(queued[1]!, env as unknown as Env, { nowMs: NOW_MS, fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "sent", resend_id: expect.stringMatching(/^re_digest_/) });
  });

  it("skips without Resend when the user opts out after enqueue", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await seedList(founderTenant(), [digestItem("rd_FNDR01", FOUNDER_TITLE, IN_WINDOW_AT)]);
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    await setDigest(FOUNDER_TENANT_ID, { cadence: "off" });
    const fetchFn = resendOkFetch();
    await processDigestJob(queued[0]!, env as unknown as Env, { nowMs: NOW_MS, fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "cadence_off" });
  });

  it("writes skipped and sends zero Resend for an empty window", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await seedList(founderTenant(), [
      digestItem("rd_FNDR02", "Founder Corpus Dump", OLD_AT),
      digestItem("rd_FAIL01", "Failed in window", IN_WINDOW_AT, "failed"),
      digestItem("rd_PEND01", "Pending in window", IN_WINDOW_AT, "pending"),
    ]);
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    const fetchFn = resendOkFetch();
    // Sending after the local hour has passed is still the same period_key:
    // the window is evaluated (empty here), not skipped as period_rolled.
    const laterMs = Date.parse("2026-09-02T10:30:00.000Z");
    await processDigestJob(queued[0]!, env as unknown as Env, { nowMs: laterMs, fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "empty_window" });
  });

  it("retries a Resend 429 and leaves the ledger pending", async () => {
    await setDigest(FOUNDER_TENANT_ID, { cadence: "daily" });
    await seedList(founderTenant(), [digestItem("rd_FNDR01", FOUNDER_TITLE, IN_WINDOW_AT)]);
    await fanOutDueDigests(env as unknown as Env, { nowMs: NOW_MS });
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ message: "slow" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    const msg = { body: queued[0], ack: vi.fn(), retry: vi.fn(), attempts: 1 };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await consumeDigestMessage(msg, env as unknown as Env, { nowMs: NOW_MS, fetch: fetchFn });
    consoleErr.mockRestore();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(
      await getDigestDelivery(testControlPlane(env), {
        userId: FOUNDER_TENANT_ID,
        cadence: "daily",
        periodKey: "2026-09-02",
      }),
    ).toMatchObject({ status: "pending" });
  });
});
