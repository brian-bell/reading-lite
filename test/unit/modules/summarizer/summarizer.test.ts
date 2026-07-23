import { describe, expect, it, vi } from "vitest";
import {
  summarizeReading,
  SummarizerConfigError,
} from "../../../../src/modules/summarizer";
import { OpenAIError } from "../../../../src/modules/openai-summarizer";

const input = {
  url: "https://example.com/article",
  extractedText: "Article body",
  similarReadings: [],
};

const summary = {
  title: "Example Article",
  tldr: "A concise example summary.",
  tags: ["examples"],
  keywords: ["example article", "provider selection", "reading library"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "The article demonstrates provider selection.",
};

function openAIResponse() {
  return {
    id: "resp_01",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(summary) }],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 30 },
    },
  };
}

function anthropicResponse() {
  return {
    content: [
      {
        type: "tool_use",
        id: "toolu_01",
        name: "emit_reading",
        input: summary,
      },
    ],
    usage: {
      input_tokens: 90,
      output_tokens: 45,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 34,
    },
  };
}

describe("summarizeReading provider selection", () => {
  it("defaults an absent provider to OpenAI Terra at low effort", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(openAIResponse()), { status: 200 }),
    );

    const result = await summarizeReading(input, {
      fetch: fetchFn,
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-4-6",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/responses",
    );
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
    });
    expect(result.usage).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 30,
      cached_input_tokens: 20,
      cache_write_tokens: 10,
    });
  });

  it("uses only Anthropic when explicitly selected", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(anthropicResponse()), { status: 200 }),
    );

    const result = await summarizeReading(input, {
      fetch: fetchFn,
      provider: "anthropic",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-4-6",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(result.usage).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: 90,
      output_tokens: 45,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 34,
    });
  });

  it("rejects an invalid provider before calling an API", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    const error = await summarizeReading(input, {
      fetch: fetchFn,
      provider: "other",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-4-6",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SummarizerConfigError);
    expect(error).toHaveProperty("message", "invalid SUMMARIZER_PROVIDER: other");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects invalid OpenAI reasoning effort before calling an API", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    const error = await summarizeReading(input, {
      fetch: fetchFn,
      provider: "openai",
      openaiApiKey: "sk-openai",
      openaiReasoningEffort: "extreme",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-4-6",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SummarizerConfigError);
    expect(error).toHaveProperty(
      "message",
      "invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: extreme",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not fall back after the selected provider fails", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { message: "OpenAI failed" } }), {
        status: 500,
      }),
    );

    const error = await summarizeReading(input, {
      fetch: fetchFn,
      provider: "openai",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-4-6",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenAIError);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/responses",
    );
  });
});
