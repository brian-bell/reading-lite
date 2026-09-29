import { env } from "cloudflare:test";
import { vi } from "vitest";
import {
  consumeProcessReadingMessage,
  type ProcessReadingEnvelopeV1,
} from "../../src/control-plane/envelope";
import { type Env } from "../../src/index";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { mintReadingId, type Services } from "../../src/services";
import { FOUNDER_TENANT_ID, PUBLIC_LOOKUP } from "../helpers/tenant-fixtures";
import { testControlPlane } from "../helpers/control-plane-db";

export async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

// Production sends ProcessReadingEnvelopeV1 through Cloudflare Queues. Miniflare
// has no native queue emulator (and per CLAUDE.md adding the binding to
// wrangler.test.toml hangs the runtime), so we install a stub that captures
// `send()` calls. `queuedJobs` is the job view used by existing assertions;
// `queuedEnvelopes` is the on-the-wire v1 payload. `drainQueue` runs the
// fail-closed consumer (validate + admit founder tenant/token) then processReading.
export let queuedEnvelopes: ProcessReadingEnvelopeV1[] = [];
export let queuedJobs: ProcessReadingArgs[] = [];
export function installQueueStub(): ProcessReadingArgs[] {
  queuedEnvelopes = [];
  queuedJobs = [];
  (env as unknown as { READING_JOBS: Queue<ProcessReadingEnvelopeV1> }).READING_JOBS = {
    send: vi.fn(async (msg: ProcessReadingEnvelopeV1) => {
      queuedEnvelopes.push(msg);
      queuedJobs.push(msg.job);
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
  return queuedJobs;
}

export function installRejectingQueueStub(error: unknown = new Error("queue send failed")) {
  (env as unknown as { READING_JOBS: Queue<ProcessReadingEnvelopeV1> }).READING_JOBS = {
    send: vi.fn(async () => {
      throw error;
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
}

export async function drainQueue(services: Services): Promise<void> {
  while (queuedEnvelopes.length > 0) {
    const envelope = queuedEnvelopes.shift()!;
    queuedJobs.shift();
    await consumeProcessReadingMessage(
      { body: envelope, ack() {} },
      {
        db: testControlPlane((env as unknown as Env)),
        nowMs: Date.now(),
        process: (job, tenant) => processReading(job, env as unknown as Env, services, tenant),
      },
    );
  }
}

export const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

export function makeStubFetch(opts: {
  source?: { status?: number; body?: string; contentType?: string };
  embedding?: number[];
  toolInput?: Record<string, unknown>;
  // Derive the summarizer's structured output from the request it was sent,
  // instead of returning the canned `toolInput`. Lets a test make connections
  // a faithful echo of the neighbours the prompt actually cited, so a
  // cross-tenant similarity leak surfaces in the terminal manifest.
  toolInputFromRequest?: (requestBody: string) => Record<string, unknown>;
  anthropicStatus?: number;
  anthropicBody?: unknown;
  // Replaces the OpenAI summarizer's success response.
  openaiResponses?: { status: number; body: unknown };
  resendStatus?: number;
  resendBody?: unknown;
} = {}) {
  const source = opts.source ?? {
    status: 200,
    body: HTML,
    contentType: "text/html; charset=utf-8",
  };
  const embedding = opts.embedding ?? new Array(1536).fill(0.1);
  const toolInput = opts.toolInput ?? {
    title: "Test Article",
    tldr: "A short summary.",
    tags: ["test"],
    keywords: ["test", "article", "integration"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: "summary body",
  };
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const requestBody = async () =>
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : "";
    const summaryToolInput = async () =>
      opts.toolInputFromRequest ? opts.toolInputFromRequest(await requestBody()) : toolInput;
    if (url.startsWith("https://api.openai.com/v1/embeddings")) {
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.openai.com/v1/responses") && opts.openaiResponses) {
      return new Response(JSON.stringify(opts.openaiResponses.body), {
        status: opts.openaiResponses.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.openai.com/v1/responses")) {
      return new Response(
        JSON.stringify({
          id: "resp_01",
          object: "response",
          status: "completed",
          output: [
            {
              id: "msg_01",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(await summaryToolInput()),
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 10,
            },
            output_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 150,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      const status = opts.anthropicStatus ?? 200;
      const body = opts.anthropicBody ?? {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_01", name: "emit_reading", input: await summaryToolInput() }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.resend.com/emails")) {
      const status = opts.resendStatus ?? 200;
      const body = opts.resendBody ?? { id: "resend_01" };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // Source URL (or anything else) falls through to the source stub.
    return new Response(source.body, {
      status: source.status,
      headers: source.contentType ? { "content-type": source.contentType } : {},
    });
  });
  return fetchFn;
}

export function resendCalls(fetchFn: ReturnType<typeof makeStubFetch>) {
  return fetchFn.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://api.resend.com/emails");
  });
}

export function makeServices(fetchFn: typeof fetch, idCounter = { n: 0 }, baseTime = "2026-04-26T20:00:00.000Z"): Services {
  const start = Date.parse(baseTime);
  return {
    fetch: fetchFn,
    lookup: PUBLIC_LOOKUP,
    now: () => new Date(start + idCounter.n * 1000).toISOString(),
    newId: () => {
      idCounter.n++;
      return mintReadingId();
    },
  };
}

export const TOKEN = "test-token";

export function founderObjectKey(relative: string): string {
  return `u/${FOUNDER_TENANT_ID}/${relative}`;
}
