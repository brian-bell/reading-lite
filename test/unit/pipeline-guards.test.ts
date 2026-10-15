// Reading pipeline guards that no integration test owns: prompt-cache
// stability, fail-closed provider configuration, SSRF host blocking, the R2
// key spelling the live corpus is stored under, the content sweep's
// refusal to delete what a reading still points at, and the weekly refresh budget.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AttemptIo } from "../../src/attempt-io";
import { REFRESH_CRON, opensNewRefreshBudget } from "../../src/refresh-period";
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

describe("opensNewRefreshBudget", () => {
  it("opens on the next Sunday 03:07 UTC and stays shut for the rest of that period", () => {
    const cases: [string, string, boolean, string][] = [
      ["2026-10-18T03:07:00.000Z", "2026-10-18T03:07:00.000Z", false, "same Sunday retry"],
      ["2026-10-18T03:07:13.000Z", "2026-10-18T03:07:13.000Z", false, "same firing with seconds"],
      ["2026-10-18T15:00:00.000Z", "2026-10-18T03:07:00.000Z", false, "later the same Sunday"],
      ["2026-10-18T03:22:00.000Z", "2026-10-18T03:07:00.000Z", false, "rollover already recorded this Sunday"],
      ["2026-10-18T03:07:00.000Z", "2026-10-18T02:00:00.000Z", true, "03:07 opens against a grant earlier that Sunday"],
      ["2026-10-18T02:00:00.000Z", "2026-10-11T03:07:00.000Z", false, "Sunday before 03:07 stays on the previous period"],
      ["2026-10-18T03:06:59.999Z", "2026-10-11T03:07:00.000Z", false, "one millisecond before the boundary"],
      ["2026-10-18T03:07:00.000Z", "2026-10-11T03:07:00.000Z", true, "exact boundary against the previous Sunday"],
      ["2026-10-19T03:07:00.000Z", "2026-10-18T03:07:00.000Z", false, "Monday stays in the Sunday period"],
      ["2026-10-24T23:59:59.999Z", "2026-10-18T03:07:00.000Z", false, "Saturday night stays in the Sunday period"],
      ["2026-10-17T03:07:00.000Z", "2026-10-14T03:07:00.000Z", false, "Saturday after a Wednesday grant stays in that period"],
      ["2026-10-18T03:07:00.000Z", "2026-10-14T03:07:00.000Z", true, "next Sunday opens against a Wednesday grant"],
      ["2026-10-18T03:07:00.000Z", "2026-10-17T03:07:00.000Z", true, "next Sunday opens against a Saturday grant"],
      ["2026-10-25T03:06:59.999Z", "2026-10-18T03:07:13.000Z", false, "one millisecond before the next Sunday"],
      ["2026-10-25T03:07:00.000Z", "2026-10-18T03:07:00.000Z", true, "next Sunday"],
      ["2026-11-01T03:07:00.000Z", "2026-10-25T03:07:00.000Z", true, "the Sunday of the US clock change"],
      ["2027-01-02T12:00:00.000Z", "2026-12-30T03:07:00.000Z", false, "Saturday 2 Jan stays on the December period"],
      ["2027-01-03T03:06:59.999Z", "2026-12-27T03:07:00.000Z", false, "one millisecond before 3 Jan"],
      ["2027-01-03T03:07:00.000Z", "2026-12-27T03:07:00.000Z", true, "Sunday 3 Jan opens across the year"],
      ["2026-10-18T03:07:00.000Z", "2026-10-25T03:07:00.000Z", false, "clock stepped backward"],
    ];
    for (const [now, budget, opens, label] of cases) {
      expect(opensNewRefreshBudget(now, budget), label).toBe(opens);
    }
  });

  it("rejects a date-only prefix and a rolled calendar date", () => {
    expect(() => opensNewRefreshBudget("2026-10-19", "2026-10-18T03:07:00.000Z")).toThrow(
      new RangeError("unparseable refresh instant 2026-10-19"),
    );
    expect(() => opensNewRefreshBudget("2026-02-31T03:07:00.000Z", "2026-10-18T03:07:00.000Z")).toThrow(
      new RangeError("unparseable refresh instant 2026-02-31T03:07:00.000Z"),
    );
  });

  it("keeps the 15-minute cron and points both hosted schedules at REFRESH_CRON", () => {
    const lines = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("crons = "));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line.slice("crons = ".length)), line).toEqual(["*/15 * * * *", REFRESH_CRON]);
    }
  });

  it("does not use weekday 0, which Cloudflare Workers rejects", () => {
    const weekday = REFRESH_CRON.split(" ")[4] ?? "";
    expect(weekday).toMatch(/^(SUN|MON|TUE|WED|THU|FRI|SAT|[1-7])$/i);
  });
});
