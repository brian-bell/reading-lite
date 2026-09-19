import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tearDownAccount } from "../../src/control-plane/account-teardown";
import { fromD1 } from "../../src/control-plane/db";
import { digestEnvelopeV1 } from "../../src/control-plane/digest-envelope";
import { claimPendingDigestDelivery, getDigestDelivery } from "../../src/control-plane/digest-ledger";
import { admitProcessReadingEnvelope, type ProcessReadingEnvelopeV1 } from "../../src/control-plane/envelope";
import { parseUserId } from "../../src/control-plane/ids";
import { accountWipeEnvelopeV1 } from "../../src/control-plane/wipe-envelope";
import { processDigestJob } from "../../src/digest-pipeline";
import worker, { type Env } from "../../src/index";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { PgReadingStore } from "../../src/modules/stores/postgres/reading-store";
import { sha256Hex } from "../../src/services";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  OTHER_TOKEN_ID,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";

// #288: these are local runtime characterizations, including known limits.
// They exercise hard deletion, not only status='deleting'. No provider calls
// or live queue inspection occur; queue retention is outside this evidence.
const NOW_MS = Date.parse("2026-09-05T09:00:00.000Z");
const PREFIX = `u/${OTHER_TENANT_ID}/`;
const NEIGHBOR_KEY = `u/${FOUNDER_TENANT_ID}/queue-control.txt`;
const READING_ID = "rd_0123456789";
const URL = "https://example.com/288-queue";
const CREATED_AT = "2026-09-05T08:00:00.000Z";
const KEY_PREFIX = buildKeyPrefix(READING_ID, CREATED_AT);

// Guard internals have their own direct-storage suite. Keep this fixture on
// real D1/R2 with successful bound purge replies, without opening DO storage.
const purgeNamespace = {
  idFromName: (name: string) => name,
  get: () => ({ fetch: async () => Response.json({ ok: true }) }),
} as unknown as DurableObjectNamespace;

