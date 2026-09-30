import { BILLING_TENANT, FAIL_CLOSED_CASES, spendHarness } from "../../helpers/operator-spend";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCandidateMatrix,
  candidateLabel,
  formatComparisonPlan,
  parseComparisonArgs,
  parseAnthropicEffort,
  prepareComparison,
  runCheckpointedComparison,
  runComparison,
  runCompareSummaryEffort,
  summarizerDepsForCandidate,
  writeComparisonArtifacts,
  type ComparisonCandidate,
  type ComparisonPlan,
  type FrozenReading,
  type RunComparisonDeps,
} from "../../../.agents/skills/compare-summary-effort/scripts/compare-summary-effort";

const ARTICLE_URL =
  "https://www.thealgorithmicbridge.com/p/the-actual-reason-why-google-fell";
const OTHER_URL = "https://example.com/other-article";

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

function productionBaseline(): FrozenReading["productionBaseline"] {
  return {
    title: "Production title",
    tldr: "Production TLDR",
    tags: ["ai"],
    keywords: ["reasoning effort"],
    people: [],
    orgs: ["OpenAI"],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: "Production summary.",
  };
}

function openaiCandidate(
  effort: "low" | "high" | "max" = "low",
  model = "gpt-5.6-terra",
): ComparisonCandidate {
  return { provider: "openai", model, reasoningEffort: effort };
}

function anthropicCandidate(
  model = "claude-sonnet-5",
): ComparisonCandidate {
  return { provider: "anthropic", model, anthropicEffort: "low" };
}

function checkpointPlan(
  candidates: ComparisonCandidate[] = [openaiCandidate("low"), openaiCandidate("high")],
): ComparisonPlan {
  const baseline = productionBaseline();
  return {
    readings: [
      {
        readingId: "rd_MAIN",
        contentSha256: "d".repeat(64),
        input: {
          url: ARTICLE_URL,
          extractedText: "Complete article body.",
          similarReadings: [],
        },
        productionBaseline: baseline,
      },
    ],
    candidates,
    openaiModel: "gpt-5.6-terra",
    efforts: candidates.flatMap((candidate) =>
      candidate.provider === "openai" ? [candidate.reasoningEffort] : [],
    ),
    inputPricePerMillion: 2,
    outputPricePerMillion: 12,
    anthropicInputPricePerMillion: 3,
    anthropicOutputPricePerMillion: 15,
    priceDate: "2026-07-30",
    estimatedMaximumCostUsd: 0.3,
  };
}

function openaiUsage(model: string, reasoningTokens = 100) {
  return {
    provider: "openai" as const,
    model,
    input_tokens: 20_000,
    output_tokens: 1_000,
    reasoning_tokens: reasoningTokens,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  };
}

