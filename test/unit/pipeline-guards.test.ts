// Reading pipeline guards that no integration test owns: prompt-cache
// stability, fail-closed provider configuration, SSRF host blocking, the R2
// key spelling the live corpus is stored under, and the content sweep's
// refusal to delete what a reading still points at.

import { describe, expect, it, vi } from "vitest";
import { AttemptIo } from "../../src/attempt-io";
import { buildSummarizeRequestBody as buildAnthropicSummarizeRequestBody } from "../../src/modules/anthropic";
import { isBlockedHost } from "../../src/modules/extractor";
import { buildSummarizeRequestBody as buildOpenAISummarizeRequestBody } from "../../src/modules/openai-summarizer";
import { buildAnthropicRelationshipRequestBody } from "../../src/modules/relationship-judgement";
import type { ContentStore } from "../../src/modules/stores/content-store";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { parseAnthropicEffort, summarizeReading, SummarizerConfigError } from "../../src/modules/summarizer";
import { buildAnthropicTensionRequestBody } from "../../src/modules/tension-judgement";

describe("provider requests", () => {
  // Any byte change in a cached prefix busts every cached request built on it.
  // A deliberate prompt change updates the snapshot in the same commit.
  it("keeps every cached prompt prefix byte-stable", () => {
    const summarizeInput = { url: "https://example.com/a", extractedText: "hello", similarReadings: [] };
    const anthropic = buildAnthropicSummarizeRequestBody(summarizeInput, "claude-opus-4-8", "low") as Record<string, any>;
    expect({ tools: anthropic.tools, system: anthropic.system }).toMatchSnapshot("anthropic summarize");

    const openai = buildOpenAISummarizeRequestBody(
      { ...summarizeInput, url: "https://example.com/article", title: "Example Article", extractedText: "## Article\n\nUseful source text." },
      "gpt-5.6-terra",
      "low",
    ) as Record<string, any>;
    expect({
      instructions: openai.instructions,
      text: openai.text,
      prompt_cache_options: openai.prompt_cache_options,
    }).toMatchSnapshot("openai summarize");

    const relationship = buildAnthropicRelationshipRequestBody(
      {
        reading: { id: "rd_a", url: "https://example.com/a", title: "Target", tldr: "Target argument.", tags: ["testing"], summary_markdown: "x" },
        similarReadings: [{ id: "rd_b", score: 0.87, title: "Prior", tldr: "Related argument." }],
      },
      "claude-sonnet-5-5",
      "medium",
    ) as Record<string, any>;
    expect({ tools: relationship.tools, system: relationship.system }).toMatchSnapshot("relationship judgement");

    const tension = buildAnthropicTensionRequestBody(
      {
        a: { id: "rd_a", url: "https://example.com/a", title: "A", tldr: "A.", summary_markdown: "x", created_at: "2026-01-01T00:00:00.000Z" },
        b: { id: "rd_b", url: "https://example.com/b", title: "B", tldr: "B.", summary_markdown: "y" },
      },
      "claude-sonnet-5-5",
      "low",
    ) as Record<string, any>;
    expect({ tools: tension.tools, system: tension.system }).toMatchSnapshot("tension judgement");
  });

  it("rejects an invalid provider, effort, or model before calling any API", async () => {
    const base = {
      provider: "openai",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
      anthropicModel: "claude-sonnet-5",
    };
    const cases = [
      [{ provider: "other" }, "invalid SUMMARIZER_PROVIDER: other"],
      [{ openaiReasoningEffort: "extreme" }, "invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: extreme"],
      [{ provider: "anthropic", anthropicReasoningEffort: "none" }, "invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: none"],
    ] as const;
    for (const [overrides, message] of cases) {
      const fetchFn = vi.fn<typeof fetch>();
      const error = await summarizeReading(
        { url: "https://example.com/article", extractedText: "Article body", similarReadings: [] },
        { fetch: fetchFn, ...base, ...overrides },
      ).catch((caught) => caught);
      expect(error, message).toBeInstanceOf(SummarizerConfigError);
      expect(error, message).toHaveProperty("message", message);
      expect(fetchFn, message).not.toHaveBeenCalled();
    }
    expect(() => parseAnthropicEffort("low", "claude-haiku-4-5")).toThrow(
      /unsupported ANTHROPIC_MODEL for effort: claude-haiku-4-5/,
    );
  });
});

