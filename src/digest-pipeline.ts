/**
 * Digest pipeline (issue 196 B2): cron due-selection + DIGEST_JOBS fan-out
 * and a Resend digest send. One job per tenant. The consumer re-reads
 * settings immediately before send and honors opt-out. Send-time re-read
 * checks cadence, TZ, recipient, and that `period_key` still matches the
 * current local day/week. Hour and weekday matching is enqueue-only so a
 * delayed/retried job in the same period still sends. Fan-out also
 * re-enqueues current-period `pending` rows (via `currentPeriodKey`) so a
 * producer miss through the due hour can still land on DIGEST_JOBS later
 * that day/week. Leftover re-enqueue only applies to *stale* pending rows
 * (`DIGEST_PENDING_STALE_MS` = 15 minutes, one cron interval — longer
 * than the digest 429 retry cap of 5 minutes) so an in-flight or mid-retry
 * job is not double-queued. A `queue.send` failure after this tick *inserted* a pending
 * claim deletes that row so a later tick can claim again. An already-existing
 * `pending` row is left in place: it belongs to an earlier enqueue still in
 * flight. Each tenant is claimed+enqueued in its own try/catch so one failure
 * cannot abort the rest of the cron tick.
 *
 * The send window is ready title+tldr readings whose updated_at (else
 * created_at) falls in the local period ending at this send. Empty windows
 * skip without a Resend POST so the period stays closed. Digest mail is
 * Resend-only: it does not use LOCAL_MAIL_SINK. Recipient is verified
 * email_display (never EMAIL_TO).
 *
 * Digest DLQ handling lives next to this module so it can mark the ledger
 * failed without touching reading manifests.
 */
import { fromD1, type ControlPlaneDb } from "./control-plane/db";
import {
  digestEnvelopeV1,
  logDigestEnvelopeRejected,
  parseDigestEnvelope,
  type DigestEnvelopeV1,
} from "./control-plane/digest-envelope";
import {
  claimPendingDigestDelivery,
  deletePendingDigestDelivery,
  digestDeliveryKeyId,
  finalizeDigestDelivery,
  getDigestDelivery,
  listPendingDigestDeliveries,
  touchPendingDigestDelivery,
  type DigestDeliveryKey,
  type DigestSkipReason,
} from "./control-plane/digest-ledger";
import { parseTenantId, parseUserId } from "./control-plane/ids";
import { redactEmailsInText } from "./control-plane/email";
import { resolveDigestRecipient } from "./control-plane/reading-notification";
import {
  buildTitleById,
  selectDigestReadings,
  sendDigestEmail,
} from "./modules/digest-email";
import {
  currentPeriodKey,
  digestDueAt,
  digestWindow,
  type DigestScheduleSettings,
} from "./modules/digest-schedule";
import { RateLimitedError, type RetryDeps } from "./modules/http-retry";
import { sqlSessionFor } from "./modules/db/sql";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";

export const DIGEST_QUEUE_NAMES = ["reading-lite-digest", "reading-lite-staging-digest"] as const;
export const DIGEST_DLQ_NAMES = ["reading-lite-digest-dlq", "reading-lite-staging-digest-dlq"] as const;

/**
 * Age a pending ledger row must reach before fan-out may `queue.send` again.
 * One 15-minute cron interval, and longer than the digest 429 retry cap (5 min).
 */
export const DIGEST_PENDING_STALE_MS = 15 * 60_000;

export function isStaleDigestPending(updatedAtMs: number, nowMs: number): boolean {
  return nowMs - updatedAtMs >= DIGEST_PENDING_STALE_MS;
}

export function isDigestQueue(name: string): boolean {
  return (DIGEST_QUEUE_NAMES as readonly string[]).includes(name);
}

export function isDigestDlq(name: string): boolean {
  return (DIGEST_DLQ_NAMES as readonly string[]).includes(name);
}