function anthropicUsage(model: string) {
  return {
    provider: "anthropic" as const,
    model,
    input_tokens: 18_000,
    output_tokens: 800,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function productionFetch(readings: Record<string, { manifest: ReturnType<typeof readyManifest>; raw: string; extracted: string }>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer reader-token");
    const url = new URL(request.url);
    if (url.pathname === "/api/readings/lookup") {
      const source = url.searchParams.get("url");
      const match = Object.values(readings).find((item) => item.manifest.url === source);
      if (!match) return new Response("not found", { status: 404 });
      return Response.json({ id: match.manifest.id });
    }
    const idMatch = url.pathname.match(/^\/api\/readings\/([^/]+)(?:\/content(\/raw)?)?$/);
    if (!idMatch) return new Response("not found", { status: 404 });
    const id = idMatch[1]!;
    const item = readings[id];
    if (!item) return new Response("not found", { status: 404 });
    if (idMatch[2] === "/raw") {
      return new Response(item.raw, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (idMatch[1] && url.pathname.endsWith("/content")) {
      return new Response(item.extracted, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    return Response.json(item.manifest);
  });
}

describe("compare-summary-effort", () => {
  it("defaults to a dry-run OpenAI effort matrix plus Sonnet at pinned low effort", () => {
    expect(parseComparisonArgs(["--target", ARTICLE_URL])).toEqual({
      targets: [ARTICLE_URL],
      baseUrl: "https://readinglite.ai",
      execute: false,
      efforts: ["low", "medium", "high", "xhigh"],
      includeAnthropic: true,
      anthropicModel: "claude-sonnet-5-5",
      anthropicEffort: "low",
      outputDir: undefined,
      model: undefined,
      inputPricePerMillion: 2,
      outputPricePerMillion: 12,
      anthropicInputPricePerMillion: 3,
      anthropicOutputPricePerMillion: 15,
      priceDate: "2026-07-30",
    });
    expect(
      buildCandidateMatrix(parseComparisonArgs(["--target", ARTICLE_URL]), "gpt-5.6-luna"),
    ).toEqual([
      { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "low" },
      { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
      { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "high" },
      { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
      { provider: "anthropic", model: "claude-sonnet-5-5", anthropicEffort: "low" },
    ]);
  });

  it("honors an explicit --base-url over the production default", () => {
    expect(
      parseComparisonArgs([
        "--target",
        ARTICLE_URL,
        "--base-url",
        "https://reading-lite.bbell.dev",
      ]).baseUrl,
    ).toBe("https://reading-lite.bbell.dev");
  });

  it("accepts the full OpenAI effort set including max", () => {
    expect(
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--effort",
        "none",
        "--effort",
        "low",
        "--effort",
        "medium",
        "--effort",
        "high",
        "--effort",
        "xhigh",
        "--effort",
        "max",
      ]).efforts,
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("accepts repeated production targets", () => {
    expect(
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--target",
        OTHER_URL,
        "--model",
        "gpt-5.6-luna",
        "--effort",
        "max",
      ]).targets,
    ).toEqual(["rd_MAIN", OTHER_URL]);
  });

  it("rejects unsupported OpenAI effort values before any API call", () => {
    expect(() =>
      parseComparisonArgs(["--target", ARTICLE_URL, "--effort", "turbo"]),
    ).toThrow("invalid OPENAI_SUMMARIZATION_REASONING_EFFORT: turbo");
  });

  it("rejects Anthropic-incompatible effort values and pins a real effort", () => {
    expect(() => parseAnthropicEffort("none")).toThrow(
      "invalid Anthropic effort: none (expected low|medium|high|xhigh|max)",
    );
    expect(() => parseAnthropicEffort("turbo")).toThrow(
      "invalid Anthropic effort: turbo (expected low|medium|high|xhigh|max)",
    );
    expect(parseAnthropicEffort("xhigh")).toBe("xhigh");
    expect(
      parseComparisonArgs(["--target", "rd_MAIN", "--anthropic-effort", "high"]),
    ).toMatchObject({
      anthropicModel: "claude-sonnet-5-5",
      anthropicEffort: "high",
    });
    expect(
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--anthropic-model",
        "claude-sonnet-4-6",
        "--anthropic-effort",
        "max",
      ]),
    ).toMatchObject({
      anthropicModel: "claude-sonnet-4-6",
      anthropicEffort: "max",
    });
  });

  it("rejects thinking-incompatible Anthropic model/effort pairs at argv parse before freeze or spend", async () => {
    expect(() =>
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--anthropic-model",
        "claude-opus-5",
        "--anthropic-effort",
        "max",
      ]),
    ).toThrow(/invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: max/);
    expect(() =>
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--anthropic-model",
        "claude-sonnet-4-6",
        "--anthropic-effort",
        "xhigh",
      ]),
    ).toThrow(/invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: xhigh/);
    expect(() =>
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--anthropic-effort",
        "xhigh",
      ]),
    ).toThrow(/invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: xhigh/);
    expect(() =>
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--anthropic-model",
        "claude-fable-5",
      ]),
    ).toThrow(/unsupported ANTHROPIC_MODEL for effort: claude-fable-5/);
    expect(() =>
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--openai-only",
        "--anthropic-model",
        "claude-fable-5",
      ]),
    ).not.toThrow();

    const fetchFn = vi.fn<typeof fetch>();
    const summarize = vi.fn();
    await expect(
      runCompareSummaryEffort(
        [
          "--target",
          "rd_MAIN",
          "--anthropic-model",
          "claude-opus-5",
          "--anthropic-effort",
          "max",
          "--execute", "--env", "staging", "--billing-tenant", BILLING_TENANT,
        ],
        {
          fetch: fetchFn,
          openSpend: spendHarness().openSpend,
          now: () => Date.parse("2026-08-03T04:00:00.000Z"),
          credentials: {
            READER_API_TOKEN: "reader-token",
            OPENAI_API_KEY: "sk-openai",
            ANTHROPIC_API_KEY: "sk-ant",
          },
          summarize,
        },
      ),
    ).rejects.toThrow(/invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: max/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("resolves a URL into one frozen comparison input using production GETs only", async () => {
    const rawContent = "<html><body><article>Complete body.</article></body></html>";
    const extractedContent = "# Captured article\n\nComplete body.";
    const contentSha = createHash("sha256").update(rawContent).digest("hex");
    const fetchFn = productionFetch({
      rd_MAIN: {
        manifest: readyManifest({
          source_type: "url",
          content_type: "text/html; charset=utf-8",
          content_bytes: Buffer.byteLength(rawContent),
          extracted_bytes: Buffer.byteLength(extractedContent),
          content_sha256: contentSha,
        }),
        raw: rawContent,
        extracted: extractedContent,
      },
      rd_CONTEXT: {
        manifest: readyManifest({
          id: "rd_CONTEXT",
          url: "https://example.com/context",
          url_hash: "c".repeat(64),
          title: "A related reading",
          connections: [],
        }),
        raw: rawContent,
        extracted: extractedContent,
      },
    });

    const plan = await prepareComparison(
      parseComparisonArgs(["--target", ARTICLE_URL]),
      { fetch: fetchFn, readerToken: "reader-token" },
    );

    expect(plan.readings).toHaveLength(1);
    expect(plan.readings[0]!.readingId).toBe("rd_MAIN");
    expect(plan.openaiModel).toBe("gpt-5.6-terra");
    expect(plan.readings[0]!.input).toEqual({
      url: ARTICLE_URL,
      title: "Google's competing theory of intelligence",
      extractedText: extractedContent,
      similarReadings: [
        {
          id: "rd_CONTEXT",
          url: "https://example.com/context",
          title: "A related reading",
          tldr: "Google is betting on world models while rivals bet on coding agents.",
        },
      ],
    });
    expect(plan.readings[0]!.productionBaseline.summary_markdown).toBe(
      "A production baseline.",
    );
    expect(plan.candidates).toEqual([
      { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "low" },
      { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "medium" },
      { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "high" },
      { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "xhigh" },
      { provider: "anthropic", model: "claude-sonnet-5-5", anthropicEffort: "low" },
    ]);
    expect(plan.estimatedMaximumCostUsd).toBeCloseTo(0.736_096, 6);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(
      fetchFn.mock.calls.every((call) => {
        const request =
          call[0] instanceof Request ? call[0] : new Request(call[0], call[1]);
        return request.method === "GET";
      }),
    ).toBe(true);
  });

  it("freezes N readings independently and keeps production traffic GET-only", async () => {
    const rawMain = "<html>main</html>";
    const rawOther = "<html>other</html>";
    const fetchFn = productionFetch({
      rd_MAIN: {
        manifest: readyManifest({
          connections: [],
          content_sha256: createHash("sha256").update(rawMain).digest("hex"),
        }),
        raw: rawMain,
        extracted: "# Main",
      },
      rd_OTHER: {
        manifest: readyManifest({
          id: "rd_OTHER",
          url: OTHER_URL,
          url_hash: "d".repeat(64),
          title: "Other article",
          connections: [],
          content_sha256: createHash("sha256").update(rawOther).digest("hex"),
        }),
        raw: rawOther,
        extracted: "# Other",
      },
    });

    const plan = await prepareComparison(
      parseComparisonArgs([
        "--target",
        "rd_MAIN",
        "--target",
        "rd_OTHER",
        "--model",
        "gpt-5.6-luna",
        "--effort",
        "max",
      ]),
      { fetch: fetchFn, readerToken: "reader-token" },
    );

    expect(plan.readings.map((reading) => reading.readingId)).toEqual([
      "rd_MAIN",
      "rd_OTHER",
    ]);
    expect(plan.readings[0]!.input.extractedText).toBe("# Main");
    expect(plan.readings[1]!.input.extractedText).toBe("# Other");
    expect(plan.candidates).toEqual([
      { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" },
      { provider: "anthropic", model: "claude-sonnet-5-5", anthropicEffort: "low" },
    ]);
    expect(plan.estimatedMaximumCostUsd).toBeCloseTo(0.642_368, 6);
    expect(
      fetchFn.mock.calls.every((call) => {
        const request =
          call[0] instanceof Request ? call[0] : new Request(call[0], call[1]);
        return request.method === "GET";
      }),
    ).toBe(true);
  });

  it("rejects when the raw capture no longer matches the manifest hash", async () => {
    const expectedRaw = "<html><body>Expected capture</body></html>";
    const fetchedRaw = "<html><body>Different capture</body></html>";
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === "/api/readings/rd_MAIN") {
        return Response.json(
          readyManifest({
            source_type: "url",
            connections: [],
            content_type: "text/html; charset=utf-8",
            content_bytes: Buffer.byteLength(expectedRaw),
            content_sha256: createHash("sha256")
              .update(expectedRaw)
              .digest("hex"),
          }),
        );
      }
      if (url.pathname === "/api/readings/rd_MAIN/content") {
        return new Response("# Extracted article");
      }
      if (url.pathname === "/api/readings/rd_MAIN/content/raw") {
        return new Response(fetchedRaw);
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      prepareComparison(parseComparisonArgs(["--target", "rd_MAIN"]), {
        fetch: fetchFn,
        readerToken: "reader-token",
      }),
    ).rejects.toThrow("content hash mismatch for rd_MAIN");
  });

  it("runs every candidate sequentially over the same frozen input per reading", async () => {
    const plan = checkpointPlan([
      openaiCandidate("low"),
      openaiCandidate("high"),
      anthropicCandidate(),
    ]);
    const summarize = vi.fn(async (_input, candidate: ComparisonCandidate) => ({
      reading: {
        ...plan.readings[0]!.productionBaseline,
        tldr:
          candidate.provider === "openai"
            ? `${candidate.reasoningEffort} result`
            : "sonnet result",
      },
      usage:
        candidate.provider === "openai"
          ? openaiUsage(candidate.model, candidate.reasoningEffort === "high" ? 400 : 100)
          : anthropicUsage(candidate.model),
    }));
    const times = [0, 10, 10, 35, 35, 50];

    const results = await runComparison(plan, {
      summarize,
      now: () => times.shift()!,
    });

    expect(summarize).toHaveBeenCalledTimes(3);
    expect(summarize.mock.calls[0]![0]).toBe(plan.readings[0]!.input);
    expect(summarize.mock.calls[1]![0]).toBe(plan.readings[0]!.input);
    expect(summarize.mock.calls[2]![0]).toBe(plan.readings[0]!.input);
    expect(summarize.mock.calls.map((call) => call[1])).toEqual([
      { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "low" },
      { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "high" },
      { provider: "anthropic", model: "claude-sonnet-5", anthropicEffort: "low" },
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        readingId: "rd_MAIN",
        provider: "openai",
        reasoningEffort: "low",
        latencyMs: 10,
        estimatedCostUsd: 0.052,
      }),
      expect.objectContaining({
        readingId: "rd_MAIN",
        provider: "openai",
        reasoningEffort: "high",
        latencyMs: 25,
        estimatedCostUsd: 0.052,
      }),
      expect.objectContaining({
        readingId: "rd_MAIN",
        provider: "anthropic",
        model: "claude-sonnet-5",
        anthropicEffort: "low",
        latencyMs: 15,
        estimatedCostUsd: 0.066,
      }),
    ]);
    expect(results[2]).not.toHaveProperty("reasoningEffort");
  });

  it("checkpoints a successful candidate before starting the next paid call", async () => {
    const plan = checkpointPlan();
    const events: string[] = [];
    let releaseCheckpoint = () => {};
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let announceCheckpoint = () => {};
    const checkpointStarted = new Promise<void>((resolve) => {
      announceCheckpoint = resolve;
    });
    const summarize = vi.fn(async (_input, candidate: ComparisonCandidate) => {
      const label =
        candidate.provider === "openai" ? candidate.reasoningEffort : candidate.provider;
      events.push(`summarize:${label}`);
      if (candidate.provider === "openai" && candidate.reasoningEffort === "high") {
        throw new Error("high effort failed");
      }
      return {
        reading: plan.readings[0]!.productionBaseline,
        usage: openaiUsage(candidate.model),
      };
    });
    const times = [0, 10, 10];
    const comparison = runComparison(plan, {
      summarize,
      now: () => times.shift()!,
      onProgress: async (observation) => {
        events.push(`checkpoint:${observation.reasoningEffort}:start`);
        announceCheckpoint();
        await checkpointGate;
        events.push(`checkpoint:${observation.reasoningEffort}:end`);
      },
    });
    const settled = comparison.then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await checkpointStarted;
      expect(summarize).toHaveBeenCalledTimes(1);
      releaseCheckpoint();
      await expect(settled).resolves.toEqual(
        expect.objectContaining({ message: "high effort failed" }),
      );
      expect(events).toEqual([
        "summarize:low",
        "checkpoint:low:start",
        "checkpoint:low:end",
        "summarize:high",
      ]);
    } finally {
      releaseCheckpoint();
      await settled;
    }
  });

  it("persists completed candidates when a later paid call fails", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "compare-summary-effort-checkpoint-test-"),
    );
    const plan = checkpointPlan();

    try {
      await expect(
        runCheckpointedComparison(plan, outputDir, "2026-08-03T04:00:00.000Z", {
          now: () => 0,
          summarize: async (_input, candidate: ComparisonCandidate) => {
            if (candidate.provider === "openai" && candidate.reasoningEffort === "high") {
              throw new Error("high effort failed");
            }
            return {
              reading: plan.readings[0]!.productionBaseline,
              usage: openaiUsage(candidate.model),
            };
          },
        }),
      ).rejects.toThrow("high effort failed");

      const [results, report] = await Promise.all([
        readFile(path.join(outputDir, "results.json"), "utf8").then(JSON.parse),
        readFile(path.join(outputDir, "report.md"), "utf8"),
      ]);
      expect(results.readings[0].candidates).toEqual([
        expect.objectContaining({ reasoningEffort: "low" }),
      ]);
      expect(report).toContain("### openai/gpt-5.6-terra/low");
      expect(report).not.toContain("### openai/gpt-5.6-terra/high");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes a local comparison report without duplicating the captured article", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "compare-summary-effort-test-"),
    );
    const plan = checkpointPlan([openaiCandidate("high"), anthropicCandidate()]);
    plan.readings[0]!.input.extractedText =
      "Complete article body that must not be duplicated.";
    plan.readings[0]!.input.title = "Production title";
    const observations = [
      {
        readingId: "rd_MAIN",
        provider: "openai" as const,
        model: "gpt-5.6-terra",
        reasoningEffort: "high" as const,
        latencyMs: 1_234,
        reading: {
          ...plan.readings[0]!.productionBaseline,
          tldr: "High-effort TLDR",
          summary_markdown: "High-effort summary.",
        },
        usage: openaiUsage("gpt-5.6-terra", 300),
        estimatedCostUsd: 0.0532,
      },
      {
        readingId: "rd_MAIN",
        provider: "anthropic" as const,
        model: "claude-sonnet-5",
        anthropicEffort: "low" as const,
        latencyMs: 900,
        reading: {
          ...plan.readings[0]!.productionBaseline,
          tldr: "Sonnet TLDR",
          summary_markdown: "Sonnet summary.",
        },
        usage: anthropicUsage("claude-sonnet-5"),
        estimatedCostUsd: 0.066,
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
      expect(report).toContain("# Summarizer comparison");
      expect(report).toContain("Production baseline");
      expect(report).toContain("High-effort summary.");
      expect(report).toContain("Sonnet summary.");
      expect(report).toContain(
        "| rd_MAIN | openai/gpt-5.6-terra/high | 1234 | 20000 | 1000 | 300 | $0.053200 |",
      );
      expect(report).toContain(
        "| rd_MAIN | anthropic/claude-sonnet-5/low | 900 | 18000 | 800 | cache r0/w0 | $0.066000 |",
      );
      const parsed = JSON.parse(json) as {
        comparison: { candidates: Array<Record<string, unknown>> };
        readings: Array<{ candidates: Array<Record<string, unknown>> }>;
      };
      expect(parsed.comparison.candidates[1]).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
        anthropicEffort: "low",
      });
      expect(parsed.readings[0]!.candidates[1]).toEqual(
        expect.objectContaining({ anthropicEffort: "low" }),
      );
      expect(parsed.readings[0]!.candidates[1]).not.toHaveProperty("reasoningEffort");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("plans by default and only pays on --execute, without writing production", async () => {
    const rawContent = "<html>body</html>";
    const sha = createHash("sha256").update(rawContent).digest("hex");
    const fetchFn = productionFetch({
      rd_MAIN: {
        manifest: readyManifest({
          connections: [],
          content_sha256: sha,
        }),
        raw: rawContent,
        extracted: "# Article",
      },
    });
    const summarize = vi.fn<RunComparisonDeps["summarize"]>(async () => ({
      reading: productionBaseline(),
      usage: openaiUsage("gpt-5.6-luna"),
    }));
    const stdout: string[] = [];

    const planResult = await runCompareSummaryEffort(
      ["--target", "rd_MAIN", "--model", "gpt-5.6-luna", "--effort", "max"],
      {
        fetch: fetchFn,
        openSpend: spendHarness().openSpend,
        now: () => Date.parse("2026-08-03T04:00:00.000Z"),
        credentials: { READER_API_TOKEN: "reader-token" },
        summarize,
        stdout: (text) => stdout.push(text),
      },
    );

    expect(planResult.mode).toBe("plan");
    expect(summarize).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain("[DRY RUN] 1 reading × 2 candidates = 2 provider calls");
    expect(stdout.join("")).toContain("conservative maximum:");
    expect(stdout.join("")).toContain("anthropic/claude-sonnet-5-5");
    expect(stdout.join("")).toContain("No provider calls made");

    const outputDir = await mkdtemp(
      path.join(tmpdir(), "compare-summary-effort-execute-test-"),
    );
    try {
      summarize.mockImplementation(async (_input, candidate) => ({
        reading: productionBaseline(),
        usage:
          candidate.provider === "openai"
            ? openaiUsage(candidate.model)
            : anthropicUsage(candidate.model),
      }));
      const executeResult = await runCompareSummaryEffort(
        [
          "--target",
          "rd_MAIN",
          "--model",
          "gpt-5.6-luna",
          "--effort",
          "max",
          "--execute", "--env", "staging", "--billing-tenant", BILLING_TENANT,
          "--output-dir",
          outputDir,
        ],
        {
          fetch: fetchFn,
          openSpend: spendHarness().openSpend,
          now: () => Date.parse("2026-08-03T04:00:00.000Z"),
          credentials: {
            READER_API_TOKEN: "reader-token",
            OPENAI_API_KEY: "sk-openai",
            ANTHROPIC_API_KEY: "sk-ant",
          },
          summarize,
          stdout: (text) => stdout.push(text),
          stderr: () => {},
        },
      );
      expect(executeResult.mode).toBe("execute");
      expect(summarize).toHaveBeenCalledTimes(2);
      expect(summarize.mock.calls.map((call) => call[1])).toEqual([
        { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" },
        { provider: "anthropic", model: "claude-sonnet-5-5", anthropicEffort: "low" },
      ]);
      expect(
        fetchFn.mock.calls.every((call) => {
          const request =
            call[0] instanceof Request ? call[0] : new Request(call[0], call[1]);
          return (
            request.method === "GET" &&
            new URL(request.url).hostname === "readinglite.ai"
          );
        }),
      ).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("requires Anthropic credentials only when Sonnet is in the paid matrix", async () => {
    const rawContent = "<html>body</html>";
    const sha = createHash("sha256").update(rawContent).digest("hex");
    const fetchFn = productionFetch({
      rd_MAIN: {
        manifest: readyManifest({
          connections: [],
          content_sha256: sha,
        }),
        raw: rawContent,
        extracted: "# Article",
      },
    });
    await expect(
      runCompareSummaryEffort(
        ["--target", "rd_MAIN", "--effort", "max", "--execute", "--env", "staging", "--billing-tenant", BILLING_TENANT],
        {
          fetch: fetchFn,
          openSpend: spendHarness().openSpend,
          now: () => Date.now(),
          credentials: {
            READER_API_TOKEN: "reader-token",
            OPENAI_API_KEY: "sk-openai",
          },
          summarize: async () => ({
            reading: productionBaseline(),
            usage: openaiUsage("gpt-5.6-terra"),
          }),
          stdout: () => {},
        },
      ),
    ).rejects.toThrow("missing ANTHROPIC_API_KEY");

    const outputDir = await mkdtemp(
      path.join(tmpdir(), "compare-summary-effort-openai-only-"),
    );
    try {
      const result = await runCompareSummaryEffort(
        [
          "--target",
          "rd_MAIN",
          "--effort",
          "max",
          "--openai-only",
          "--execute", "--env", "staging", "--billing-tenant", BILLING_TENANT,
          "--output-dir",
          outputDir,
        ],
        {
          fetch: fetchFn,
          openSpend: spendHarness().openSpend,
          now: () => Date.parse("2026-08-03T04:00:00.000Z"),
          credentials: {
            READER_API_TOKEN: "reader-token",
            OPENAI_API_KEY: "sk-openai",
          },
          summarize: async () => ({
            reading: productionBaseline(),
            usage: openaiUsage("gpt-5.6-terra"),
          }),
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(result.plan.candidates).toEqual([
        { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" },
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("prints the paid-call matrix and cost ceiling in plan text", () => {
    const plan = checkpointPlan([openaiCandidate("max", "gpt-5.6-luna"), anthropicCandidate()]);
    const text = formatComparisonPlan(plan, false);
    expect(text).toContain("[DRY RUN] 1 reading × 2 candidates = 2 provider calls");
    expect(text).toContain("openai/gpt-5.6-luna effort=max");
    expect(text).toContain("anthropic/claude-sonnet-5 effort=low");
    expect(text).toContain("anthropic: claude-sonnet-5 effort=low");
    expect(text).toContain("conservative maximum: $0.3000");
  });

  it("pins Anthropic effort on candidate identity and ignores ambient env", () => {
    const previous = process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
    try {
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
      const low = buildCandidateMatrix(
        parseComparisonArgs(["--target", "rd_MAIN", "--effort", "max"]),
        "gpt-5.6-luna",
      );
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "high";
      const high = buildCandidateMatrix(
        parseComparisonArgs(["--target", "rd_MAIN", "--effort", "max"]),
        "gpt-5.6-luna",
      );
      expect(low).toEqual(high);
      expect(candidateLabel(low[1]!)).toBe("anthropic/claude-sonnet-5-5 effort=low");
      const creds = {
        fetch: globalThis.fetch,
        openaiApiKey: "sk-openai",
        anthropicApiKey: "sk-ant",
      };
      expect(summarizerDepsForCandidate(low[0]!, creds)).toEqual(
        expect.objectContaining({
          provider: "openai",
          openaiModel: "gpt-5.6-luna",
          openaiReasoningEffort: "max",
        }),
      );
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
      const depsLow = summarizerDepsForCandidate(low[1]!, creds);
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "max";
      const depsHigh = summarizerDepsForCandidate(high[1]!, creds);
      expect(depsLow).toEqual(depsHigh);
      expect(depsLow).toMatchObject({ provider: "anthropic", anthropicModel: "claude-sonnet-5-5" });
      expect(depsLow.anthropicReasoningEffort).toBe("low");
      expect(depsLow).not.toHaveProperty("anthropicEffort");
      expect(depsLow).not.toHaveProperty("openaiReasoningEffort");
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
      } else {
        process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = previous;
      }
    }
  });
});

// reading-lite-gh319.1. No `summarize` override here: the real summarizer runs
// over the transport the CLI hands it. productionFetch only answers GETs with
// the reader bearer, so a provider POST reaching it would fail its assertions.
describe("compare-summary-effort spend admission", () => {
  function cli(authority: Parameters<typeof spendHarness>[0] = "allow") {
    const rawContent = "<html>body</html>";
    const fetchFn = productionFetch({
      rd_MAIN: {
        manifest: readyManifest({
          connections: [],
          content_sha256: createHash("sha256").update(rawContent).digest("hex"),
        }),
        raw: rawContent,
        extracted: "# Article",
      },
    });
    const spend = spendHarness(authority);
    const run = (...argv: string[]) =>
      runCompareSummaryEffort(["--target", "rd_MAIN", "--openai-only", "--effort", "low", ...argv], {
        fetch: fetchFn,
        openSpend: spend.openSpend,
        now: () => Date.parse("2026-08-03T04:00:00.000Z"),
        credentials: { READER_API_TOKEN: "reader-token", OPENAI_API_KEY: "sk-openai" },
        stdout: () => {},
        stderr: () => {},
      });
    return { run, spend, fetchFn };
  }
  const billed = ["--env", "staging", "--billing-tenant", BILLING_TENANT];

  it("plans without a spend session", async () => {
    const { run, spend } = cli();
    expect((await run()).mode).toBe("plan");
    expect(spend.openSpend).not.toHaveBeenCalled();
  });

  it.each([
    [["--execute", "--env", "staging"], /requires --billing-tenant/],
    [["--execute", "--env", "staging", "--billing-tenant", "global"], /malformed --billing-tenant/],
    [["--execute", "--billing-tenant", BILLING_TENANT], /--env must be staging or production/],
  ])("refuses %j before reading anything", async (argv, message) => {
    const { run, spend, fetchFn } = cli();
    await expect(run(...argv)).rejects.toThrow(message);
    expect(spend.openSpend).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(FAIL_CLOSED_CASES.filter(([, authority]) => authority !== "allow"))(
    "makes no provider request after %s",
    async (_label, authority, _request, refusal) => {
      const outputDir = await mkdtemp(path.join(tmpdir(), "compare-summary-effort-spend-"));
      try {
        const { run, spend, fetchFn } = cli(authority);
        await expect(run(...billed, "--execute", "--output-dir", outputDir)).rejects.toThrow(refusal);
        expect(fetchFn.mock.calls.map(([input]) => String(input)).filter((url) => !url.includes("/api/readings"))).toEqual([]);
        expect(spend.dispose).toHaveBeenCalledTimes(1);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("refuses a model the price catalog cannot bound", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "compare-summary-effort-spend-"));
    try {
      const { run, spend, fetchFn } = cli();
      await expect(
        run(...billed, "--model", "gpt-unpriced", "--execute", "--output-dir", outputDir),
      ).rejects.toThrow(/unbounded_request/);
      expect(spend.calls).toEqual([]);
      expect(fetchFn.mock.calls.map(([input]) => String(input)).filter((url) => !url.includes("/api/readings"))).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
