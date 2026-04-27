import {
  EmitReadingToolInputSchema,
  type EmitReadingToolInput,
} from "../../schemas/manifest";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const EMIT_READING_TOOL_NAME = "emit_reading";

export class AnthropicError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AnthropicError";
  }
}

export class NoToolUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoToolUseError";
  }
}

export class BadToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadToolInputError";
  }
}

export interface AnthropicDeps {
  fetch: typeof fetch;
  apiKey: string;
  model: string;
}

export interface SimilarContext {
  id: string;
  url: string;
  title?: string;
  tldr?: string;
}

export interface SummarizeReadingInput {
  url: string;
  extractedText: string;
  title?: string;
  similarReadings: SimilarContext[];
}

export interface SummarizeReadingResult {
  reading: EmitReadingToolInput;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const SYSTEM_PROMPT = `You are a personal librarian. The user has saved a URL to read. Your job is to produce a structured summary so the user can decide whether to re-read it later, find it again by topic, and see how it relates to the rest of their library.

Your output goes through a single tool call to "emit_reading". Use it exactly once. Do not write free-form prose.

Required fields:
- title: the article's title, or a faithful 5-12 word title if none
- tldr: 1-3 sentences capturing the core thesis or finding
- tags: 1-6 broad topical buckets (e.g. "ai", "infrastructure", "memoir")
- keywords: 3-15 specific noun phrases that name the things the article is about
- people: every named person actually discussed (not just cited)
- orgs: every named organization, company, or institution actually discussed
- novelty_verdict: one of
    - "novel": no item in the user's prior library covers this material
    - "familiar": the topic appears in the prior library but this piece adds something
    - "duplicate": the user has effectively already read this
- connections: ids from the prior library that are genuinely related, with a one-clause reason each. Empty array if none.
- summary_markdown: 2-6 short paragraphs in markdown. Capture the argument structure, not just the topic.

Be conservative on novelty: prefer "familiar" to "novel" when in doubt; prefer "duplicate" only when the prior reading is essentially the same piece.`;

const EMIT_READING_INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Article title (5-120 chars)." },
    tldr: { type: "string", description: "1-3 sentence summary." },
    tags: { type: "array", items: { type: "string" }, description: "Broad topical buckets." },
    keywords: { type: "array", items: { type: "string" }, description: "Specific noun phrases." },
    people: { type: "array", items: { type: "string" } },
    orgs: { type: "array", items: { type: "string" } },
    novelty_verdict: {
      type: "string",
      enum: ["novel", "familiar", "duplicate"],
      description: "Verdict relative to the user's prior library.",
    },
    connections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Reading id from the prior library." },
          reason: { type: "string", description: "One-clause reason for the connection." },
        },
        required: ["id", "reason"],
      },
    },
    summary_markdown: {
      type: "string",
      description: "2-6 short paragraphs in markdown.",
    },
  },
  required: [
    "title",
    "tldr",
    "tags",
    "keywords",
    "people",
    "orgs",
    "novelty_verdict",
    "connections",
    "summary_markdown",
  ],
} as const;

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content: Array<AnthropicToolUseBlock | { type: string; [k: string]: unknown }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export async function summarizeReading(
  input: SummarizeReadingInput,
  deps: AnthropicDeps,
): Promise<SummarizeReadingResult> {
  if (input.extractedText.length === 0) {
    throw new Error("summarizeReading: extractedText must be non-empty");
  }

  const body = {
    model: deps.model,
    max_tokens: 8192,
    // System prompt + tool definition together form the cacheable prefix.
    // Render order is tools → system → messages, so cache_control on the last
    // system block caches tools + system in one breakpoint.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: EMIT_READING_TOOL_NAME,
        description: "Emit the structured reading record. Call exactly once.",
        input_schema: EMIT_READING_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: EMIT_READING_TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildUserMessage(input),
          },
        ],
      },
    ],
  };

  const response = await deps.fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": deps.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AnthropicError(response.status, anthropicErrorMessage(text, response.status));
  }

  const json = (await response.json()) as AnthropicMessageResponse;
  const toolUse = json.content.find(
    (b): b is AnthropicToolUseBlock =>
      b.type === "tool_use" && (b as AnthropicToolUseBlock).name === EMIT_READING_TOOL_NAME,
  );
  if (!toolUse) {
    throw new NoToolUseError(
      `Anthropic response did not contain a tool_use block for ${EMIT_READING_TOOL_NAME}`,
    );
  }

  const parsed = EmitReadingToolInputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new BadToolInputError(
      `tool_use input failed validation: ${parsed.error.message}`,
    );
  }

  return { reading: parsed.data, usage: json.usage };
}

function buildUserMessage(input: SummarizeReadingInput): string {
  const parts: string[] = [];
  parts.push(`Source URL: ${input.url}`);
  if (input.title) parts.push(`Page title: ${input.title}`);

  if (input.similarReadings.length > 0) {
    parts.push("");
    parts.push("Possibly-related readings already in the library:");
    for (const s of input.similarReadings) {
      const head = s.title ? `${s.id} — ${s.title} (${s.url})` : `${s.id} — ${s.url}`;
      parts.push(`- ${head}`);
      if (s.tldr) parts.push(`  ${s.tldr}`);
    }
    parts.push("");
    parts.push(
      "Use these only as context for the novelty_verdict and connections. Do not summarize them.",
    );
  } else {
    parts.push("");
    parts.push("The user has no prior readings on closely-related topics.");
  }

  parts.push("");
  parts.push("---");
  parts.push("Article content (markdown):");
  parts.push("");
  parts.push(input.extractedText);

  return parts.join("\n");
}

function anthropicErrorMessage(text: string, status: number): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    if (json.error?.message) return json.error.message;
  } catch {
    /* ignore */
  }
  return text || `Anthropic returned ${status}`;
}
