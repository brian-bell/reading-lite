import { describe, expect, it, vi } from "vitest";
import {
  summarizeReading,
  buildSummarizeRequestBody,
  parseEmitReadingResult,
  AnthropicError,
  NoToolUseError,
  BadToolInputError,
  SourceRejectedError,
  EMIT_READING_TOOL_NAME,
  REJECT_SOURCE_TOOL_NAME,
} from "../../../src/modules/anthropic";
import { READING_SUMMARY_JSON_SCHEMA } from "../../../src/schemas/reading-summary";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const validToolInput = {
  title: "Sample title",
  tldr: "Short tldr.",
  tags: ["t1"],
  keywords: ["keyword one", "keyword two", "keyword three"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "body",
};

function toolUseResponse(input: unknown, usage: Partial<Record<string, number>> = {}) {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "toolu_01", name: EMIT_READING_TOOL_NAME, input },
    ],
    usage: { input_tokens: 100, output_tokens: 50, ...usage },
  };
}

describe("summarizeReading", () => {
  it("returns the parsed reading + usage on success", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      ok(toolUseResponse(validToolInput, { cache_read_input_tokens: 80 })),
    );
    const out = await summarizeReading(
      {
        url: "https://example.com/a",
        extractedText: "hello world",
        title: "Sample",
        similarReadings: [],
      },
      { fetch: fetchFn, apiKey: "sk-ant", model: "claude-sonnet-4-6" },
    );
    expect(out.reading).toEqual(validToolInput);
    expect(out.usage.input_tokens).toBe(100);
    expect(out.usage.output_tokens).toBe(50);
    expect(out.usage.cache_read_input_tokens).toBe(80);
  });

  it("calls Anthropic with model, headers, tool_choice, and cache_control", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await summarizeReading(
      {
        url: "https://example.com/a",
        extractedText: "hello",
        similarReadings: [],
      },
      { fetch: fetchFn, apiKey: "sk-secret", model: "claude-sonnet-4-6" },
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    const call = fetchFn.mock.calls[0]!;
    const url = call[0];
    const init = call[1]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.tool_choice).toEqual({ type: "any" });
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      EMIT_READING_TOOL_NAME,
      REJECT_SOURCE_TOOL_NAME,
    ]);
    // System is an array of blocks with cache_control on the last block (caches tools+system together).
    expect(Array.isArray(body.system)).toBe(true);
    const lastSystem = body.system[body.system.length - 1];
    expect(lastSystem.cache_control).toEqual({ type: "ephemeral" });
    // Volatile content (extracted text + similar context) is in the user message, after the cache breakpoint.
    expect(body.messages[0].role).toBe("user");
  });

  it("includes the extracted text and URL in the user message", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await summarizeReading(
      {
        url: "https://example.com/article-xyz",
        extractedText: "## Heading\n\nbody text here",
        similarReadings: [],
      },
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
    );
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    const userText = body.messages[0].content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");
    expect(userText).toContain("https://example.com/article-xyz");
    expect(userText).toContain("body text here");
    expect(userText).toContain(
      "Extracted source (full article body or transcript):",
    );
  });

  it("includes top-K similar readings as context", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await summarizeReading(
      {
        url: "https://example.com/a",
        extractedText: "hello",
        similarReadings: [
          { id: "rd_a", url: "https://example.com/x", title: "X", tldr: "About X" },
          { id: "rd_b", url: "https://example.com/y", title: "Y", tldr: "About Y" },
        ],
      },
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
    );
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    const userText = JSON.stringify(body.messages[0].content);
    expect(userText).toContain("rd_a");
    expect(userText).toContain("About X");
    expect(userText).toContain("rd_b");
  });

  it("throws AnthropicError on non-2xx response", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      err(429, { error: { type: "rate_limit_error", message: "slow down" } }),
    );
    const e = await summarizeReading(
      { url: "https://example.com/a", extractedText: "x", similarReadings: [] },
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
    ).catch((e) => e);
    expect(e).toBeInstanceOf(AnthropicError);
    expect(e.status).toBe(429);
    expect(e.message).toContain("slow down");
  });

  it("throws NoToolUseError when response has no tool_use block", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      ok({
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I refuse to use the tool" }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
    await expect(
      summarizeReading(
        { url: "https://example.com/a", extractedText: "x", similarReadings: [] },
        { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
      ),
    ).rejects.toBeInstanceOf(NoToolUseError);
  });

  it("throws BadToolInputError when tool input fails schema validation", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      ok(toolUseResponse({ ...validToolInput, novelty_verdict: "maybe" })),
    );
    await expect(
      summarizeReading(
        { url: "https://example.com/a", extractedText: "x", similarReadings: [] },
        { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
      ),
    ).rejects.toBeInstanceOf(BadToolInputError);
  });

  it("throws SourceRejectedError when the model rejects a non-source extraction", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      ok({
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: REJECT_SOURCE_TOOL_NAME,
            input: { reason: "metadata-only YouTube floor, no transcript" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
    const error = await summarizeReading(
      { url: "https://example.com/a", extractedText: "Watch on YouTube", similarReadings: [] },
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceRejectedError);
    expect(error).toMatchObject({
      message: "metadata-only YouTube floor, no transcript",
    });
  });

  it("propagates RateLimitedError on 429 (no in-process retry)", async () => {
    const { RateLimitedError } = await import("../../../src/modules/http-retry");
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    );
    const sleeps: number[] = [];
    const e = await summarizeReading(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      {
        fetch: fetchFn as unknown as typeof fetch,
        apiKey: "sk",
        model: "claude-sonnet-4-6",
        retry: {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 1,
        },
      },
    ).catch((err) => err);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect((e as InstanceType<typeof RateLimitedError>).retryAfterMs).toBe(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("rejects empty extractedText before calling fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await expect(
      summarizeReading(
        { url: "https://example.com/a", extractedText: "", similarReadings: [] },
        { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-4-6" },
      ),
    ).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("buildSummarizeRequestBody", () => {
  it("produces the model, tool def, tool_choice, and cacheable system prefix", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
    ) as Record<string, any>;
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.tool_choice).toEqual({ type: "any" });
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      EMIT_READING_TOOL_NAME,
      REJECT_SOURCE_TOOL_NAME,
    ]);
    const lastSystem = body.system[body.system.length - 1];
    expect(lastSystem.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].role).toBe("user");
  });

  it("requires a full extraction and rejects a summary of the URL", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
    ) as Record<string, any>;
    expect(body.system[0].text).toContain("full article body or a full transcript");
    expect(body.system[0].text).toMatch(/summary or recap of the URL/i);
    expect(body.system[0].text).toContain("Call reject_source when it is not");
    expect(body.messages[0].content[0].text).toContain(
      "Extracted source (full article body or transcript):",
    );
  });

  it("is byte-identical to what summarizeReading sends (single source of truth)", async () => {
    const input = {
      url: "https://example.com/article-xyz",
      extractedText: "## Heading\n\nbody text here",
      title: "T",
      similarReadings: [
        { id: "rd_a", url: "https://example.com/x", title: "X", tldr: "About X" },
      ],
    };
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await summarizeReading(input, { fetch: fetchFn, apiKey: "sk", model: "claude-opus-4-8" });
    const sent = fetchFn.mock.calls[0]![1]!.body as string;
    expect(JSON.stringify(buildSummarizeRequestBody(input, "claude-opus-4-8"))).toBe(sent);
  });

  it("advertises a tool schema exactly as strict as the parser's contract", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
    ) as Record<string, any>;
    // The parser validates with the strict ReadingSummarySchema; the advertised
    // JSON schema must carry the same constraints (additionalProperties, bounds)
    // so a tool call that is valid per the tool contract can never fail parsing.
    // Descriptions are the only allowed addition.
    const stripDescriptions = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(stripDescriptions);
      if (node && typeof node === "object") {
        return Object.fromEntries(
          Object.entries(node)
            .filter(([key]) => key !== "description")
            .map(([key, value]) => [key, stripDescriptions(value)]),
        );
      }
      return node;
    };
    expect(stripDescriptions(body.tools[0].input_schema)).toEqual(
      READING_SUMMARY_JSON_SCHEMA,
    );
  });

  it("keeps the cacheable prefix (tools + system) stable", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
    ) as Record<string, any>;
    // Snapshot guards against silent prompt-cache invalidation: any byte change
    // in tools+system busts every cached prefix across the batch.
    expect({ tools: body.tools, system: body.system }).toMatchSnapshot();
  });
});

