import { z } from "zod";
import { EMBEDDING_DIM } from "../../../src/schemas/api";

// REST clients for the bulk path. The Anthropic Message Batches API runs the
// tool-use summarize asynchronously (50% cheaper, no rate-limit burst);
// OpenAI embeddings stay realtime but coalesced (array input) to avoid a burst.
// fetch is injected so tests stub it.

const ANTHROPIC_BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
const OPENAI_BATCHES_URL = "https://api.openai.com/v1/batches";
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

export interface OpenAIBatchDeps {
  fetch: typeof fetch;
  apiKey: string;
}

export interface OpenAIFile {
  id: string;
  filename: string;
  purpose: string;
  bytes: number;
}

export interface OpenAIBatchClient {
  upload(jsonl: string, runId: string): Promise<OpenAIFile>;
  create(inputFileId: string, runId: string): Promise<OpenAIBatchInfo>;
  get(batchId: string): Promise<OpenAIBatchInfo>;
  content(fileId: string): Promise<string>;
  listFiles(opts?: {
    purpose?: string;
    after?: string;
    limit?: number;
  }): Promise<{
    data: OpenAIFile[];
    has_more: boolean;
    last_id?: string;
  }>;
  listBatches(opts?: {
    after?: string;
    limit?: number;
  }): Promise<{
    // Permissively parsed batch info (any endpoint / completion window).
    data: OpenAIBatchInfo[];
    // Raw batch objects parallel to `data`, so reconcilers can re-validate
    // a matched batch with the strict `/v1/responses` schema before adopting.
    raw: unknown[];
    has_more: boolean;
    last_id?: string;
  }>;
}

export class OpenAIBatchError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenAIBatchError";
  }
}

const OpenAIFileSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("file"),
    bytes: z.number().int().nonnegative(),
    filename: z.string().min(1),
    purpose: z.string().min(1),
  })
  .passthrough();

// List endpoints must fail closed on a 200 that is not a list page. Defaulting
// a missing/non-array `data` to [] looks like "no remote objects" and would
// re-upload / re-create, leaving duplicates that make later resumes ambiguous.
const OpenAIListEnvelopeSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(z.unknown()),
    has_more: z.boolean(),
    last_id: z.string().min(1).nullish(),
  })
  .passthrough();

function parseOpenAIListEnvelope(
  body: unknown,
  operation: "files list" | "batches list",
): { data: unknown[]; has_more: boolean; last_id?: string } {
  const parsed = OpenAIListEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenAIBatchError(
      operation,
      200,
      `OpenAI ${operation} returned a malformed list envelope (${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")})`,
    );
  }
  return {
    data: parsed.data.data,
    has_more: parsed.data.has_more,
    ...(parsed.data.last_id ? { last_id: parsed.data.last_id } : {}),
  };
}

export interface OpenAIBatchInfo {
  id: string;
  input_file_id: string;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  request_counts: {
    total: number;
    completed: number;
    failed: number;
  };
  // The API may omit metadata or return null. Reconcilers key on
  // `metadata?.run_id` to adopt remote batches created by prior runs.
  metadata?: Record<string, string> | null;
}

const OpenAIBatchInfoSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("batch"),
    endpoint: z.literal("/v1/responses"),
    input_file_id: z.string().min(1),
    completion_window: z.literal("24h"),
    status: z.string().min(1),
    // The Batch object may omit these while validating/in progress; default
    // them so a parse failure can't strand a batch that already exists remotely.
    output_file_id: z.string().min(1).nullable().default(null),
    error_file_id: z.string().min(1).nullable().default(null),
    request_counts: z
      .object({
        total: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .default({ total: 0, completed: 0, failed: 0 }),
    metadata: z.record(z.string(), z.string()).nullish(),
  })
  .passthrough();

export function assertResponsesBatchShape(
  raw: unknown,
  context: { id: string; runId: string },
): OpenAIBatchInfo {
  // Strict re-validation of a matched-by-run-id batch: listBatches accepts
  // arbitrary endpoints; only batches targeted at /v1/responses with a 24h
  // window are adoptable. Anything else is a foreign run_id collision and
  // must fail closed rather than adopt an unrelated batch.
  const parsed = OpenAIBatchInfoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `OpenAI run ${context.runId}: batch ${context.id} matched run_id but failed strict validation (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}); refusing to adopt`,
    );
  }
  return parsed.data;
}

// Permissive schema for the account-wide list endpoint. The list endpoint can
// return batches created against other endpoints (e.g. /v1/chat/completions);
// parsing those with `OpenAIBatchInfoSchema` would throw and break resume.
// `findBatchesByRunId` filters on `metadata.run_id` before adopting, and the
// matching batch is re-validated strictly via `OpenAIBatchInfoSchema` when the
// reconciler commits to it.
const OpenAIListBatchSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("batch"),
    endpoint: z.string().min(1).optional(),
    input_file_id: z.string().min(1).optional(),
    completion_window: z.string().min(1).optional(),
    status: z.string().min(1),
    output_file_id: z.string().min(1).nullable().default(null),
    error_file_id: z.string().min(1).nullable().default(null),
    request_counts: z
      .object({
        total: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .default({ total: 0, completed: 0, failed: 0 }),
    metadata: z.record(z.string(), z.string()).nullish(),
  })
  .passthrough();

