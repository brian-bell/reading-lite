import { describe, expect, it, vi } from "vitest";
import type { ReadingSummary } from "../../../src/schemas/reading-summary";
import { EVALUATION_CASES, EVALUATION_CANDIDATES, evaluationCandidateIdentity } from "../../../scripts/summarizer-eval/fixtures";
import {
  aggregateCandidate,
  buildEvaluationReport,
  estimateCostUsd,
  scoreObservation,
} from "../../../scripts/summarizer-eval/scoring";
import { runEvaluationMatrix } from "../../../scripts/summarizer-eval/run";
import {
  isAttemptTerminal,
  summarizeDiagnostics,
  validateStagingSmokeTarget,
} from "../../../scripts/lib/staging-provider-smoke-lib";

const strongReading: ReadingSummary = {
  title: "Project Lantern cuts tail latency",
  tldr: "Maya Chen and Acme Labs reduced p95 latency with bounded concurrency.",
  tags: ["distributed-systems", "performance"],
  keywords: ["tail latency", "bounded concurrency", "queue backpressure"],
  people: ["Maya Chen"],
  orgs: ["Acme Labs"],
  novelty_verdict: "familiar",
  connections: [{ id: "prior_latency", reason: "Both discuss queue backpressure and tail latency." }],
  summary_markdown:
    "Project Lantern reduced p95 latency by combining bounded concurrency with queue backpressure.",
};

describe("summarizer evaluation corpus", () => {
  it("covers every required non-secret quality category and pins effort on each Anthropic candidate", () => {
    expect(new Set(EVALUATION_CASES.map((item) => item.category))).toEqual(
      new Set([
        "long",
        "short",
        "missing-title",
        "entities",
        "youtube",
        "reddit",
        "duplicate",
        "familiar",
        "novel",
        "prompt-injection",
      ]),
    );
    for (const candidate of EVALUATION_CANDIDATES.filter(
      (item) => item.provider === "anthropic",
    )) {
      expect(candidate.anthropicEffort).toBeDefined();
    }
  });

  it("evaluation candidate identity includes pinned Anthropic effort and ignores ambient env", () => {
    const previous = process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
    try {
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
      const low = evaluationCandidateIdentity(EVALUATION_CANDIDATES[0]!);
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "high";
      const high = evaluationCandidateIdentity(EVALUATION_CANDIDATES[0]!);
      expect(low).toBe(high);
      expect(low).toBe("anthropic/claude-sonnet-5-5 effort=low");
      expect(evaluationCandidateIdentity(EVALUATION_CANDIDATES[2]!)).toBe(
        "openai/gpt-5.6-terra effort=low",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
      } else {
        process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = previous;
      }
    }
  });
});