describe("parseEmitReadingResult", () => {
  const usage = { input_tokens: 7, output_tokens: 3 };

  it("returns the parsed reading + usage on a valid tool_use block", () => {
    const out = parseEmitReadingResult(
      [{ type: "tool_use", id: "toolu_1", name: EMIT_READING_TOOL_NAME, input: validToolInput }],
      usage,
    );
    expect(out.reading).toEqual(validToolInput);
    expect(out.usage).toEqual(usage);
  });

  it("throws NoToolUseError when no emit_reading block is present", () => {
    expect(() =>
      parseEmitReadingResult([{ type: "text", text: "nope" }], usage),
    ).toThrow(NoToolUseError);
  });

  it("throws BadToolInputError when the tool input fails validation", () => {
    expect(() =>
      parseEmitReadingResult(
        [{ type: "tool_use", id: "t", name: EMIT_READING_TOOL_NAME, input: { ...validToolInput, novelty_verdict: "maybe" } }],
        usage,
      ),
    ).toThrow(BadToolInputError);
  });

  it("throws SourceRejectedError when reject_source is called", () => {
    expect(() =>
      parseEmitReadingResult(
        [
          {
            type: "tool_use",
            id: "t",
            name: REJECT_SOURCE_TOOL_NAME,
            input: { reason: "this is a recap of the URL, not the article" },
          },
        ],
        usage,
      ),
    ).toThrow(SourceRejectedError);
    expect(() =>
      parseEmitReadingResult(
        [
          {
            type: "tool_use",
            id: "t",
            name: REJECT_SOURCE_TOOL_NAME,
            input: { reason: "this is a recap of the URL, not the article" },
          },
        ],
        usage,
      ),
    ).toThrow("this is a recap of the URL, not the article");
  });

  it("prefers reject_source when both tools are present", () => {
    expect(() =>
      parseEmitReadingResult(
        [
          {
            type: "tool_use",
            id: "emit",
            name: EMIT_READING_TOOL_NAME,
            input: validToolInput,
          },
          {
            type: "tool_use",
            id: "reject",
            name: REJECT_SOURCE_TOOL_NAME,
            input: { reason: "teaser" },
          },
        ],
        usage,
      ),
    ).toThrow(SourceRejectedError);
  });
});