describe("isBlockedHost", () => {
  // Takes a normalized hostname: lowercased, IPv6 brackets already stripped.
  // The bypass spellings (v4-mapped hex, 6to4, NAT64) are owned only here;
  // the workers-pool safe-fetch test covers the URL-level guard.
  it("blocks private, local and embedded-private hosts, and allows their public neighbours", () => {
    const blocked = [
      "localhost", "localhost.", "printer.local", "printer.local.",
      "0.0.0.0", "10.0.0.5", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "100.64.0.1", "100.127.255.255", "192.0.0.1", "198.18.0.1", "198.19.255.255",
      "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff00::1",
      "::ffff:10.0.0.5", "::ffff:a00:5", "::ffff:100.64.0.1",
      "2002:a00:5::1", "2002:c0a8:1::1",
      "64:ff9b::a00:5", "64:ff9b::7f00:1", "64:ff9b::10.0.0.5",
    ];
    const allowed = [
      "example.com", "8.8.8.8", "9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.1",
      "192.167.1.1", "100.63.255.255", "100.128.0.1", "192.0.1.1", "198.17.255.255", "198.20.0.1",
      "223.255.255.255", "2606:4700::6810:84e5", "fe7f::1",
      "::ffff:808:808", "2002:808:808::1", "64:ff9b::808:808",
    ];
    for (const host of blocked) expect(isBlockedHost(host), `blocks ${host}`).toBe(true);
    for (const host of allowed) expect(isBlockedHost(host), `allows ${host}`).toBe(false);
  });
});

describe("R2 content", () => {
  // The live corpus is stored under these exact spellings; changing one
  // strands every object already written under the old key.
  it("spells every object key under the global and a tenant root, and keeps key_prefix relative", () => {
    const kp = buildKeyPrefix("rd_abc", "2026-04-26T20:00:00.000Z");
    expect(kp).toBe("readings/2026/04/26T200000Z-rd_abc");
    for (const root of ["", "u/t_founder/"]) {
      const layout = r2KeyLayout(root || undefined);
      expect(layout.refreshCursorKey(), root).toBe(`${root}index/refresh-cursor.json`);
      expect(layout.readingObjectsPrefix(kp), root).toBe(`${root}${kp}/`);
      expect(layout.extractedKey(kp), root).toBe(`${root}${kp}/extracted.md`);
      expect(layout.rawKey(kp, "pdf"), root).toBe(`${root}${kp}/raw.pdf`);
      expect(layout.revisionsPrefix(kp), root).toBe(`${root}${kp}/revisions/`);
      expect(layout.revisionRawKey(kp, "at_123", "html"), root).toBe(`${root}${kp}/revisions/at_123/raw.html`);
      expect(layout.revisionExtractedKey(kp, "at_123"), root).toBe(`${root}${kp}/revisions/at_123/extracted.md`);
    }
  });

  it("never sweeps content the reading still points at, this attempt's own revision, or keys outside its prefix", async () => {
    const KEY_PREFIX = "readings/2026/04/26T200000Z-rd_1";
    const io = (content: Pick<ContentStore, "deletePrefix" | "delete">, currentRawKey: string) =>
      new AttemptIo(
        { contentKeys: async () => ({ rawKey: currentRawKey, extractedKey: null, contentType: "text/html" }) } as never,
        {} as never,
        content as ContentStore,
        {} as never,
        {} as never,
        {
          id: "rd_1",
          url: "https://example.com/a",
          urlHash: "h",
          createdAt: "2026-04-26T20:00:00.000Z",
          keyPrefix: KEY_PREFIX,
          attemptId: "at_new",
          attemptStartedAt: "2026-04-26T20:00:00.000Z",
          trigger: "reprocess",
          email: false,
        },
      );
    const live = `${KEY_PREFIX}/revisions/at_new/raw.html`;
    const cases = [
      ["still referenced", `${KEY_PREFIX}/revisions/at_old/raw.html`, null, `${KEY_PREFIX}/revisions/at_old/raw.html`],
      ["this attempt's revision", live, null, `${KEY_PREFIX}/revisions/at_other/raw.html`],
      ["another reading's prefix", "readings/2026/04/26T200000Z-rd_2/raw.html", null, live],
      ["nested below key_prefix", `${KEY_PREFIX}/attempts/raw.html`, null, live],
      ["extracted key elsewhere", `${KEY_PREFIX}/raw.html`, "readings/2026/04/26T200000Z-rd_2/extracted.md", live],
    ] as const;
    for (const [label, rawKey, extractedKey, current] of cases) {
      const content = { deletePrefix: vi.fn(async () => 0), delete: vi.fn(async () => undefined) };
      await io(content, current).discardSupersededContent({ rawKey, extractedKey });
      expect(content.deletePrefix, label).not.toHaveBeenCalled();
      expect(content.delete, label).not.toHaveBeenCalled();
    }
  });
});
