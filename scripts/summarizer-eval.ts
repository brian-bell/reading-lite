#!/usr/bin/env -S npx tsx
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { summarizeReading } from "../src/modules/summarizer";
import { loadDotVars } from "./lib/dotvars";
import {
  EVALUATION_CANDIDATES,
  EVALUATION_CASES,
  type EvaluationCandidate,
  type EvaluationCase,
} from "./summarizer-eval/fixtures";
import { runEvaluationMatrix } from "./summarizer-eval/run";
import {
  aggregateCandidate,
  buildEvaluationReport,
  scoreObservation,
} from "./summarizer-eval/scoring";

interface Args {
  execute: boolean;
  outputDir: string;
  candidateIds: string[];
  caseIds: string[];
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      "output-dir": { type: "string", default: ".summarizer-eval" },
      candidate: { type: "string", multiple: true, default: [] },
      case: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  return {
    execute: values.execute === true,
    outputDir: values["output-dir"]!,
    candidateIds: values.candidate,
    caseIds: values.case,
  };
}

function printUsage(): void {
  process.stdout.write(`Usage: npm run summarizer-eval -- [options]

Runs the fixed, non-secret reading-lite summarizer quality matrix. Dry-run by
default; --execute makes paid provider calls.

  --execute               Call the configured Anthropic and OpenAI APIs.
  --candidate <id>        Restrict to a candidate; repeatable.
  --case <id>             Restrict to a case; repeatable.
  --output-dir <path>     Generated raw JSON and Markdown report directory.
                          Default: .summarizer-eval (gitignored).
  --help                  Show this message.

Candidates: ${EVALUATION_CANDIDATES.map((item) => item.id).join(", ")}
Cases: ${EVALUATION_CASES.map((item) => item.id).join(", ")}

Credentials resolve from process env, .prd.vars, then .dev.vars. Outputs never
include credential values. There is no provider fallback.
`);
}

function selectById<T extends { id: string }>(
  all: T[],
  selected: string[],
  label: string,
): T[] {
  if (selected.length === 0) return all;
  const requested = new Set(selected);
  const unknown = [...requested].filter(
    (id) => !all.some((item) => item.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown ${label}: ${unknown.join(", ")}`);
  }
  return all.filter((item) => requested.has(item.id));
}

function loadCredentials(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...process.env,
  };
}

async function execute(
  cases: EvaluationCase[],
  candidates: EvaluationCandidate[],
  outputDir: string,
): Promise<void> {
  const vars = loadCredentials();
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
      summarizeReading(evaluationCase.input, {
        fetch: globalThis.fetch,
        provider: candidate.provider,
        openaiApiKey: vars.OPENAI_API_KEY!,
        openaiModel:
          candidate.provider === "openai" ? candidate.model : undefined,
        openaiReasoningEffort: candidate.reasoningEffort,
        anthropicApiKey: vars.ANTHROPIC_API_KEY,
        anthropicModel:
          candidate.provider === "anthropic"
            ? candidate.model
            : (vars.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"),
      }),
    onProgress: (observation) => {
      const status = observation.error ? `ERROR ${observation.error}` : "ok";
      process.stderr.write(
        `${observation.candidateId}/${observation.caseId}: ${status} (${observation.latencyMs} ms)\n`,
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
      scored.filter(
        (item) => item.observation.candidateId === candidate.id,
      ),
    ),
  );
  const generatedAt = new Date().toISOString();
  const absoluteOutputDir = resolve(outputDir);
  await mkdir(absoluteOutputDir, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(absoluteOutputDir, "results.json"),
      JSON.stringify({ generatedAt, summaries, results: scored }, null, 2) +
        "\n",
      "utf8",
    ),
    writeFile(
      resolve(absoluteOutputDir, "report.md"),
      buildEvaluationReport({ generatedAt, summaries, results: scored }),
      "utf8",
    ),
  ]);
  process.stdout.write(
    `Wrote ${observations.length} observations to ${absoluteOutputDir}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const candidates = selectById(
    EVALUATION_CANDIDATES,
    args.candidateIds,
    "candidate",
  );
  const cases = selectById(EVALUATION_CASES, args.caseIds, "case");
  process.stdout.write(
    `${args.execute ? "[EXECUTE]" : "[DRY RUN]"} ${candidates.length} candidates × ${cases.length} cases = ${candidates.length * cases.length} provider calls\n`,
  );
  for (const candidate of candidates) {
    process.stdout.write(
      `  ${candidate.id}: ${candidate.provider}/${candidate.model}${candidate.reasoningEffort ? ` effort=${candidate.reasoningEffort}` : ""}\n`,
    );
  }
  if (!args.execute) {
    process.stdout.write("Pass --execute to run paid provider calls.\n");
    return;
  }
  await execute(cases, candidates, args.outputDir);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