export interface DigestEnv {
  CONTROL_PLANE: D1Database;
  DIGEST_JOBS?: Queue<DigestEnvelopeV1>;
  HYPERDRIVE?: Hyperdrive;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  EMAIL_TO?: string;
  WEB_BASE_URL?: string;
  APP_ENV?: string;
  AUTH_MAIL_ALLOWLIST?: string;
  FOUNDER_EMAIL?: string;
}

export interface DigestJobDeps {
  nowMs: number;
  fetch?: typeof fetch;
  retry?: RetryDeps;
}

interface EnabledDigestRow extends DigestScheduleSettings {
  user_id: string;
  digest_cadence: "daily" | "weekly";
}

export async function listEnabledDigestUsers(db: ControlPlaneDb): Promise<EnabledDigestRow[]> {
  return db.all<EnabledDigestRow>(
    `SELECT s.user_id, s.digest_cadence, s.time_zone, s.digest_hour_local, s.digest_weekday
       FROM user_settings s
       JOIN users u ON u.id = s.user_id
      WHERE s.digest_cadence IN ('daily', 'weekly')
        AND u.status = 'active'
        AND u.email_verified_at_ms IS NOT NULL
      ORDER BY s.user_id`
  );
}

export function selectDueDigestUsers(
  rows: readonly EnabledDigestRow[],
  now: Date,
): Array<EnabledDigestRow & { period_key: string }> {
  const due: Array<EnabledDigestRow & { period_key: string }> = [];
  for (const row of rows) {
    const verdict = digestDueAt(row, now);
    if (!verdict.due) {
      if (verdict.reason === "invalid_time_zone") {
        console.warn(
          JSON.stringify({
            event: "digest_skipped",
            user_id: row.user_id,
            reason: "invalid_time_zone",
          }),
        );
      }
      continue;
    }
    due.push({ ...row, period_key: verdict.period_key });
  }
  return due;
}

/** Due-hour users plus leftover *stale* pending rows still in the current local period. */
export function selectFanOutDigestUsers(
  rows: readonly EnabledDigestRow[],
  pendingIds: ReadonlySet<string>,
  now: Date,
): Array<EnabledDigestRow & { period_key: string }> {
  const selected: Array<EnabledDigestRow & { period_key: string }> = [];
  const seen = new Set<string>();
  const push = (row: EnabledDigestRow, period_key: string, cadence: "daily" | "weekly") => {
    const id = digestDeliveryKeyId({ userId: row.user_id, cadence, periodKey: period_key });
    if (seen.has(id)) return;
    seen.add(id);
    selected.push({ ...row, digest_cadence: cadence, period_key });
  };

  for (const row of selectDueDigestUsers(rows, now)) {
    push(row, row.period_key, row.digest_cadence);
  }
  for (const row of rows) {
    const current = currentPeriodKey(row, now);
    if (!current.ok) continue;
    const id = digestDeliveryKeyId({
      userId: row.user_id,
      cadence: current.cadence,
      periodKey: current.period_key,
    });
    if (pendingIds.has(id)) push(row, current.period_key, current.cadence);
  }
  return selected;
}

