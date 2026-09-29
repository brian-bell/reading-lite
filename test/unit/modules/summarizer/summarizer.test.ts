import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  parseAnthropicEffort,
  summarizeReading,
  SummarizerConfigError,
  validateProcessingCredentials,
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
      anthropicModel: "claude-sonnet-5",
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
      anthropicModel: "claude-sonnet-5",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(result.usage).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      input_tokens: 90,
      output_tokens: 45,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 34,
    });
  });

  it("requires the selected provider key before calling its API", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    await expect(
      summarizeReading(input, {
        fetch: fetchFn,
        provider: "anthropic",
        openaiApiKey: "sk-openai",
        anthropicApiKey: "",
        anthropicModel: "claude-sonnet-5",
      }),
    ).rejects.toMatchObject({
      name: "SummarizerConfigError",
      message: expect.stringMatching(/missing ANTHROPIC_API_KEY/i),
    });
    await expect(
      summarizeReading(input, {
        fetch: fetchFn,
        provider: "openai",
        openaiApiKey: "",
        anthropicApiKey: "",
        anthropicModel: "claude-sonnet-5",
      }),
    ).rejects.toMatchObject({
      name: "SummarizerConfigError",
      message: expect.stringMatching(/missing OPENAI_API_KEY/i),
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not require or validate OpenAI-only settings when Anthropic is selected", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(anthropicResponse()), { status: 200 }),
    );

    await expect(
      summarizeReading(input, {
        fetch: fetchFn,
        provider: "anthropic",
        openaiApiKey: "",
        openaiReasoningEffort: "irrelevant-invalid-value",
        anthropicApiKey: "sk-anthropic",
        anthropicModel: "claude-sonnet-5",
      }),
    ).resolves.toMatchObject({
      usage: { provider: "anthropic" },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects an invalid provider before calling an API", async () => {
    const fetchFn = vi.fn<typeof fetch>();

    const error = await summarizeReading(input, {
      fetch: fetchFn,
      provider: "other",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-5",
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
      anthropicModel: "claude-sonnet-5",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SummarizerConfigError);
    expect(error).toHaveProperty(
      "message",
      "invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: extreme",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes a valid Anthropic effort on output_config and rejects unsupported values before calling an API", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(anthropicResponse()), { status: 200 }),
    );

    await summarizeReading(input, {
      fetch: fetchFn,
      provider: "anthropic",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-5",
      anthropicReasoningEffort: "medium",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.output_config).toEqual({ effort: "medium" });

    fetchFn.mockClear();
    await summarizeReading(input, {
      fetch: fetchFn,
      provider: "anthropic",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-5",
      anthropicReasoningEffort: "xhigh",
    });
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string).output_config).toEqual(
      { effort: "xhigh" },
    );

    const unused = vi.fn<typeof fetch>();
    const error = await summarizeReading(input, {
      fetch: unused,
      provider: "anthropic",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-5",
      anthropicReasoningEffort: "none",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(SummarizerConfigError);
    expect(error).toHaveProperty(
      "message",
      "invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: none",
    );
    expect(unused).not.toHaveBeenCalled();
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
      anthropicModel: "claude-sonnet-5",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenAIError);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/responses",
    );
  });
});

