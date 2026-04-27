import { describe, expect, it, vi } from "vitest";
import {
  summarizeReading,
  AnthropicError,
  NoToolUseError,
  BadToolInputError,
  EMIT_READING_TOOL_NAME,
} from "../../../src/modules/anthropic";

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
  keywords: ["k1"],
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
    expect(body.tool_choice).toEqual({ type: "tool", name: EMIT_READING_TOOL_NAME });
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe(EMIT_READING_TOOL_NAME);
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
