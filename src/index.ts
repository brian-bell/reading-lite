import { createApp } from "./router";
import { processReading, type ProcessReadingArgs } from "./process-reading";
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<ProcessReadingArgs>, env: Env): Promise<void> {
    const services = defaultServices();
    for (const msg of batch.messages) {
      try {
        await processReading(msg.body, env, services);
      } catch (e) {
        // processReading writes a failed manifest before throwing. Redeliver
        // is wasteful — the same upstream error will recur. Log and ack.
        console.error(e);
      }
      msg.ack();
    }
  },
};

export { createApp } from "./router";
