import { createApp } from "./router";
import { processReading, markDeadLettered, type ProcessReadingArgs } from "./process-reading";
import { RateLimitedError } from "./modules/http-retry";
import { defaultServices } from "./services";

export interface Env {
  READINGS_BUCKET: R2Bucket;
  READINGS_INDEX: VectorizeIndex;
  // Optional so the router can return a clear 503 when the binding is missing
  // (e.g. wrangler dev without a queue binding) instead of a runtime crash.
  READING_JOBS?: Queue<ProcessReadingArgs>;
  READER_API_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  EMAIL_TO: string;
  WEB_BASE_URL: string;
  CORS_ALLOWED_ORIGINS: string;
  PENDING_TTL_SECONDS: string;
  FETCH_TIMEOUT_MS: string;
  FETCH_MAX_BYTES: string;
  ANTHROPIC_MODEL: string;
  SUMMARIZER_PROVIDER?: string;
  OPENAI_SUMMARIZATION_MODEL?: string;
  OPENAI_SUMMARIZATION_REASONING_EFFORT?: string;
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
  msg: Message<ProcessReadingArgs>,
  process: (body: ProcessReadingArgs) => Promise<void>,
): Promise<void> {
  try {
    await process(msg.body);
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
  msg: Message<ProcessReadingArgs>,
  mark: (body: ProcessReadingArgs) => Promise<void>,
): Promise<void> {
  try {
    await mark(msg.body);
  } catch (e) {
    console.error(e);
  }
  msg.ack();
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
  async queue(batch: MessageBatch<ProcessReadingArgs>, env: Env): Promise<void> {
    const services = defaultServices();
    if (batch.queue === DEAD_LETTER_QUEUE) {
      for (const msg of batch.messages) {
        await handleDeadLetter(msg, (body) => markDeadLettered(body, env, services));
      }
      return;
    }
    for (const msg of batch.messages) {
      await dispatchQueueMessage(msg, (body) => processReading(body, env, services));
    }
  },
};

export { createApp } from "./router";
