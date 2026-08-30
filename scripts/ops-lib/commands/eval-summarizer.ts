// `ops eval summarizer` — run the fixed, non-secret reading-lite summarizer
// quality matrix. Plan-first: a mode-less run prints the candidate × case
// matrix without any provider call or report write; --execute makes paid
// provider calls and writes results.json + report.md to --output-dir.
// Credentials resolve from process env, .prd.vars, then .dev.vars; outputs
// never include credential values. There is no provider fallback.

import { parseArgs } from "node:util";
import {
  EVALUATION_CANDIDATES,
  EVALUATION_CASES,
  evaluationCandidateIdentity,
  type EvaluationCandidate,
  type EvaluationCase,
} from "../../summarizer-eval/fixtures";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import type { SummarizerDeps } from "../../../src/modules/summarizer";

export interface EvalSummarizerDeps extends BaseDeps {
  // The whole paid path: provider calls, scoring, and report writes. Only
  // reached with --execute; the default loads provider clients lazily.
  executeMatrix: (
    cases: EvaluationCase[],
    candidates: EvaluationCandidate[],
    outputDir: string,
  ) => Promise<void>;
}

interface Args {
  execute: boolean;
  outputDir: string;
  candidateIds: string[];
  caseIds: string[];
}

function parseEvalArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        execute: { type: "boolean", default: false },
        "output-dir": { type: "string", default: ".summarizer-eval" },
        candidate: { type: "string", multiple: true, default: [] },
        case: { type: "string", multiple: true, default: [] },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  return {
    execute: values.execute === true,
    outputDir: values["output-dir"]!,
    candidateIds: values.candidate,
    caseIds: values.case,
  };
}

function selectById<T extends { id: string }>(all: T[], selected: string[], label: string): T[] {
  if (selected.length === 0) return all;
  const requested = new Set(selected);
  const unknown = [...requested].filter((id) => !all.some((item) => item.id === id));
  if (unknown.length > 0) {
    throw new UsageError(`unknown ${label}: ${unknown.join(", ")}`);
  }
  return all.filter((item) => requested.has(item.id));
}

export function summarizerDepsForEvaluationCandidate(
  candidate: EvaluationCandidate,
  creds: {
    fetch: typeof fetch;
    openaiApiKey: string;
    anthropicApiKey?: string;
    fallbackAnthropicModel: string;
  },
): SummarizerDeps {
  if (candidate.provider === "openai") {
    return {
      fetch: creds.fetch,
      provider: "openai",
      openaiApiKey: creds.openaiApiKey,
      openaiModel: candidate.model,
      openaiReasoningEffort: candidate.reasoningEffort,
      anthropicApiKey: creds.anthropicApiKey,
      anthropicModel: creds.fallbackAnthropicModel,
    };
  }
  if (!creds.anthropicApiKey) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  if (candidate.anthropicEffort && candidate.anthropicEffort !== "none") {
    throw new Error(
      `Anthropic summarization effort "${candidate.anthropicEffort}" is not supported on this branch: ` +
        `the Worker summarizeReading() Anthropic path has no effort field.`,
    );
  }
  return {
    fetch: creds.fetch,
    provider: "anthropic",
    openaiApiKey: creds.openaiApiKey,
    anthropicApiKey: creds.anthropicApiKey,
    anthropicModel: candidate.model,
  };
}

async function runEvalSummarizer(argv: string[], deps: EvalSummarizerDeps): Promise<number> {
  const args = parseEvalArgs(argv);
  const candidates = selectById(EVALUATION_CANDIDATES, args.candidateIds, "candidate");
  const cases = selectById(EVALUATION_CASES, args.caseIds, "case");
  deps.io.stdout(
    `${args.execute ? "[EXECUTE]" : "[PLAN]"} ${candidates.length} candidates × ${cases.length} cases = ${candidates.length * cases.length} provider calls`,
  );
  for (const candidate of candidates) {
    deps.io.stdout(`  ${candidate.id}: ${evaluationCandidateIdentity(candidate)}`);
  }
  if (!args.execute) {
    deps.io.stdout("Pass --execute to run paid provider calls and write the report.");
    return 0;
  }
  await deps.executeMatrix(cases, candidates, args.outputDir);
  return 0;
}

