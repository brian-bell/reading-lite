/**
 * Digest pipeline (issue 196 B1): cron due-selection + DIGEST_JOBS fan-out
 * and a stub send consumer. One job per tenant. The consumer re-reads
 * settings immediately before "send" and honors opt-out; it does not call
 * Resend or build digest HTML (196 B2). Send-time re-read checks cadence, TZ,
 * recipient, and that `period_key` still matches the current local day/week.
 * Hour and weekday matching is enqueue-only so a delayed/retried job in the
 * same period still stub-sends. Fan-out also re-enqueues current-period
 * `pending` rows (via `currentPeriodKey`) so a producer miss through the due
 * hour can still land on DIGEST_JOBS later that day/week. A `queue.send`
 * failure after this tick *inserted* a pending claim deletes that row so a
 * later tick can claim again. An already-existing `pending` row is left in
 * place: it belongs to an earlier enqueue still in flight. Each tenant is
 * claimed+enqueued in its own try/catch so one failure cannot abort the rest
 * of the cron tick.
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
  type DigestDeliveryKey,
  type DigestSkipReason,
} from "./control-plane/digest-ledger";
import { parseTenantId, parseUserId } from "./control-plane/ids";
import { resolveDigestRecipient } from "./control-plane/reading-notification";
import { currentPeriodKey, digestDueAt, type DigestScheduleSettings } from "./modules/digest-schedule";

export const DIGEST_QUEUE_NAMES = ["reading-lite-digest", "reading-lite-staging-digest"] as const;
export const DIGEST_DLQ_NAMES = ["reading-lite-digest-dlq", "reading-lite-staging-digest-dlq"] as const;

export function isDigestQueue(name: string): boolean {
  return (DIGEST_QUEUE_NAMES as readonly string[]).includes(name);
}

export function isDigestDlq(name: string): boolean {
  return (DIGEST_DLQ_NAMES as readonly string[]).includes(name);
}

export interface DigestEnv {
  CONTROL_PLANE: D1Database;
  DIGEST_JOBS?: Queue<DigestEnvelopeV1>;
  EMAIL_FROM: string;
  APP_ENV?: string;
  AUTH_MAIL_ALLOWLIST?: string;
  FOUNDER_EMAIL?: string;
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

/** Due-hour users plus leftover pending rows still in the current local period. */
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
    (await listPendingDigestDeliveries(db)).map((key) => digestDeliveryKeyId(key)),
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
      try {
        await queue.send(
          digestEnvelopeV1({
            tenantId,
            userId,
            period_key: row.period_key,
            cadence: row.digest_cadence,
          }),
        );
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
  deps: { nowMs: number },
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

  const skip = await sendTimeSkipReason(db, envelope, env, deps.nowMs);
  if (skip) {
    if (skip === "invalid_time_zone") {
      console.warn(
        JSON.stringify({
          event: "digest_skipped",
          user_id: envelope.userId,
          reason: "invalid_time_zone",
        }),
      );
    }
    await finalizeDigestDelivery(db, key, { status: "skipped", reason: skip }, deps.nowMs);
    return;
  }

  await finalizeDigestDelivery(db, key, { status: "sent" }, deps.nowMs);
}

export async function consumeDigestMessage(
  msg: { body: unknown; ack: () => void; retry: () => void },
  env: DigestEnv,
  deps: { nowMs: number },
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
    console.error(error);
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

async function sendTimeSkipReason(
  db: ControlPlaneDb,
  envelope: DigestEnvelopeV1,
  env: DigestEnv,
  nowMs: number,
): Promise<DigestSkipReason | null> {
  const user = await db.first<{ status: string; email_verified_at_ms: number | null }>(
    "SELECT status, email_verified_at_ms FROM users WHERE id = ?",
    envelope.userId,
  );
  if (!user) return "missing_user";
  if (user.status !== "active") return "inactive_user";
  if (user.email_verified_at_ms == null) return "unverified_email";

  const settings = await db.first<DigestScheduleSettings>(
    `SELECT digest_cadence, time_zone, digest_hour_local, digest_weekday
       FROM user_settings WHERE user_id = ?`,
    envelope.userId,
  );
  if (!settings) return "missing_settings";
  if (settings.digest_cadence === "off") return "cadence_off";

  // Hour/weekday gate enqueue only. Send re-reads cadence, TZ, and whether
  // the envelope's period_key is still this local day/week.
  const current = currentPeriodKey(settings, new Date(nowMs));
  if (!current.ok) return current.reason;
  if (current.cadence !== envelope.cadence || current.period_key !== envelope.period_key) {
    return "schedule_mismatch";
  }

  const recipient = await resolveDigestRecipient(db, env, envelope.userId);
  if (recipient.kind === "skip") return recipient.reason;
  return null;
}
