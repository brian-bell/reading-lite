import { createApp } from "./router";
import { processReading, type ProcessReadingArgs } from "./process-reading";
import { RateLimitedError } from "./modules/http-retry";
import { defaultServices } from "./services";

export interface Env {
  READINGS_BUCKET: R2Bucket;
  READINGS_INDEX: VectorizeIndex;
  READING_JOBS: Queue<ProcessReadingArgs>;
  READER_API_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  CORS_ALLOWED_ORIGINS: string;
  PENDING_TTL_SECONDS: string;
  FETCH_TIMEOUT_MS: string;
  FETCH_MAX_BYTES: string;
  ANTHROPIC_MODEL: string;
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
    for (const msg of batch.messages) {
      await dispatchQueueMessage(msg, (body) => processReading(body, env, services));
    }
  },
};

export { createApp } from "./router";