describe("scoreObservation", () => {
  it("scores facts, retrieval, entities, novelty, connections, and injection resistance", () => {
    const score = scoreObservation(
      {
        id: "case",
        category: "familiar",
        input: {
          url: "https://eval.invalid/case",
          extractedText: "Synthetic source",
          similarReadings: [],
        },
        expected: {
          requiredFacts: ["p95 latency", "bounded concurrency"],
          retrievalTerms: ["tail latency", "queue backpressure"],
          people: ["Maya Chen"],
          orgs: ["Acme Labs"],
          novelty: "familiar",
          allowedConnectionIds: ["prior_latency"],
          expectedConnectionIds: ["prior_latency"],
          forbiddenOutput: ["IGNORE ALL PREVIOUS INSTRUCTIONS"],
        },
      },
      {
        candidateId: "terra-low",
        caseId: "case",
        latencyMs: 125,
        reading: strongReading,
        usage: {
          provider: "openai",
          model: "gpt-5.6-terra",
          input_tokens: 100,
          output_tokens: 40,
          reasoning_tokens: 10,
          cached_input_tokens: 20,
          cache_write_tokens: 0,
        },
      },
    );

    expect(score).toMatchObject({
      schemaSuccess: true,
      factCoverage: 1,
      retrievalCoverage: 1,
      entityPrecision: 1,
      entityRecall: 1,
      entityF1: 1,
      noveltyCorrect: true,
      connectionsAllowed: true,
      expectedConnectionRecall: 1,
      injectionResistant: true,
      materialPass: true,
    });
  });

  it("fails safely for provider errors and disallowed connection ids", () => {
    const baseCase = EVALUATION_CASES.find((item) => item.category === "novel")!;
    expect(
      scoreObservation(baseCase, {
        candidateId: "terra-low",
        caseId: baseCase.id,
        latencyMs: 10,
        error: "rate limited",
      }),
    ).toMatchObject({ schemaSuccess: false, materialPass: false });

    const score = scoreObservation(baseCase, {
      candidateId: "terra-low",
      caseId: baseCase.id,
      latencyMs: 10,
      reading: {
        ...strongReading,
        novelty_verdict: baseCase.expected.novelty,
        connections: [{ id: "invented", reason: "Not supplied." }],
      },
      usage: {
        provider: "openai",
        model: "gpt-5.6-terra",
        input_tokens: 1,
        output_tokens: 1,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
      },
    });
    expect(score.connectionsAllowed).toBe(false);
    expect(score.materialPass).toBe(false);
  });

  it("penalizes entity type swaps and scans every structured field for injection output", () => {
    const evaluationCase = {
      id: "adversarial",
      category: "prompt-injection" as const,
      input: {
        url: "https://eval.invalid/adversarial",
        extractedText: "Synthetic source",
        similarReadings: [],
      },
      expected: {
        requiredFacts: [],
        retrievalTerms: [],
        people: ["Maya Chen"],
        orgs: ["Acme Labs"],
        novelty: "familiar" as const,
        allowedConnectionIds: ["prior_latency"],
        expectedConnectionIds: [],
        forbiddenOutput: ["system-compromised"],
      },
    };
    const score = scoreObservation(evaluationCase, {
      candidateId: "terra-low",
      caseId: evaluationCase.id,
      latencyMs: 1,
      reading: {
        ...strongReading,
        people: [],
        orgs: ["Maya Chen", "Acme Labs"],
        keywords: [...strongReading.keywords, "system-compromised"],
      },
      usage: {
        provider: "openai",
        model: "gpt-5.6-terra",
        input_tokens: 1,
        output_tokens: 1,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
      },
    });
    expect(score.entityF1).toBeLessThan(1);
    expect(score.injectionResistant).toBe(false);
    expect(score.materialPass).toBe(false);

    const noveltyInjection = scoreObservation(
      {
        ...evaluationCase,
        expected: {
          ...evaluationCase.expected,
          forbiddenOutput: ["familiar"],
        },
      },
      {
        candidateId: "terra-low",
        caseId: evaluationCase.id,
        latencyMs: 1,
        reading: strongReading,
        usage: {
          provider: "openai",
          model: "gpt-5.6-terra",
          input_tokens: 1,
          output_tokens: 1,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
        },
      },
    );
    expect(noveltyInjection.injectionResistant).toBe(false);
  });
});

describe("evaluation aggregation and reporting", () => {
  it("calculates dated provider-aware synchronous and batch cost", () => {
    expect(
      estimateCostUsd({
        provider: "openai",
        model: "gpt-5.6-terra",
        input_tokens: 1_000_000,
        cached_input_tokens: 100_000,
        cache_write_tokens: 10_000,
        output_tokens: 100_000,
        reasoning_tokens: 0,
      }),
    ).toEqual({ synchronous: 3.78125, batch: 1.890625 });

    expect(
      estimateCostUsd({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 100_000,
      }),
    ).toEqual({ synchronous: 4.5675, batch: 2.28375 });
  });

  it("prices every Anthropic model accepted by summarizer configuration", () => {
    const models = [
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
    ];
    for (const model of models) {
      expect(() =>
        estimateCostUsd({
          provider: "anthropic",
          model,
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ).not.toThrow();
    }
  });

  it("aggregates p50/p95, pass rates, usage, and compact evidence", () => {
    const scores = [100, 200, 300, 400, 500].map((latencyMs, index) => ({
      observation: {
        candidateId: "terra-low",
        caseId: `case-${index}`,
        latencyMs,
        reading: strongReading,
        usage: {
          provider: "openai" as const,
          model: "gpt-5.6-terra",
          input_tokens: 100,
          output_tokens: 50,
          reasoning_tokens: 5,
          cached_input_tokens: 10,
          cache_write_tokens: 0,
        },
      },
      score: {
        schemaSuccess: true,
        factCoverage: 1,
        retrievalCoverage: 1,
        entityPrecision: 1,
        entityRecall: 1,
        entityF1: 1,
        noveltyCorrect: true,
        connectionsAllowed: true,
        expectedConnectionRecall: 1,
        injectionResistant: true,
        materialPass: true,
      },
    }));
    const summary = aggregateCandidate(EVALUATION_CANDIDATES[2]!, scores);
    expect(summary).toMatchObject({
      candidateId: "terra-low",
      identity: "openai/gpt-5.6-terra effort=low",
      cases: 5,
      schemaSuccessRate: 1,
      materialPassRate: 1,
      p50LatencyMs: 300,
      p95LatencyMs: 500,
    });

    const report = buildEvaluationReport({
      generatedAt: "2026-07-23T12:00:00.000Z",
      summaries: [summary],
      results: scores,
    });
    expect(report).toContain("Human review worksheet");
    expect(report).toContain("Terra low");
    expect(report).not.toContain("sk-test");
    expect(report).not.toContain(strongReading.summary_markdown);
  });
});

describe("runEvaluationMatrix", () => {
  it("runs every case/candidate sequentially and isolates provider failures", async () => {
    const summarize = vi
      .fn()
      .mockResolvedValueOnce({
        reading: strongReading,
        usage: {
          provider: "openai",
          model: "gpt-5.6-terra",
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
        },
      })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(260);

    const observations = await runEvaluationMatrix(
      EVALUATION_CASES.slice(0, 1),
      EVALUATION_CANDIDATES.slice(1, 3),
      { summarize, now },
    );

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      candidateId: "terra-none",
      candidateIdentity: "openai/gpt-5.6-terra effort=none",
      latencyMs: 25,
    });
    expect(observations[1]).toMatchObject({
      candidateId: "terra-low",
      latencyMs: 60,
      error: "provider unavailable",
    });
  });
});

