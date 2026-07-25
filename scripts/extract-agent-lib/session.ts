// One run, from the outside: run the agent, write the evidence, then ping.
//
// `runAgent` orchestrates rows; `runSession` orchestrates a run. Keeping them
// apart is what lets the orchestrator stay a plan→act core with injected deps
// while the run-level concerns (lockfile, durable report, dead-man ping) live
// somewhere fs fixtures are already the norm.
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
// A run takes the lockfile first and releases it in a `finally`, so an
// overlapping run reports `already_running` and touches nothing rather than
// double-submitting paid work. The ping stays *inside* the lock so it is
// literally the last statement of a successful run, and a hung ping can't
// overlap the next run's work. Dry runs never take the lock — they have no side
// effects worth serializing against, and an operator's dry run over a large
// corpus must not make the timer skip its cycle — but they do peek at it, so a
// plan that looks odd next to an in-flight execute run explains itself.

import { acquireLock, readLockHolder, type AcquireResult, type LockFile } from "./lock";
import { appendRunLine, buildRunLine, pingHealthcheck, type RunStatus } from "./report";
import { runAgent, type RunArgs, type RunDeps, type RunSummary } from "./run";

export interface SessionDeps extends RunDeps {
  fetch: typeof fetch;
  runId: string;
  host: string;
  pid: number;
  uptimeSeconds: () => number;
  isProcessAlive: (pid: number) => boolean;
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
  let holder: LockFile | undefined;

  let lock: AcquireResult = { acquired: false };
  if (args.execute) {
    lock = await acquireLock(config.lockPath, lockDeps(deps));
    if (!lock.acquired) {
      // An overlapping run is the lock working, not a failure: report it, exit
      // 0, and let the next timer tick pick the rows up.
      status = "already_running";
      holder = lock.holder;
    }
  } else {
    const inFlight = await readLockHolder(config.lockPath);
    if (inFlight) {
      deps.warn(
        `extract-agent: an --execute run is already in flight (run ${inFlight.run_id}, pid ${inFlight.pid} on ${inFlight.host}) — this plan may not match what it does`,
      );
    }
  }

  try {
    if (status !== "already_running") {
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
    }

    const line = buildRunLine({
      status,
      args,
      config,
      summary,
      error,
      holder,
      startedAt,
      finishedAt: deps.now(),
      runId: deps.runId,
      host: deps.host,
      pid: deps.pid,
    });

    try {
      // Only the lock holder rotates: a run that yielded is writing alongside a
      // live run, and two concurrent rotations can discard the holder's report.
      await appendRunLine(config.runLogPath, line, {
        maxBytes: config.runLogMaxBytes,
        rotate: lock.acquired,
      });
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

    // already_running is not a run: it pings neither url. The holder is the run
    // that gets to satisfy (or miss) the dead-man window.
    if (args.execute && status !== "already_running") {
      const url = status === "ok" ? config.healthcheckUrl : config.healthcheckFailUrl;
      await pingHealthcheck(url, { fetch: deps.fetch, warn: deps.warn });
    }
    return { status, exitCode: status === "crashed" ? 1 : 0, summary };
  } finally {
    if (lock.acquired) await lock.release();
  }
}

function lockDeps(deps: SessionDeps) {
  return {
    now: deps.now,
    pid: deps.pid,
    host: deps.host,
    runId: deps.runId,
    uptimeSeconds: deps.uptimeSeconds,
    isProcessAlive: deps.isProcessAlive,
    maxAgeSeconds: deps.config.lockMaxAgeSeconds,
    warn: deps.warn,
  };
}