export const evalSummarizerCommand: CommandDefinition<EvalSummarizerDeps> = {
  group: "eval",
  name: "summarizer",
  summary: "Run the summarizer quality matrix across providers and effort levels",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- eval summarizer [options]

Runs the fixed, non-secret reading-lite summarizer quality matrix. Plans by
default; --execute makes paid provider calls and writes results.json +
report.md.

Options:
  --candidate <id>        Restrict to a candidate; repeatable.
  --case <id>             Restrict to a case; repeatable.
  --output-dir <path>     Generated raw JSON and Markdown report directory.
                          Default: .summarizer-eval (gitignored).
  --execute               Call the configured Anthropic and OpenAI APIs.
  --help                  Show this message.

Candidates: ${EVALUATION_CANDIDATES.map((item) => item.id).join(", ")}
Cases: ${EVALUATION_CASES.map((item) => item.id).join(", ")}

Credentials resolve from process env, .prd.vars, then .dev.vars. Outputs never
include credential values. There is no provider fallback.`,
  defaultDeps: (io: CommandIo): EvalSummarizerDeps => ({
    io,
    executeMatrix: async (cases, candidates, outputDir) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const { summarizeReading } = await import("../../../src/modules/summarizer");
      const { loadDotVars } = await import("../../lib/dotvars");
      const { runEvaluationMatrix } = await import("../../summarizer-eval/run");
      const { aggregateCandidate, buildEvaluationReport, scoreObservation } =
        await import("../../summarizer-eval/scoring");

      const vars = {
        ...loadDotVars(".dev.vars"),
        ...loadDotVars(".prd.vars"),
        ...process.env,
      };
      if (!vars.OPENAI_API_KEY) {
        throw new Error("missing OPENAI_API_KEY");
      }
      if (
        candidates.some((candidate) => candidate.provider === "anthropic") &&
        !vars.ANTHROPIC_API_KEY
      ) {
        throw new Error("missing ANTHROPIC_API_KEY");
      }

      const observations = await runEvaluationMatrix(cases, candidates, {
        now: () => Date.now(),
        summarize: (evaluationCase, candidate) =>
          summarizeReading(
            evaluationCase.input,
            summarizerDepsForEvaluationCandidate(candidate, {
              fetch: globalThis.fetch,
              openaiApiKey: vars.OPENAI_API_KEY!,
              anthropicApiKey: vars.ANTHROPIC_API_KEY,
              fallbackAnthropicModel: vars.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
            }),
          ),
        onProgress: (observation) => {
          const status = observation.error ? `ERROR ${observation.error}` : "ok";
          io.stderr(
            `${observation.candidateId}/${observation.caseId}: ${status} (${observation.latencyMs} ms)`,
          );
        },
      });

      const caseById = new Map(cases.map((item) => [item.id, item]));
      const scored = observations.map((observation) => ({
        observation,
        score: scoreObservation(caseById.get(observation.caseId)!, observation),
      }));
      const summaries = candidates.map((candidate) =>
        aggregateCandidate(
          candidate,
          scored.filter((item) => item.observation.candidateId === candidate.id),
        ),
      );
      const generatedAt = new Date().toISOString();
      const absoluteOutputDir = resolve(outputDir);
      await mkdir(absoluteOutputDir, { recursive: true });
      await Promise.all([
        writeFile(
          resolve(absoluteOutputDir, "results.json"),
          JSON.stringify(
            { generatedAt, candidates, summaries, results: scored },
            null,
            2,
          ) + "\n",
          "utf8",
        ),
        writeFile(
          resolve(absoluteOutputDir, "report.md"),
          buildEvaluationReport({ generatedAt, summaries, results: scored }),
          "utf8",
        ),
      ]);
      io.stdout(`Wrote ${observations.length} observations to ${absoluteOutputDir}`);
    },
  }),
  run: runEvalSummarizer,
};