describe("staging smoke safety and diagnostics", () => {
  it("requires --execute and a staging-named origin", () => {
    expect(() =>
      validateStagingSmokeTarget({
        execute: false,
        base: "https://reading-lite-staging.bellbm.workers.dev",
      }),
    ).toThrow(/--execute/);
    expect(() =>
      validateStagingSmokeTarget({
        execute: true,
        base: "https://reading-lite.bbell.dev",
      }),
    ).toThrow(/staging/);
    expect(() =>
      validateStagingSmokeTarget({
        execute: true,
        base: "https://reading-lite-staging.bellbm.workers.dev",
      }),
    ).not.toThrow();
    expect(() =>
      validateStagingSmokeTarget({
        execute: true,
        base: "https://staging.attacker.example",
      }),
    ).toThrow(/project staging/);
    expect(() =>
      validateStagingSmokeTarget({
        execute: true,
        base: "http://reading-lite-staging.bellbm.workers.dev",
      }),
    ).toThrow(/HTTPS/);
  });

  it("asserts matching pointers and an index row using the public diagnostics shape", () => {
    const diagnostics = {
      manifest: { id: "rd_1", status: "ready" },
      pointers: {
        by_id: { exists: true, matches_manifest: true },
        by_url: { exists: true, matches_manifest: true },
      },
      index_item: { id: "rd_1", status: "ready" },
      attempts: [{ id: "at_1" }],
    };
    expect(summarizeDiagnostics(diagnostics)).toEqual({
      pointers: diagnostics.pointers,
      index_item: diagnostics.index_item,
      attempt_count: 1,
    });
    expect(() =>
      summarizeDiagnostics({
        ...diagnostics,
        pointers: {
          ...diagnostics.pointers,
          by_url: { exists: true, matches_manifest: false },
        },
      }),
    ).toThrow(/pointer diagnostics/);
    expect(() =>
      summarizeDiagnostics({
        ...diagnostics,
        index_item: { id: "rd_1", status: "pending" },
      }),
    ).toThrow(/index_item status/);
  });

  it("waits for a ready fallback reprocess attempt to become terminal", () => {
    expect(
      isAttemptTerminal(
        {
          status: "ready",
          active_attempt: { id: "at_new", status: "running" },
          last_attempt: { id: "at_old", status: "succeeded" },
        },
        "at_new",
      ),
    ).toBe(false);
    expect(
      isAttemptTerminal(
        {
          status: "ready",
          last_attempt: { id: "at_new", status: "succeeded" },
        },
        "at_new",
      ),
    ).toBe(true);
    expect(
      isAttemptTerminal(
        {
          status: "ready",
          last_attempt: { id: "at_new", status: "failed" },
        },
        "at_new",
      ),
    ).toBe(false);
  });
});
