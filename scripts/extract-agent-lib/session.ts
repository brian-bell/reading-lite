// One run, from the outside: run the agent, write the evidence, then ping.
//
// `runAgent` orchestrates rows; `runSession` orchestrates a run. Keeping them
// apart is what lets the orchestrator stay a plan→act core with injected deps
// while the run-level concerns (durable report, dead-man ping, and — in the
// next slice — the lockfile) live somewhere fs fixtures are already the norm.
//
// Order matters and is asserted: report first, ping last. The ping means "this
// agent ran to completion", so it must not fire before the evidence for that
// claim is on disk, and it must not fire at all when the evidence could not be
// written. Per-row errors are the steady state of this agent and still count as
// completion — a run that imported nothing but scanned everything is healthy.
//
// Only an --execute run pings: otherwise an operator's manual dry run would
// silently satisfy the dead-man window and hide a dead timer.
//
// Release runs through a `finally` even though there is nothing to release yet,
// so the lockfile slice adds a lock without restructuring these error paths.

import { appendRunLine, buildRunLine, pingHealthcheck, type RunStatus } from "./report";
import { runAgent, type RunArgs, type RunDeps, type RunSummary } from "./run";

export interface SessionDeps extends RunDeps {
  fetch: typeof fetch;
  runId: string;
  host: string;
  pid: number;
  warn: (message: string) => void;
}

export interface SessionResult {
  status: RunStatus;
  exitCode: number;
  summary?: RunSummary;
}

export async function runSession(args: RunArgs, deps: SessionDeps): Promise<SessionResult> {
  const { config } = deps;
  const startedAt = deps.now();
  let status: RunStatus = "ok";
  let summary: RunSummary | undefined;
  let error: unknown;

  try {
    try {
      summary = await runAgent(args, deps);
    } catch (e) {
      status = "crashed";
      error = e;
      // Say it on stderr immediately: the run report may itself fail to write,
      // and an operator watching a manual run must not have to go read a JSONL
      // file to learn that their token was rejected.
      deps.warn(`extract-agent: ${e instanceof Error ? e.message : String(e)}`);
    }

    const line = buildRunLine({
      status,
      args,
      config,
      summary,
      error,
      startedAt,
      finishedAt: deps.now(),
      runId: deps.runId,
      host: deps.host,
      pid: deps.pid,
    });

    try {
      await appendRunLine(config.runLogPath, line, { maxBytes: config.runLogMaxBytes });
    } catch (e) {
      // The corpus work may well have succeeded, but a paid-action run with no
      // evidence is exactly what the dead-man ping exists to catch: stay silent
      // and let the window expire rather than claim a run we can't show.
      deps.warn(
        `extract-agent: failed to write the run report to ${config.runLogPath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { status, exitCode: 1, summary };
    }

    if (args.execute) {
      const url = status === "ok" ? config.healthcheckUrl : config.healthcheckFailUrl;
      await pingHealthcheck(url, { fetch: deps.fetch, warn: deps.warn });
    }
    return { status, exitCode: status === "crashed" ? 1 : 0, summary };
  } finally {
    // The lockfile slice releases here.
  }
}
