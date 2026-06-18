import { z } from "zod";
import { EMBEDDING_DIM } from "../../../src/schemas/api";

// REST clients for the bulk path. The Anthropic Message Batches API runs the
// forced-tool-use summarize asynchronously (50% cheaper, no rate-limit burst);
// OpenAI embeddings stay realtime but coalesced (array input) to avoid a burst.
// fetch is injected so tests stub it.

const ANTHROPIC_BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

export interface AnthropicBatchRequest {
  custom_id: string;
  params: object;
}

export interface BatchInfo {
  id: string;
  processing_status: string;
  results_url: string | null;
  request_counts?: Record<string, number>;
}

export type BatchResultBody =
  | { type: "succeeded"; message: { content: Array<{ type: string; [k: string]: unknown }>; usage: { input_tokens: number; output_tokens: number; [k: string]: number } } }
  | { type: "errored"; error: unknown }
  | { type: "canceled" }
  | { type: "expired" };

export interface BatchResult {
  custom_id: string;
  result: BatchResultBody;
}

export interface AnthropicBatchDeps {
  fetch: typeof fetch;
  apiKey: string;
  version?: string;
}

export interface AnthropicBatchClient {
  create(requests: AnthropicBatchRequest[]): Promise<BatchInfo>;
  get(batchId: string): Promise<BatchInfo>;
  results(resultsUrl: string): Promise<BatchResult[]>;
}

const BatchInfoSchema = z.object({
  id: z.string(),
  processing_status: z.string(),
  results_url: z.string().nullable().default(null),
  request_counts: z.record(z.number()).optional(),
});

export function makeAnthropicBatchClient(deps: AnthropicBatchDeps): AnthropicBatchClient {
  const headers = {
    "x-api-key": deps.apiKey,
    "anthropic-version": deps.version ?? ANTHROPIC_VERSION,
    "content-type": "application/json",
  };

  const parseInfo = async (res: Response, what: string): Promise<BatchInfo> => {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic batch ${what} failed: ${res.status} ${text}`);
    }
    return BatchInfoSchema.parse(await res.json());
  };

  return {
    async create(requests) {
      const res = await deps.fetch(ANTHROPIC_BATCHES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ requests }),
      });
      return parseInfo(res, "create");
    },
    async get(batchId) {
      const res = await deps.fetch(`${ANTHROPIC_BATCHES_URL}/${batchId}`, {
        method: "GET",
        headers,
      });
      return parseInfo(res, "get");
    },
    async results(resultsUrl) {
      const res = await deps.fetch(resultsUrl, { method: "GET", headers });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Anthropic batch results failed: ${res.status} ${text}`);
      }
      const text = await res.text();
      // Isolate per-line parse failures: a single malformed line shouldn't
      // discard the whole batch's results. Dropped lines surface downstream as
      // missing results (marked retryable failed by the write phase).
      const out: BatchResult[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as BatchResult);
        } catch {
          /* skip malformed line */
        }
      }
      return out;
    },
  };
}

export interface OpenAIEmbedDeps {
  fetch: typeof fetch;
  apiKey: string;
  model?: string;
}

export interface OpenAIEmbedClient {
  embedMany(inputs: string[]): Promise<number[][]>;
}

const EmbedResponseSchema = z.object({
  data: z
    .array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).length(EMBEDDING_DIM) }))
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), total_tokens: z.number() }),
});

export function makeOpenAIEmbedClient(
  deps: OpenAIEmbedDeps,
  opts: { chunkSize?: number } = {},
): OpenAIEmbedClient {
  const chunkSize = opts.chunkSize ?? 96;
  const model = deps.model ?? OPENAI_EMBEDDING_MODEL;

  return {
    async embedMany(inputs) {
      if (inputs.length === 0) return [];
      if (inputs.some((s) => s.length === 0)) {
        throw new Error("embedMany: inputs must be non-empty strings");
      }
      const out: number[][] = [];
      for (let i = 0; i < inputs.length; i += chunkSize) {
        const chunk = inputs.slice(i, i + chunkSize);
        const res = await deps.fetch(OPENAI_EMBEDDINGS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, input: chunk }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`OpenAI embeddings failed: ${res.status} ${text}`);
        }
        const parsed = EmbedResponseSchema.parse(await res.json());
        // The API may return data out of order; sort by `index` so each vector
        // lines up with its input position within the chunk.
        const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
        for (const d of ordered) out.push(d.embedding);
      }
      return out;
    },
  };
}
