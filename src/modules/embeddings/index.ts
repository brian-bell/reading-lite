import { z } from "zod";
import { EMBEDDING_DIM } from "../../schemas/api";

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export class OpenAIError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "OpenAIError";
  }
}

export class BadEmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadEmbeddingResponseError";
  }
}

export interface EmbeddingsDeps {
  fetch: typeof fetch;
  apiKey: string;
}

export interface EmbeddingResult {
  embedding: number[];
  usage: { prompt_tokens: number; total_tokens: number };
}

const ResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()).length(EMBEDDING_DIM),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

export async function embed(input: string, deps: EmbeddingsDeps): Promise<EmbeddingResult> {
  if (input.length === 0) throw new Error("embed: input must be non-empty");

  const response = await deps.fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${deps.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OpenAIError(response.status, openAiErrorMessage(text, response.status));
  }

  const json: unknown = await response.json();
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new BadEmbeddingResponseError(
      `unexpected OpenAI embeddings response: ${parsed.error.message}`,
    );
  }
  return {
    embedding: parsed.data.data[0]!.embedding,
    usage: parsed.data.usage,
  };
}

function openAiErrorMessage(text: string, status: number): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    if (json.error?.message) return json.error.message;
  } catch {
    /* ignore */
  }
  return text || `OpenAI returned ${status}`;
}