export function makeOpenAIBatchClient(
  deps: OpenAIBatchDeps,
): OpenAIBatchClient {
  const authorization = `Bearer ${deps.apiKey}`;
  return {
    async upload(jsonl, runId) {
      const form = new FormData();
      form.set("purpose", "batch");
      form.set(
        "file",
        new Blob([jsonl], { type: "application/jsonl" }),
        `reading-lite-${runId}.jsonl`,
      );
      const response = await deps.fetch(OPENAI_FILES_URL, {
        method: "POST",
        headers: { authorization },
        body: form,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenAIBatchError(
          "file upload",
          response.status,
          text || `OpenAI file upload returned ${response.status}`,
        );
      }
      return OpenAIFileSchema.parse(await response.json());
    },
    async create(inputFileId, runId) {
      const response = await deps.fetch(OPENAI_BATCHES_URL, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input_file_id: inputFileId,
          endpoint: "/v1/responses",
          completion_window: "24h",
          metadata: { run_id: runId },
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenAIBatchError(
          "batch create",
          response.status,
          text || `OpenAI batch create returned ${response.status}`,
        );
      }
      return OpenAIBatchInfoSchema.parse(await response.json());
    },
    async get(batchId) {
      const response = await deps.fetch(
        `${OPENAI_BATCHES_URL}/${encodeURIComponent(batchId)}`,
        {
          method: "GET",
          headers: { authorization },
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenAIBatchError(
          "batch get",
          response.status,
          text || `OpenAI batch get returned ${response.status}`,
        );
      }
      return OpenAIBatchInfoSchema.parse(await response.json());
    },
    async content(fileId) {
      const response = await deps.fetch(
        `${OPENAI_FILES_URL}/${encodeURIComponent(fileId)}/content`,
        {
          method: "GET",
          headers: { authorization },
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenAIBatchError(
          "file content",
          response.status,
          text || `OpenAI file content returned ${response.status}`,
        );
      }
      return response.text();
    },
    async listFiles(opts) {
      const url = new URL(OPENAI_FILES_URL);
      if (opts?.purpose) url.searchParams.set("purpose", opts.purpose);
      if (opts?.after) url.searchParams.set("after", opts.after);
      if (opts?.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
      const response = await deps.fetch(url, {
        method: "GET",
        headers: { authorization },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenAIBatchError(
          "files list",
          response.status,
          text || `OpenAI files list returned ${response.status}`,
        );
      }
      const body = parseOpenAIListEnvelope(await response.json(), "files list");
      const data = body.data.map((f) => OpenAIFileSchema.parse(f));
      return {
        data,
        has_more: body.has_more,
        last_id: body.last_id,
      };
    },
    async listBatches(opts) {
      const url = new URL(OPENAI_BATCHES_URL);
      if (opts?.after) url.searchParams.set("after", opts.after);
      if (opts?.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
      const response = await deps.fetch(url, {
        method: "GET",
        headers: { authorization },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenAIBatchError(
          "batches list",
          response.status,
          text || `OpenAI batches list returned ${response.status}`,
        );
      }
      const body = parseOpenAIListEnvelope(await response.json(), "batches list");
      const raw = body.data;
      const data = raw.map((b) => OpenAIListBatchSchema.parse(b)) as OpenAIBatchInfo[];
      return {
        data,
        raw,
        has_more: body.has_more,
        last_id: body.last_id,
      };
    },
  };
}

export interface OpenAIEmbedDeps {
  fetch: typeof fetch;
  apiKey: string;
  model?: string;
}

export interface EmbedResult {
  embeddings: number[][];
  // Per-input token attribution. OpenAI reports usage per *request*, not per
  // input, so within each chunk we split the request total proportionally by
  // input length. The sum equals the true total OpenAI billed (exact at the
  // corpus level); the per-input figure is a length-proportional approximation.
  tokensByInput: number[];
}

export interface OpenAIEmbedClient {
  embedMany(inputs: string[]): Promise<EmbedResult>;
}

// Split a chunk's request-level token total across its inputs in proportion to
// input length, giving the rounding remainder to the longest input so the
// per-chunk sum stays exactly equal to `total`.
function attributeTokens(inputs: string[], total: number): number[] {
  const lengths = inputs.map((s) => s.length);
  const sum = lengths.reduce((a, b) => a + b, 0) || 1;
  const out = lengths.map((len) => Math.floor((len / sum) * total));
  const remainder = total - out.reduce((a, b) => a + b, 0);
  if (remainder > 0) {
    let maxI = 0;
    for (let i = 1; i < lengths.length; i++) if (lengths[i]! > lengths[maxI]!) maxI = i;
    out[maxI]! += remainder;
  }
  return out;
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
      if (inputs.length === 0) return { embeddings: [], tokensByInput: [] };
      if (inputs.some((s) => s.length === 0)) {
        throw new Error("embedMany: inputs must be non-empty strings");
      }
      const embeddings: number[][] = [];
      const tokensByInput: number[] = [];
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
        for (const d of ordered) embeddings.push(d.embedding);
        tokensByInput.push(...attributeTokens(chunk, parsed.usage.total_tokens));
      }
      return { embeddings, tokensByInput };
    },
  };
}
