import { describe, expect, it } from "vitest";
import { BILLING_TENANT, EMBED_URL, FAIL_CLOSED_CASES, PRICED_REQUEST, spendHarness } from "../../helpers/operator-spend";
import { extractAgentCommand, type ExtractAgentDeps } from "../../../scripts/ops-lib/commands/extract-agent";
import { extractProbeCommand, type ExtractProbeDeps } from "../../../scripts/ops-lib/commands/extract-probe";
import { evalSummarizerCommand, summarizerDepsForEvaluationCandidate, type EvalSummarizerDeps } from "../../../scripts/ops-lib/commands/eval-summarizer";
import { EVALUATION_CANDIDATES, evaluationCandidateIdentity } from "../../../scripts/summarizer-eval/fixtures";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";
import type { SessionDeps } from "../../../scripts/extract-agent-lib/session";

function io(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

describe("ops extract agent", () => {
  function makeDeps() {
    const { io: cio, out } = io();
    const state = {
      builds: [] as { persist: boolean }[],
      runs: [] as { execute: boolean }[],
      persistedWrites: 0,
    };
    const deps: ExtractAgentDeps = {
      io: cio,
      buildSessionDeps: async (opts) => {
        state.builds.push(opts);
        return {
          saveState: async () => {
            state.persistedWrites++;
          },
          writeRunLine: async () => {
            state.persistedWrites++;
          },
        } as unknown as SessionDeps;
      },
      runSession: async (args) => {
        state.runs.push({ execute: args.execute });
        return {
          status: "ok" as const,
          exitCode: 0,
          summary: {
            dry_run: !args.execute, scanned: 3, eligible: 1, ineligible: 1, out_of_scope: 1,
            never: 0, manual: 0, backed_off: 0, attempted: 1, imported: args.execute ? 1 : 0,
            gate_rejected: 0, challenges: 0, dead: 0, no_article: 0, errors: 0, deferred: 0,
            rows: [
              { id: "rd_1", url: "https://a.example/x", decision: "attempt", why: "fetch blocked (403)", outcome: "planned" },
            ],
          } as never,
        };
      },
    };
    return { deps, out, state };
  }

  it("plan mode builds non-persisting session deps and prints the plan", async () => {
    const { deps, out, state } = makeDeps();
    const code = await extractAgentCommand.run([], deps);
    expect(code).toBe(0);
    expect(state.builds).toEqual([{ persist: false }]);
    expect(state.runs).toEqual([{ execute: false }]);
    const text = out.join("\n");
    expect(text).toContain("PLAN — nothing submitted");
    expect(text).toContain("rd_1");
  });

  it("--execute builds persisting session deps", async () => {
    const { deps, state } = makeDeps();
    const code = await extractAgentCommand.run(["--execute", "--limit", "5"], deps);
    expect(code).toBe(0);
    expect(state.builds).toEqual([{ persist: true }]);
    expect(state.runs).toEqual([{ execute: true }]);
  });

  it("rejects a malformed --limit before building anything", async () => {
    const { deps, state } = makeDeps();
    await expect(extractAgentCommand.run(["--limit", "zero"], deps)).rejects.toThrow(UsageError);
    expect(state.builds).toHaveLength(0);
  });

  it("propagates the session exit code", async () => {
    const { deps } = makeDeps();
    deps.runSession = async () => ({ status: "crashed" as never, exitCode: 1 });
    expect(await extractAgentCommand.run([], deps)).toBe(1);
  });
});

describe("ops extract probe", () => {
  function makeDeps() {
    const { io: cio, out } = io();
    const probes: unknown[] = [];
    const deps: ExtractProbeDeps = {
      io: cio,
      loadProbe: async () => ({
        parseProbeArgs: (argv) => {
          if (!argv.includes("--url")) throw new Error("--url or --html is required");
          return { tier: "both", json: argv.includes("--json"), url: "https://a.example/x" } as never;
        },
        runProbe: async (args) => {
          probes.push(args);
          return [
            {
              tier: "static", outcome: "article", title: "T",
              normalized_character_count: 1234, evidence_codes: [],
            } as never,
          ];
        },
      }),
    };
    return { deps, out, probes };
  }

  it("is registered read-only", () => {
    expect(extractProbeCommand.safety).toBe("read-only");
  });

  it("runs the probe and prints bounded metadata", async () => {
    const { deps, out, probes } = makeDeps();
    const code = await extractProbeCommand.run(["--url", "https://a.example/x"], deps);
    expect(code).toBe(0);
    expect(probes).toHaveLength(1);
    expect(out.join("\n")).toContain("static: article");
  });

  it("maps parser failures to usage errors", async () => {
    const { deps } = makeDeps();
    await expect(extractProbeCommand.run([], deps)).rejects.toThrow(UsageError);
  });
});

describe("ops eval summarizer", () => {
  const EXECUTE = ["--execute", "--env", "staging", "--billing-tenant", BILLING_TENANT];

  // `request`, when given, is what the stand-in matrix sends through the paid
  // transport it was handed, as the real one does for every provider call.
  function makeDeps(authority: Parameters<typeof spendHarness>[0] = "allow", request?: RequestInit) {
    const { io: cio, out } = io();
    const executions: { cases: number; candidates: number; outputDir: string }[] = [];
    const spend = spendHarness(authority);
    const deps: EvalSummarizerDeps = {
      io: cio,
      openSpend: spend.openSpend,
      fetch: spend.fetch,
      now: () => Date.now(),
      executeMatrix: async (cases, candidates, outputDir, paidFetch) => {
        executions.push({ cases: cases.length, candidates: candidates.length, outputDir });
        if (request) await paidFetch(EMBED_URL, request);
      },
    };
    return { deps, out, executions, spend };
  }

  it("plan mode prints the matrix without any provider call or write", async () => {
    const { deps, out, executions } = makeDeps();
    const code = await evalSummarizerCommand.run([], deps);
    expect(code).toBe(0);
    expect(executions).toHaveLength(0);
    const text = out.join("\n");
    expect(text).toContain("[PLAN]");
    expect(text).toContain("provider calls");
    expect(text).toContain("anthropic: anthropic/claude-sonnet-5-5 effort=low");
    expect(text).toContain("terra-low: openai/gpt-5.6-terra effort=low");
  });

  it("--execute runs the paid matrix", async () => {
    const { deps, executions } = makeDeps();
    const code = await evalSummarizerCommand.run([...EXECUTE, "--output-dir", "out"], deps);
    expect(code).toBe(0);
    expect(executions).toEqual([expect.objectContaining({ outputDir: "out" })]);
    expect(executions[0].cases).toBeGreaterThan(0);
  });

  it("plan mode opens no spend session and reaches no provider", async () => {
    const { deps, spend } = makeDeps();
    expect(await evalSummarizerCommand.run([], deps)).toBe(0);
    expect(spend.openSpend).not.toHaveBeenCalled();
    expect(spend.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [["--execute", "--env", "staging"], /requires --billing-tenant/],
    [["--execute", "--env", "staging", "--billing-tenant", "global"], /malformed --billing-tenant/],
    [["--billing-tenant", "nobody"], /malformed --billing-tenant/],
    [["--execute", "--billing-tenant", BILLING_TENANT], /--env must be staging or production/],
  ])("refuses %j before any spend session or matrix run", async (argv, message) => {
    const { deps, executions, spend } = makeDeps();
    await expect(evalSummarizerCommand.run(argv, deps)).rejects.toThrow(message);
    expect(spend.openSpend).not.toHaveBeenCalled();
    expect(executions).toHaveLength(0);
  });

  it("bills the matrix to --billing-tenant on the --env authority", async () => {
    const { deps, spend } = makeDeps("allow", PRICED_REQUEST);
    expect(await evalSummarizerCommand.run(EXECUTE, deps)).toBe(0);
    expect(spend.openSpend).toHaveBeenCalledWith("staging");
    expect(spend.calls.map((call) => call.kind)).toEqual(["reserve_spend", "mark_spend_dispatched", "settle_spend"]);
    expect(new Set(spend.calls.map((call) => call.tenantId))).toEqual(new Set([BILLING_TENANT]));
    expect(spend.fetch).toHaveBeenCalledTimes(1);
    expect(spend.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(FAIL_CLOSED_CASES)("makes no provider request after %s", async (_label, authority, request, refusal) => {
    const { deps, spend } = makeDeps(authority, request);
    await expect(evalSummarizerCommand.run(EXECUTE, deps)).rejects.toThrow(refusal);
    expect(spend.fetch).not.toHaveBeenCalled();
    expect(spend.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown candidate id as a usage error", async () => {
    const { deps, executions } = makeDeps();
    await expect(evalSummarizerCommand.run(["--candidate", "nope"], deps)).rejects.toThrow(UsageError);
    expect(executions).toHaveLength(0);
  });

  it("pins Anthropic effort on candidate identity and ignores ambient env", async () => {
    const previous = process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
    const anthropic = EVALUATION_CANDIDATES.find((item) => item.provider === "anthropic")!;
    try {
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
      const { deps, out } = makeDeps();
      await evalSummarizerCommand.run(["--candidate", "anthropic"], deps);
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "high";
      const second = makeDeps();
      await evalSummarizerCommand.run(["--candidate", "anthropic"], second.deps);
      expect(out.join("\n")).toBe(second.out.join("\n"));
      expect(out.join("\n")).toContain("anthropic/claude-sonnet-5-5 effort=low");
      expect(evaluationCandidateIdentity(anthropic)).toBe(
        "anthropic/claude-sonnet-5-5 effort=low",
      );

      const creds = {
        fetch: globalThis.fetch,
        openaiApiKey: "sk-openai",
        anthropicApiKey: "sk-ant",
        fallbackAnthropicModel: "claude-sonnet-5",
      };
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low";
      const depsLow = summarizerDepsForEvaluationCandidate(anthropic, creds);
      process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "max";
      const depsHigh = summarizerDepsForEvaluationCandidate(anthropic, creds);
      expect(depsLow).toEqual(depsHigh);
      expect(depsLow.anthropicReasoningEffort).toBe("low");
      expect(depsLow).not.toHaveProperty("anthropicEffort");
      expect(() =>
        summarizerDepsForEvaluationCandidate(
          { id: "anthropic", label: "unpinned", provider: "anthropic", model: "claude-sonnet-5" },
          creds,
        ),
      ).toThrow(/must pin anthropicEffort/);
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT;
      } else {
        process.env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = previous;
      }
    }
  });
});