describe("validateProcessingCredentials", () => {
  it("always requires OpenAI for embeddings but only requires Anthropic when selected", () => {
    expect(() =>
      validateProcessingCredentials({
        provider: "anthropic",
        openaiApiKey: "",
        anthropicApiKey: "sk-anthropic",
      }),
    ).toThrow(/missing OPENAI_API_KEY.*embedding/i);
    expect(() =>
      validateProcessingCredentials({
        provider: "anthropic",
        openaiApiKey: "sk-openai",
      }),
    ).toThrow(/missing ANTHROPIC_API_KEY/i);
    expect(() =>
      validateProcessingCredentials({
        provider: "openai",
        openaiApiKey: "sk-openai",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid OpenAI reasoning effort at the preflight seam", () => {
    expect(() =>
      validateProcessingCredentials({
        provider: "openai",
        openaiApiKey: "sk-openai",
        openaiReasoningEffort: "extreme",
      }),
    ).toThrow(/invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: extreme/);
    // The provider default is OpenAI, so an absent provider validates effort too.
    expect(() =>
      validateProcessingCredentials({
        openaiApiKey: "sk-openai",
        openaiReasoningEffort: "extreme",
      }),
    ).toThrow(/invalid OPENAI_SUMMARIZATION_REASONING_EFFORT/);
    expect(() =>
      validateProcessingCredentials({
        provider: "openai",
        openaiApiKey: "sk-openai",
        openaiReasoningEffort: "high",
      }),
    ).not.toThrow();
  });

  it("ignores OpenAI-only effort when Anthropic is selected", () => {
    expect(() =>
      validateProcessingCredentials({
        provider: "anthropic",
        openaiApiKey: "sk-openai",
        anthropicApiKey: "sk-anthropic",
        anthropicModel: "claude-sonnet-5",
        openaiReasoningEffort: "irrelevant-invalid-value",
      }),
    ).not.toThrow();
  });

  it("wires Anthropic effort validation into the preflight seam", () => {
    // parseAnthropicEffort owns the model/effort table; this only proves the
    // seam calls it for the selected provider.
    expect(() =>
      validateProcessingCredentials({
        provider: "anthropic",
        openaiApiKey: "sk-openai",
        anthropicApiKey: "sk-anthropic",
        anthropicModel: "claude-sonnet-5",
        anthropicReasoningEffort: "none",
      }),
    ).toThrow(/invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: none/);
    expect(() =>
      validateProcessingCredentials({
        provider: "anthropic",
        openaiApiKey: "sk-openai",
        anthropicApiKey: "sk-anthropic",
        anthropicModel: "claude-sonnet-5",
        anthropicReasoningEffort: "medium",
      }),
    ).not.toThrow();
  });
  it("does not require deployment keys when tenant keys are on, and still rejects a bad OpenAI effort", () => {
    expect(() =>
      validateProcessingCredentials({
        tenantProviderKeys: true,
        provider: "anthropic",
        openaiReasoningEffort: "high",
      }),
    ).not.toThrow();
    expect(() =>
      validateProcessingCredentials({
        tenantProviderKeys: true,
        openaiReasoningEffort: "extreme",
      }),
    ).toThrow(/invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: extreme/);
  });
  it("ignores Anthropic-only effort when OpenAI is selected", () => {
    expect(() =>
      validateProcessingCredentials({
        provider: "openai",
        openaiApiKey: "sk-openai",
        anthropicReasoningEffort: "irrelevant-invalid-value",
      }),
    ).not.toThrow();
  });
});

describe("parseAnthropicEffort", () => {
  it("accepts Claude Sonnet 5 efforts from the official Messages API set", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseAnthropicEffort(effort, "claude-sonnet-5")).toBe(effort);
    }
  });

  it("rejects OpenAI-only none and xhigh on Sonnet 4.6", () => {
    expect(() => parseAnthropicEffort("none", "claude-sonnet-5")).toThrow(
      /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: none/,
    );
    expect(() => parseAnthropicEffort("xhigh", "claude-sonnet-4-6")).toThrow(
      /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: xhigh/,
    );
  });

  it("fails closed on an undocumented model id", () => {
    expect(() => parseAnthropicEffort("low", "claude-haiku-4-5")).toThrow(
      /unsupported ANTHROPIC_MODEL for effort: claude-haiku-4-5/,
    );
  });

  it("fails closed on models that reject thinking disabled", () => {
    for (const model of [
      "claude-fable-5",
      "claude-mythos-5",
      "claude-mythos-preview",
    ]) {
      expect(() => parseAnthropicEffort("low", model)).toThrow(
        new RegExp(`unsupported ANTHROPIC_MODEL for effort: ${model}`),
      );
    }
  });

  it("pins the default model to Claude Sonnet 5.5", () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
  });

  it("accepts Sonnet 5.5 at high or below and rejects xhigh|max with between_tools", () => {
    // between_tools is the lowest thinking setting Sonnet 5.5 accepts, and it
    // 400s at xhigh or max. Official efforts above high stay fail-closed.
    for (const effort of ["low", "medium", "high"] as const) {
      expect(parseAnthropicEffort(effort, "claude-sonnet-5-5")).toBe(effort);
    }
    expect(() => parseAnthropicEffort("xhigh", "claude-sonnet-5-5")).toThrow(
      /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: xhigh/,
    );
    expect(() => parseAnthropicEffort("max", "claude-sonnet-5-5")).toThrow(
      /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: max/,
    );
  });

  it("accepts Opus 5 at high or below and rejects xhigh|max with thinking disabled", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(parseAnthropicEffort(effort, "claude-opus-5")).toBe(effort);
    }
    expect(() => parseAnthropicEffort("xhigh", "claude-opus-5")).toThrow(
      /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: xhigh/,
    );
    expect(() => parseAnthropicEffort("max", "claude-opus-5")).toThrow(
      /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: max/,
    );
  });
});
