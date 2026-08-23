import { describe, expect, it } from "vitest";
import { extractAgentCommand, type ExtractAgentDeps } from "../../../scripts/ops-lib/commands/extract-agent";
import { extractProbeCommand, type ExtractProbeDeps } from "../../../scripts/ops-lib/commands/extract-probe";
import { evalSummarizerCommand, type EvalSummarizerDeps } from "../../../scripts/ops-lib/commands/eval-summarizer";
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
  function makeDeps() {
    const { io: cio, out } = io();
    const executions: { cases: number; candidates: number; outputDir: string }[] = [];
    const deps: EvalSummarizerDeps = {
      io: cio,
      executeMatrix: async (cases, candidates, outputDir) => {
        executions.push({ cases: cases.length, candidates: candidates.length, outputDir });
      },
    };
    return { deps, out, executions };
  }

  it("plan mode prints the matrix without any provider call or write", async () => {
    const { deps, out, executions } = makeDeps();
    const code = await evalSummarizerCommand.run([], deps);
    expect(code).toBe(0);
    expect(executions).toHaveLength(0);
    const text = out.join("\n");
    expect(text).toContain("[PLAN]");
    expect(text).toContain("provider calls");
  });

  it("--execute runs the paid matrix", async () => {
    const { deps, executions } = makeDeps();
    const code = await evalSummarizerCommand.run(["--execute", "--output-dir", "out"], deps);
    expect(code).toBe(0);
    expect(executions).toEqual([expect.objectContaining({ outputDir: "out" })]);
    expect(executions[0].cases).toBeGreaterThan(0);
  });

  it("rejects an unknown candidate id as a usage error", async () => {
    const { deps, executions } = makeDeps();
    await expect(evalSummarizerCommand.run(["--candidate", "nope"], deps)).rejects.toThrow(UsageError);
    expect(executions).toHaveLength(0);
  });
});