export async function fanOutDueDigests(
  env: DigestEnv,
  deps: { nowMs: number },
): Promise<{ enqueued: number }> {
  const queue = env.DIGEST_JOBS;
  if (!queue) {
    console.warn(JSON.stringify({ event: "digest_fanout_skipped", reason: "queue_unbound" }));
    return { enqueued: 0 };
  }
  const db = fromD1(env.CONTROL_PLANE);
  const now = new Date(deps.nowMs);
  const pendingIds = new Set(
    (await listPendingDigestDeliveries(db))
      .filter((row) => isStaleDigestPending(row.updated_at_ms, deps.nowMs))
      .map((key) => digestDeliveryKeyId(key)),
  );
  const due = selectFanOutDigestUsers(await listEnabledDigestUsers(db), pendingIds, now);
  let enqueued = 0;
  for (const row of due) {
    const key: DigestDeliveryKey = {
      userId: row.user_id,
      cadence: row.digest_cadence,
      periodKey: row.period_key,
    };
    try {
      const tenantId = parseTenantId(row.user_id);
      const userId = parseUserId(row.user_id);
      if (!tenantId || !userId) continue;
      const claim = await claimPendingDigestDelivery(db, key, deps.nowMs);
      if (claim === "terminal") continue;
      if (claim === "pending") {
        const existing = await getDigestDelivery(db, key);
        if (!existing || !isStaleDigestPending(existing.updated_at_ms, deps.nowMs)) continue;
      }
      try {
        await queue.send(
          digestEnvelopeV1({
            tenantId,
            userId,
            period_key: row.period_key,
            cadence: row.digest_cadence,
          }),
        );
        if (claim === "pending") {
          await touchPendingDigestDelivery(db, key, deps.nowMs);
        }
        enqueued += 1;
      } catch (error) {
        if (claim === "inserted") {
          try {
            await deletePendingDigestDelivery(db, key);
          } catch (releaseError) {
            console.error(
              JSON.stringify({
                event: "digest_pending_release_failed",
                user_id: row.user_id,
                message: releaseError instanceof Error ? releaseError.message : String(releaseError),
              }),
            );
          }
        }
        throw error;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "digest_fanout_user_failed",
          user_id: row.user_id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return { enqueued };
}

export async function processDigestJob(
  envelope: DigestEnvelopeV1,
  env: DigestEnv,
  deps: DigestJobDeps,
): Promise<void> {
  const db = fromD1(env.CONTROL_PLANE);
  const key: DigestDeliveryKey = {
    userId: envelope.userId,
    cadence: envelope.cadence,
    periodKey: envelope.period_key,
  };
  const existing = await getDigestDelivery(db, key);
  if (existing?.status === "sent" || existing?.status === "skipped" || existing?.status === "failed") {
    return;
  }

  const verdict = await sendTimeVerdict(db, envelope, env, deps.nowMs);
  if (verdict.kind === "skip") {
    if (verdict.reason === "invalid_time_zone") {
      console.warn(
        JSON.stringify({
          event: "digest_skipped",
          user_id: envelope.userId,
          reason: "invalid_time_zone",
        }),
      );
    }
    await finalizeDigestDelivery(db, key, { status: "skipped", reason: verdict.reason }, deps.nowMs);
    return;
  }

  const now = new Date(deps.nowMs);
  const window = digestWindow(envelope.cadence, verdict.settings.time_zone, now);
  if (!window) {
    await finalizeDigestDelivery(
      db,
      key,
      { status: "skipped", reason: "invalid_time_zone" },
      deps.nowMs,
    );
    return;
  }

  const tenantId = parseTenantId(envelope.tenantId);
  if (!tenantId) {
    await finalizeDigestDelivery(db, key, { status: "skipped", reason: "missing_user" }, deps.nowMs);
    return;
  }
  if (!env.HYPERDRIVE) {
    throw new Error("HYPERDRIVE is not configured");
  }

  const sql = sqlSessionFor({ HYPERDRIVE: env.HYPERDRIVE });
  let library;
  try {
    library = await pgReadingStoreFor(sql, { tenantId }).allListItems();
  } finally {
    await sql.end();
  }
  const items = selectDigestReadings(library, window);
  if (items.length === 0) {
    await finalizeDigestDelivery(
      db,
      key,
      { status: "skipped", reason: "empty_window" },
      deps.nowMs,
    );
    return;
  }

  if (existing?.status !== "pending") {
    const claim = await claimPendingDigestDelivery(db, key, deps.nowMs);
    if (claim === "terminal") return;
  }

  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  try {
    const sent = await sendDigestEmail(
      {
        cadence: envelope.cadence,
        items,
        webBaseUrl: env.WEB_BASE_URL ?? "",
        titleById: buildTitleById({ version: 1, items: library }),
      },
      {
        fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
        apiKey,
        from: verdict.from,
        to: verdict.to,
        retry: deps.retry,
        idempotencyKey: digestDeliveryKeyId(key),
      },
    );
    await finalizeDigestDelivery(
      db,
      key,
      { status: "sent", resendId: sent.id },
      deps.nowMs,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "digest_send_failed",
        user_id: envelope.userId,
        message: redactEmailsInText(error instanceof Error ? error.message : String(error), [
          verdict.to,
          env.EMAIL_FROM,
        ]),
      }),
    );
    throw error;
  }
}

export async function consumeDigestMessage(
  msg: {
    body: unknown;
    ack: () => void;
    retry: (opts?: { delaySeconds?: number }) => void;
    attempts?: number;
  },
  env: DigestEnv,
  deps: DigestJobDeps,
): Promise<void> {
  const parsed = parseDigestEnvelope(msg.body);
  if (!parsed.ok) {
    logDigestEnvelopeRejected(parsed.reason);
    msg.ack();
    return;
  }
  try {
    await processDigestJob(parsed.envelope, env, deps);
    msg.ack();
  } catch (error) {
    if (error instanceof RateLimitedError) {
      msg.retry({ delaySeconds: digestRetryDelaySeconds(error, msg.attempts ?? 1) });
      return;
    }
    msg.retry();
  }
}

export async function handleDigestDeadLetter(
  msg: { body: unknown; ack: () => void },
  env: DigestEnv,
  deps: { nowMs: number },
): Promise<void> {
  try {
    const parsed = parseDigestEnvelope(msg.body);
    if (parsed.ok) {
      await finalizeDigestDelivery(
        fromD1(env.CONTROL_PLANE),
        {
          userId: parsed.envelope.userId,
          cadence: parsed.envelope.cadence,
          periodKey: parsed.envelope.period_key,
        },
        { status: "failed" },
        deps.nowMs,
      );
    }
  } catch (error) {
    console.error(error);
  } finally {
    msg.ack();
  }
}

async function sendTimeVerdict(
  db: ControlPlaneDb,
  envelope: DigestEnvelopeV1,
  env: DigestEnv,
  nowMs: number,
): Promise<
  | { kind: "skip"; reason: DigestSkipReason }
  | { kind: "send"; settings: DigestScheduleSettings; to: string; from: string }
> {
  const user = await db.first<{ status: string; email_verified_at_ms: number | null }>(
    "SELECT status, email_verified_at_ms FROM users WHERE id = ?",
    envelope.userId,
  );
  if (!user) return { kind: "skip", reason: "missing_user" };
  if (user.status !== "active") return { kind: "skip", reason: "inactive_user" };
  if (user.email_verified_at_ms == null) return { kind: "skip", reason: "unverified_email" };

  const settings = await db.first<DigestScheduleSettings>(
    `SELECT digest_cadence, time_zone, digest_hour_local, digest_weekday
       FROM user_settings WHERE user_id = ?`,
    envelope.userId,
  );
  if (!settings) return { kind: "skip", reason: "missing_settings" };
  if (settings.digest_cadence === "off") return { kind: "skip", reason: "cadence_off" };

  // Hour/weekday gate enqueue only. Send re-reads cadence, TZ, and whether
  // the envelope's period_key is still this local day/week.
  const current = currentPeriodKey(settings, new Date(nowMs));
  if (!current.ok) return { kind: "skip", reason: current.reason };
  if (current.cadence !== envelope.cadence || current.period_key !== envelope.period_key) {
    return { kind: "skip", reason: "schedule_mismatch" };
  }

  const recipient = await resolveDigestRecipient(db, env, envelope.userId);
  if (recipient.kind === "skip") return { kind: "skip", reason: recipient.reason };
  return { kind: "send", settings, to: recipient.to, from: recipient.from };
}

function digestRetryDelaySeconds(error: RateLimitedError, attempts: number): number {
  const defaultMs = 30_000;
  const maxMs = 300_000;
  const ms =
    error.retryAfterMs !== null
      ? error.retryAfterMs
      : Math.min(maxMs, defaultMs * 2 ** Math.max(0, attempts - 1));
  return Math.max(1, Math.min(43_200, Math.ceil(ms / 1000)));
}
