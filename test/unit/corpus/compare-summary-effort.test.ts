import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseComparisonArgs,
  prepareComparison,
  runComparison,
  writeComparisonArtifacts,
  type ComparisonPlan,
} from "../../../.agents/skills/compare-summary-effort/scripts/compare-summary-effort";

const ARTICLE_URL =
  "https://www.thealgorithmicbridge.com/p/the-actual-reason-why-google-fell";

function readyManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "rd_MAIN",
    url: ARTICLE_URL,
    url_hash: "a".repeat(64),
    source_type: "markdown",
    status: "ready",
    title: "Google's competing theory of intelligence",
    tldr: "Google is betting on world models while rivals bet on coding agents.",
    tags: ["ai"],
    keywords: ["world models", "coding agents", "AI strategy"],
    people: ["Demis Hassabis"],
    orgs: ["Google DeepMind"],
    novelty_verdict: "familiar",
    connections: [{ id: "rd_CONTEXT", reason: "Related AI strategy" }],
    summary_markdown: "A production baseline.",
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: 15,
    extracted_bytes: 15,
    content_sha256: "b".repeat(64),
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:01:00.000Z",
    usage: {
      summarization: {
        provider: "openai",
        model: "gpt-5.6-terra",
        input_tokens: 20_000,
        output_tokens: 1_000,
        reasoning_tokens: 200,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
      },
      openai_embedding_tokens: 2_000,
    },
    ...overrides,
  };
}

