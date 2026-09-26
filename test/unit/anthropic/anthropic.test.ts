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
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "toolu_01", name: EMIT_READING_TOOL_NAME, input },
    ],
    usage: { input_tokens: 100, output_tokens: 50, ...usage },
  };
}

function textOnlyResponse() {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "I refuse to use the tool" }],
    usage: { input_tokens: 10, output_tokens: 10 },
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
      { fetch: fetchFn, apiKey: "sk-ant", model: "claude-sonnet-5", effort: "low" },
    );
    expect(out.reading).toEqual(validToolInput);
    expect(out.usage.input_tokens).toBe(100);
    expect(out.usage.output_tokens).toBe(50);
    expect(out.usage.cache_read_input_tokens).toBe(80);
  });

  it("calls the Anthropic messages endpoint with the API key and version headers", async () => {
    // Body shape is owned by the buildSummarizeRequestBody tests below, which
    // also pin that summarizeReading sends that body byte-for-byte.
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await summarizeReading(
      {
        url: "https://example.com/a",
        extractedText: "hello",
        similarReadings: [],
      },
      { fetch: fetchFn, apiKey: "sk-secret", model: "claude-sonnet-5", effort: "low" },
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
  });

  it("includes the extracted text and URL in the user message", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok(toolUseResponse(validToolInput)));
    await summarizeReading(
      {
        url: "https://example.com/article-xyz",
        extractedText: "## Heading\n\nbody text here",
        similarReadings: [],
      },
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
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
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
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
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
    ).catch((e) => e);
    expect(e).toBeInstanceOf(AnthropicError);
    expect(e.status).toBe(429);
    expect(e.message).toContain("slow down");
  });

  // Strict tool use cannot advertise every bound the parser enforces, and a
  // slip is a property of one sample, not of the source. One more call is
  // cheaper than a failed attempt; each call is a separate paid dispatch.
  it.each([
    ["an invalid tool input", toolUseResponse({ ...validToolInput, tags: [] })],
    ["no tool_use block", textOnlyResponse()],
  ])("calls the model once more after %s and returns the second result", async (_, first) => {
    const responses = [
      ok({ ...first, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 } }),
      ok(toolUseResponse(validToolInput, { cache_read_input_tokens: 80 })),
    ];
    const fetchFn = vi.fn<typeof fetch>(async () => responses.shift()!);
    const out = await summarizeReading(
      { url: "https://example.com/a", extractedText: "x", similarReadings: [] },
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![1]!.body).toBe(fetchFn.mock.calls[0]![1]!.body);
    expect(out.reading).toEqual(validToolInput);
    // Usage reports both calls; both were billed.
    expect(out.usage).toEqual({
      input_tokens: 200,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    });
  });

  it.each([
    ["BadToolInputError", () => toolUseResponse({ ...validToolInput, novelty_verdict: "maybe" }), BadToolInputError],
    ["NoToolUseError", () => textOnlyResponse(), NoToolUseError],
  ])("throws %s when the second call is still unusable", async (_, response, errorClass) => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok(response()));
    await expect(
      summarizeReading(
        { url: "https://example.com/a", extractedText: "x", similarReadings: [] },
        { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
      ),
    ).rejects.toBeInstanceOf(errorClass);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws SourceRejectedError when the model rejects a non-source extraction", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      ok({
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
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
      { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceRejectedError);
    expect(error).toMatchObject({
      message: "metadata-only YouTube floor, no transcript",
    });
    // A rejection is a verdict about the source; asking again only pays twice.
    expect(fetchFn).toHaveBeenCalledOnce();
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
        model: "claude-sonnet-5",
        effort: "low",
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
        { fetch: fetchFn, apiKey: "sk", model: "claude-sonnet-5", effort: "low" },
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
      "low",
    ) as Record<string, any>;
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.tool_choice).toEqual({ type: "any" });
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      EMIT_READING_TOOL_NAME,
      REJECT_SOURCE_TOOL_NAME,
    ]);
    // Without strict tool use, `required` and `type` are advisory: production
    // Sonnet 5 omitted `tags` and sent `keywords` as a string.
    expect(body.tools.map((tool: { strict?: unknown }) => tool.strict)).toEqual([true, true]);
    const lastSystem = body.system[body.system.length - 1];
    expect(lastSystem.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].role).toBe("user");
  });

  it("requires a full extraction and rejects a summary of the URL", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
      "low",
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
    await summarizeReading(input, { fetch: fetchFn, apiKey: "sk", model: "claude-opus-4-8", effort: "low" });
    const sent = fetchFn.mock.calls[0]![1]!.body as string;
    expect(JSON.stringify(buildSummarizeRequestBody(input, "claude-opus-4-8", "low"))).toBe(sent);
  });

  it("advertises the parser's contract minus what strict tool use cannot express", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
      "low",
    ) as Record<string, any>;
    // Strict tool use supports no string length bounds, no maxItems, and
    // minItems of 0 or 1 only. The tool schema is READING_SUMMARY_JSON_SCHEMA
    // with exactly those keywords removed (descriptions state them instead);
    // ReadingSummarySchema still enforces them at parse time, and
    // summarizeReading asks once more when a call misses one.
    const strictSubset = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(strictSubset);
      if (node && typeof node === "object") {
        return Object.fromEntries(
          Object.entries(node)
            .filter(([key, value]) =>
              key !== "description" &&
              key !== "minLength" &&
              key !== "maxLength" &&
              key !== "maxItems" &&
              !(key === "minItems" && typeof value === "number" && value > 1),
            )
            .map(([key, value]) => [key, strictSubset(value)]),
        );
      }
      return node;
    };
    expect(strictSubset(body.tools[0].input_schema)).toEqual(
      strictSubset(READING_SUMMARY_JSON_SCHEMA),
    );
    expect(strictSubset(body.tools[0].input_schema)).toEqual(
      JSON.parse(
        JSON.stringify(body.tools[0].input_schema, (key, value) =>
          key === "description" ? undefined : value,
        ),
      ),
    );
  });

  it("keeps the cacheable prefix (tools + system) stable", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-opus-4-8",
      "low",
    ) as Record<string, any>;
    // Snapshot guards against silent prompt-cache invalidation: any byte change
    // in tools+system busts every cached prefix across the batch.
    expect({ tools: body.tools, system: body.system }).toMatchSnapshot();
  });

  it("wires output_config.effort, the Anthropic Messages field for claude-sonnet-5", () => {
    const body = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-sonnet-5",
      "xhigh",
    ) as Record<string, any>;
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body).not.toHaveProperty("reasoning");
    const maxBody = buildSummarizeRequestBody(
      { url: "https://example.com/a", extractedText: "hello", similarReadings: [] },
      "claude-sonnet-5",
      "max",
    ) as Record<string, any>;
    expect(maxBody.max_tokens).toBe(8192);
    expect(maxBody.thinking).toEqual({ type: "disabled" });
    expect(maxBody.output_config).toEqual({ effort: "max" });
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

  // NoToolUse / BadToolInput / SourceRejected are covered through
  // summarizeReading above, which reaches this parser unchanged.

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
