import type { TenantContext } from "./control-plane/ids";
import { fromD1 } from "./control-plane/db";
import {
  admitEnvelopeOrReject,
  consumeProcessReadingMessage,
  logEnvelopeRejected,
  parseProcessReadingEnvelope,
  type ProcessReadingEnvelopeV1,
} from "./control-plane/envelope";
import { createApp } from "./router";
import { processReading, markDeadLettered, type ProcessReadingArgs } from "./process-reading";
import { RateLimitedError } from "./modules/http-retry";
import { defaultServices } from "./services";

export interface Env {
  READINGS_BUCKET: R2Bucket;
  READINGS_INDEX: VectorizeIndex;
  CONTROL_PLANE: D1Database;
  // Optional so the router can return a clear 503 when the binding is missing
  // (e.g. wrangler dev without a queue binding) instead of a runtime crash.
  READING_JOBS?: Queue<ProcessReadingEnvelopeV1>;
  // Imported once into D1 as the founder legacy token. Not a runtime auth fallback.
  READER_API_TOKEN: string;
  AUTH_ROOT_SECRET: string;
  AUTH_ROOT_KEY_VERSION?: string;
  AUTH_PREVIOUS_ROOT_SECRET?: string;
  AUTH_PREVIOUS_ROOT_KEY_VERSION?: string;
  FOUNDER_EMAIL?: string;
  APP_ENV?: string;
  AUTH_MAIL_ALLOWLIST?: string;
  AUTH_RATE_GUARD?: DurableObjectNamespace;
  AUTH_RATE_EMAIL_WINDOW_MS?: string;
  AUTH_RATE_EMAIL_MAX?: string;
  AUTH_RATE_IP_WINDOW_MS?: string;
  AUTH_RATE_IP_MAX?: string;
  AUTH_RATE_GLOBAL_WINDOW_MS?: string;
  AUTH_RATE_GLOBAL_MAX?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY: string;
  X_API_BEARER_TOKEN?: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  EMAIL_TO: string;
  WEB_BASE_URL: string;
  CORS_ALLOWED_ORIGINS: string;
  MCP_ALLOWED_ORIGINS: string;
  PENDING_TTL_SECONDS: string;
  FETCH_TIMEOUT_MS: string;
  FETCH_MAX_BYTES: string;
  ANTHROPIC_MODEL: string;
  SUMMARIZER_PROVIDER?: string;
  OPENAI_SUMMARIZATION_MODEL?: string;
  OPENAI_SUMMARIZATION_REASONING_EFFORT?: string;
  ANTHROPIC_SUMMARIZATION_REASONING_EFFORT?: string;
  // "1" enables tenant-prefixed R2 keys (u/{tenantId}/…). Off by default so
  // production/staging keep the founder corpus visible until s1k.6 copies it.
  TENANT_DATA_PLANE?: string;
  LOCAL_MAIL_SINK?: string;
  // Public Turnstile widget site key. GET /api/auth/login-options returns it
  // only when signup_mode is open. The matching secret is TURNSTILE_SECRET_KEY
  // (wrangler secret; never a [vars] value).
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  RETRY_MAX_ATTEMPTS?: string;
  RETRY_BASE_DELAY_MS?: string;
  RETRY_MAX_DELAY_MS?: string;
}

const app = createApp();

// Exponential default when the upstream did not include a Retry-After header.
// 30s on the first delivery, doubling up to a 5-minute cap.
const RATE_LIMIT_DEFAULT_DELAY_MS = 30_000;
const RATE_LIMIT_MAX_DELAY_MS = 300_000;
// Cloudflare Queues caps msg.retry({delaySeconds}) at 12 hours.
const QUEUE_MAX_DELAY_SECONDS = 43_200;

// Messages that exhaust their retries on the main queue land here (see
// dead_letter_queue in wrangler.toml). The same worker consumes it.
const DEAD_LETTER_QUEUE = "reading-lite-dlq";

export async function dispatchQueueMessage(
  msg: Message<unknown>,
  process: () => Promise<void>,
): Promise<void> {
  try {
    await process();
    msg.ack();
  } catch (e) {
    if (e instanceof RateLimitedError) {
      msg.retry({ delaySeconds: rateLimitedDelaySeconds(e, msg.attempts) });
      return;
    }
    // processReading writes a failed manifest before throwing for application
    // errors. Redelivery would just repeat the same upstream error. Log + ack.
    console.error(e);
    msg.ack();
  }
}

// A message reaches the dead-letter queue only after exhausting its retries on
// the main queue — almost always because the upstream stayed rate-limited past
// the retry budget. Without this, the message would silently vanish and its
// manifest would stay stranded `pending+running` forever. We convert it into a
// visible, retryable `failed` manifest and ack (the DLQ is terminal; never
// retry, or the message could loop).
export async function handleDeadLetter(
  msg: Message<unknown>,
  deps: {
    db: ReturnType<typeof fromD1>;
    nowMs: number;
    mark: (body: ProcessReadingArgs, tenant: TenantContext) => Promise<void>;
  },
): Promise<void> {
  const parsed = parseProcessReadingEnvelope(msg.body);
  if (!parsed.ok) {
    logEnvelopeRejected(parsed.reason);
    msg.ack();
    return;
  }
  try {
    const admitted = await admitEnvelopeOrReject(deps.db, parsed.envelope, deps.nowMs);
    if (!admitted.ok) {
      if ("reason" in admitted && admitted.reason === "malformed_job") {
        logEnvelopeRejected("malformed_job");
      }
      return;
    }
    await deps.mark(parsed.envelope.job, admitted.tenant);
  } catch (e) {
    console.error(e);
  } finally {
    msg.ack();
  }
}

function rateLimitedDelaySeconds(e: RateLimitedError, attempts: number): number {
  const ms =
    e.retryAfterMs !== null
      ? e.retryAfterMs
      : Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_DEFAULT_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  const seconds = Math.ceil(ms / 1000);
  return Math.max(1, Math.min(QUEUE_MAX_DELAY_SECONDS, seconds));
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const services = defaultServices();
    if (batch.queue === DEAD_LETTER_QUEUE) {
      const db = fromD1(env.CONTROL_PLANE);
      const nowMs = Date.now();
      for (const msg of batch.messages) {
        await handleDeadLetter(msg, {
          db,
          nowMs,
          mark: (body, tenant) => markDeadLettered(body, env, services, tenant),
        });
      }
      return;
    }
    for (const msg of batch.messages) {
      await consumeProcessReadingMessage(msg, {
        db: fromD1(env.CONTROL_PLANE),
        nowMs: Date.now(),
        process: (job, tenant) =>
          dispatchQueueMessage(msg, () => processReading(job, env, services, tenant)),
      });
    }
  },
};

export { createApp } from "./router";
export { AuthRateGuard } from "./control-plane/auth-rate-guard";