describe("compare-summary-effort", () => {
  it("defaults to a dry-run Terra effort matrix for a production URL", () => {
    expect(
      parseComparisonArgs([
        "--target",
        ARTICLE_URL,
      ]),
    ).toEqual({
      target:
        ARTICLE_URL,
      baseUrl: "https://reading-lite.bbell.dev",
      execute: false,
      efforts: ["low", "medium", "high", "xhigh"],
      outputDir: undefined,
      model: undefined,
      inputPricePerMillion: 2,
      outputPricePerMillion: 12,
      priceDate: "2026-07-30",
    });
  });

  it("rejects unsupported effort values before any API call", () => {
    expect(() =>
      parseComparisonArgs([
        "--target",
        ARTICLE_URL,
        "--effort",
        "turbo",
      ]),
    ).toThrow("invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: turbo");
  });

  it("resolves a URL into one frozen comparison input using production GETs only", async () => {
    const content = "# Captured article\n\nComplete body.";
    const contentSha = createHash("sha256").update(content).digest("hex");
    const fetchFn = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer reader-token");
      const url = new URL(request.url);
      if (url.pathname === "/api/readings/lookup") {
        expect(url.searchParams.get("url")).toBe(ARTICLE_URL);
        return Response.json({ id: "rd_MAIN" });
      }
      if (url.pathname === "/api/readings/rd_MAIN") {
        return Response.json(
          readyManifest({
            content_bytes: Buffer.byteLength(content),
            extracted_bytes: Buffer.byteLength(content),
            content_sha256: contentSha,
          }),
        );
      }
      if (url.pathname === "/api/readings/rd_MAIN/content") {
        return new Response(content, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/readings/rd_CONTEXT") {
        return Response.json(
          readyManifest({
            id: "rd_CONTEXT",
            url: "https://example.com/context",
            url_hash: "c".repeat(64),
            title: "A related reading",
            connections: [],
          }),
        );
      }
      return new Response("not found", { status: 404 });
      },
    );

    const plan = await prepareComparison(
      parseComparisonArgs(["--target", ARTICLE_URL]),
      { fetch: fetchFn, readerToken: "reader-token" },
    );

    expect(plan.readingId).toBe("rd_MAIN");
    expect(plan.model).toBe("gpt-5.6-terra");
    expect(plan.input).toEqual({
      url: ARTICLE_URL,
      title: "Google's competing theory of intelligence",
      extractedText: content,
      similarReadings: [
        {
          id: "rd_CONTEXT",
          url: "https://example.com/context",
          title: "A related reading",
          tldr: "Google is betting on world models while rivals bet on coding agents.",
        },
      ],
    });
    expect(plan.productionBaseline.summary_markdown).toBe(
      "A production baseline.",
    );
    expect(plan.estimatedMaximumCostUsd).toBeCloseTo(0.553_216, 6);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("runs every effort sequentially over the same frozen input", async () => {
    const productionBaseline = {
      title: "Google's competing theory of intelligence",
      tldr: "Google is betting on world models while rivals bet on coding agents.",
      tags: ["ai"],
      keywords: ["world models", "coding agents", "AI strategy"],
      people: ["Demis Hassabis"],
      orgs: ["Google DeepMind"],
      novelty_verdict: "familiar" as const,
      connections: [],
      summary_markdown: "A production baseline.",
    };
    const input = {
      url: ARTICLE_URL,
      title: productionBaseline.title,
      extractedText: "Complete article body.",
      similarReadings: [],
    };
    const plan: ComparisonPlan = {
      readingId: "rd_MAIN",
      contentSha256: "d".repeat(64),
      model: "gpt-5.6-terra",
      efforts: ["low", "high"],
      input,
      productionBaseline,
      inputPricePerMillion: 2,
      outputPricePerMillion: 12,
      priceDate: "2026-07-30",
      estimatedMaximumCostUsd: 0.3,
    };
    const summarize = vi.fn(async (_input, candidate) => ({
      reading: {
        ...productionBaseline,
        tldr: `${candidate.reasoningEffort} result`,
      },
      usage: {
        provider: "openai" as const,
        model: candidate.model,
        input_tokens: 20_000,
        output_tokens: 1_000,
        reasoning_tokens: candidate.reasoningEffort === "high" ? 400 : 100,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
      },
    }));
    const times = [0, 10, 10, 35];

    const results = await runComparison(plan, {
      summarize,
      now: () => times.shift()!,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0]![0]).toBe(input);
    expect(summarize.mock.calls[1]![0]).toBe(input);
    expect(summarize.mock.calls.map((call) => call[1])).toEqual([
      { model: "gpt-5.6-terra", reasoningEffort: "low" },
      { model: "gpt-5.6-terra", reasoningEffort: "high" },
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        effort: "low",
        latencyMs: 10,
        estimatedCostUsd: 0.052,
      }),
      expect.objectContaining({
        effort: "high",
        latencyMs: 25,
        estimatedCostUsd: 0.052,
      }),
    ]);
  });

  it("writes a local comparison report without duplicating the captured article", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "compare-summary-effort-test-"),
    );
    const productionBaseline = {
      title: "Production title",
      tldr: "Production TLDR",
      tags: ["ai"],
      keywords: ["world models", "coding agents", "AI strategy"],
      people: ["Demis Hassabis"],
      orgs: ["Google DeepMind"],
      novelty_verdict: "familiar" as const,
      connections: [],
      summary_markdown: "Production summary.",
    };
    const plan: ComparisonPlan = {
      readingId: "rd_MAIN",
      contentSha256: "d".repeat(64),
      model: "gpt-5.6-terra",
      efforts: ["high"],
      input: {
        url: ARTICLE_URL,
        title: productionBaseline.title,
        extractedText: "Complete article body that must not be duplicated.",
        similarReadings: [],
      },
      productionBaseline,
      inputPricePerMillion: 2,
      outputPricePerMillion: 12,
      priceDate: "2026-07-30",
      estimatedMaximumCostUsd: 0.14,
    };
    const observations = [
      {
        effort: "high" as const,
        latencyMs: 1_234,
        reading: {
          ...productionBaseline,
          tldr: "High-effort TLDR",
          summary_markdown: "High-effort summary.",
        },
        usage: {
          provider: "openai" as const,
          model: "gpt-5.6-terra",
          input_tokens: 20_000,
          output_tokens: 1_100,
          reasoning_tokens: 300,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
        },
        estimatedCostUsd: 0.0532,
      },
    ];

    try {
      const paths = await writeComparisonArtifacts(
        plan,
        observations,
        outputDir,
        "2026-08-03T04:00:00.000Z",
      );
      const [json, report] = await Promise.all([
        readFile(paths.resultsPath, "utf8"),
        readFile(paths.reportPath, "utf8"),
      ]);

      expect(json).not.toContain("Complete article body");
      expect(report).not.toContain("Complete article body");
      expect(report).toContain("# Summary effort comparison");
      expect(report).toContain("Production baseline");
      expect(report).toContain("High-effort summary.");
      expect(report).toContain("| high | 1234 | 20000 | 1100 | 300 | $0.053200 |");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