function queueMessage(body: unknown) {
  return {
    id: "message_288",
    timestamp: new Date(NOW_MS),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function dispatch(queue: string, msg: ReturnType<typeof queueMessage>): Promise<void> {
  await worker.queue({ queue, messages: [msg] } as unknown as MessageBatch<unknown>, env);
}

async function tearDownFixture(): Promise<void> {
  // Model a completed data-plane wipe. The real control-plane teardown must
  // remove the user, token/scopes and pending digest before replay starts.
  const objects = await env.READINGS_BUCKET.list({ prefix: PREFIX });
  expect(objects.truncated).toBe(false);
  for (const object of objects.objects) await env.READINGS_BUCKET.delete(object.key);
  await env.CONTROL_PLANE.prepare(
    "UPDATE users SET status = 'deleting', deleting_at_ms = ? WHERE id = ?",
  ).bind(NOW_MS - 8 * 24 * 60 * 60_000, OTHER_TENANT_ID).run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO wipe_progress
       (tenant_id, phase, updated_at_ms, completed_at_ms, first_completed_at_ms)
     VALUES (?, 'done', ?, ?, ?)`,
  ).bind(OTHER_TENANT_ID, NOW_MS, NOW_MS, NOW_MS).run();
  const result = await tearDownAccount(fromD1(env.CONTROL_PLANE), {
    TENANT_USAGE_GUARD: purgeNamespace,
    GLOBAL_USAGE_GUARD: purgeNamespace,
  }, {
    tenantId: OTHER_TENANT_ID,
    nowMs: NOW_MS,
    prefixVerdict: async () => {
      const page = await env.READINGS_BUCKET.list({ prefix: PREFIX });
      return page.objects.length === 0 && !page.truncated ? "empty" : "not_empty";
    },
  });
  expect(result.kind).toBe("torn_down");
  await expectNoTenantState();
}

async function expectNoTenantState(): Promise<void> {
  const db = fromD1(env.CONTROL_PLANE);
  expect(await db.first("SELECT id FROM users WHERE id = ?", OTHER_TENANT_ID)).toBeNull();
  expect(await db.all("SELECT * FROM api_token_scopes WHERE token_id = ?", OTHER_TOKEN_ID)).toEqual([]);
  expect(await db.all("SELECT * FROM digest_deliveries WHERE user_id = ?", OTHER_TENANT_ID)).toEqual([]);
  expect(await db.all("SELECT * FROM wipe_progress WHERE tenant_id = ?", OTHER_TENANT_ID)).toEqual([]);
  expect(await db.all("SELECT * FROM vector_ledger WHERE tenant_id = ?", OTHER_TENANT_ID)).toEqual([]);
  expect(await db.first("SELECT tenant_id FROM account_deletions WHERE tenant_id = ?", OTHER_TENANT_ID))
    .toEqual({ tenant_id: OTHER_TENANT_ID });
  const page = await env.READINGS_BUCKET.list({ prefix: PREFIX });
  expect(page.truncated).toBe(false);
  expect(page.objects).toEqual([]);
  expect(await (await env.READINGS_BUCKET.get(NEIGHBOR_KEY))?.text()).toBe("neighbor stays");
}

function digestEnvelope() {
  return digestEnvelopeV1({
    tenantId: otherTenant().tenantId,
    userId: parseUserId(OTHER_TENANT_ID)!,
    cadence: "daily",
    period_key: "2026-09-05",
  });
}

async function seedPendingDigest() {
  await env.CONTROL_PLANE.prepare(
    "UPDATE user_settings SET digest_cadence = 'daily', time_zone = 'UTC' WHERE user_id = ?",
  ).bind(OTHER_TENANT_ID).run();
  const key = { userId: OTHER_TENANT_ID, cadence: "daily" as const, periodKey: "2026-09-05" };
  expect(await claimPendingDigestDelivery(fromD1(env.CONTROL_PLANE), key, NOW_MS)).toBe("inserted");
  expect(await getDigestDelivery(fromD1(env.CONTROL_PLANE), key)).toMatchObject({ status: "pending" });
  return digestEnvelope();
}

beforeEach(async () => {
  await insertSecondTenant(env as Env);
  await env.READINGS_BUCKET.put(NEIGHBOR_KEY, "neighbor stays");
});

afterEach(() => vi.restoreAllMocks());

describe("saved queue envelopes after hard teardown (#288)", () => {
  it("acks saved reading and wipe jobs and both DLQs without recreating tenant artifacts or spending", async () => {
    const saved: ProcessReadingEnvelopeV1 = {
      version: 1,
      tenant: otherTenant(),
      actor: { kind: "api_token", credentialId: OTHER_TOKEN_ID },
      job: {
        id: READING_ID,
        url: URL,
        urlHash: await sha256Hex(URL),
        keyPrefix: KEY_PREFIX,
        createdAt: CREATED_AT,
        source: { kind: "markdown", markdown: "Private fixture content" },
        trigger: "import",
      },
    };
    // A meaningful saved envelope was admissible while its owner existed.
    expect(await admitProcessReadingEnvelope(fromD1(env.CONTROL_PLANE), saved, Date.now()))
      .toEqual({ ok: true, tenant: otherTenant() });
    const savedWipe = accountWipeEnvelopeV1({ tenantId: otherTenant().tenantId, force: false });
    await env.READINGS_BUCKET.put(`${PREFIX}${KEY_PREFIX}/raw.md`, "Private fixture content");
    await tearDownFixture();
    const auditBefore = await fromD1(env.CONTROL_PLANE).first(
      "SELECT * FROM account_deletions WHERE tenant_id = ?", OTHER_TENANT_ID,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upstream call"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [queue, body] of [
      ["reading-lite", saved],
      ["reading-lite-dlq", saved],
      ["reading-lite-wipe", savedWipe],
      ["reading-lite-wipe-dlq", savedWipe],
    ] as const) {
      const msg = queueMessage(body);
      await dispatch(queue, msg);
      expect(msg.ack, queue).toHaveBeenCalledOnce();
      expect(msg.retry, queue).not.toHaveBeenCalled();
      await expectNoTenantState();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errors.mock.calls[0]![0])))
      .toMatchObject({ event: "account_wipe_dead_lettered", tenant_id: OTHER_TENANT_ID });
    expect(await fromD1(env.CONTROL_PLANE).first(
      "SELECT * FROM account_deletions WHERE tenant_id = ?", OTHER_TENANT_ID,
    )).toEqual(auditBefore);
  });

  it("retries a saved digest after FK refusal, then its DLQ logs and acks without mail or orphan rows", async () => {
    const saved = await seedPendingDigest();
    await tearDownFixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected mail"));
    // Capture the actual D1 error at the write boundary; an unrelated failure
    // or parser rejection must not satisfy the retry/ack characterization.
    await expect(processDigestJob(saved, env, { nowMs: NOW_MS }))
      .rejects.toThrow(/FOREIGN KEY constraint failed/);
    const msg = queueMessage(saved);
    await dispatch("reading-lite-digest", msg);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.retry).toHaveBeenCalledWith();
    await expectNoTenantState();

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dlq = queueMessage(saved);
    await dispatch("reading-lite-digest-dlq", dlq);
    expect(dlq.ack).toHaveBeenCalledOnce();
    expect(dlq.retry).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().map(String).join("\n")).toMatch(/FOREIGN KEY constraint failed/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectNoTenantState();
  });

  it("can send a digest whose list read was in flight before teardown, while FK enforcement blocks late finalization", async () => {
    const saved = await seedPendingDigest();
    await testReadingsFor(otherTenant()).seedListItems([{
      id: READING_ID,
      key_prefix: KEY_PREFIX,
      url: URL,
      title: "Saved before deletion",
      tldr: "This content can outlive the send-time eligibility check.",
      status: "ready",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    }]);

    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const mayReturnRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    // The library read completes, then is held open across the teardown.
    const readLibrary = PgReadingStore.prototype.allListItems;
    vi.spyOn(PgReadingStore.prototype, "allListItems").mockImplementation(async function (this: PgReadingStore) {
      const library = await readLibrary.call(this);
      expect(library).toHaveLength(1);
      signalRead();
      await mayReturnRead;
      return library;
    });
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      // The send really occurs after hard deletion, not just before a delayed
      // response from the mail provider. The provider itself is a local stub.
      expect(await fromD1(env.CONTROL_PLANE).first("SELECT id FROM users WHERE id = ?", OTHER_TENANT_ID))
        .toBeNull();
      return Response.json({ id: "re_288_after_teardown" });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = processDigestJob(saved, env, {
      nowMs: NOW_MS,
      fetch: fetchSpy,
    }).then(() => null, (error: unknown) => error);
    try {
      await readStarted;
      expect(fetchSpy).not.toHaveBeenCalled();
      await tearDownFixture();
    } finally {
      releaseRead();
    }
    expect(String(await outcome)).toMatch(/FOREIGN KEY constraint failed/);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)))
      .toMatchObject({ to: "other@test.example", text: expect.stringContaining("Saved before deletion") });
    await expectNoTenantState();
  });
});
