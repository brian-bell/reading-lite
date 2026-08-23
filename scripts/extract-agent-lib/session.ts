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
// A run takes the execution lock first and releases it before it reports
// completion, so an overlapping run reports `already_running` and touches no
// corpus state rather than double-submitting paid work. Releasing is part of
// completion, so a release failure is recorded and pings the failure healthcheck
// instead of letting a stranded lock masquerade as a healthy run. Dry runs never
// take that lock — they have no side effects worth serializing against — but
// every run takes a separate, short-lived report lock around rotate+append. That
// keeps the shared JSONL bounded without making a dry run block an execute run's
// corpus work.

import { acquireLock, readLockHolder, type AcquireResult, type LockFile } from "./lock";
import {
  appendRunLine,
  appendRunLineCorrection,
  buildRunLine,
  pingHealthcheck,
  type RunStatus,
} from "./report";
import { runAgent, type RunArgs, type RunDeps, type RunSummary } from "./run";

export interface SessionDeps extends RunDeps {
  fetch: typeof fetch;
  runId: string;
  host: string;
  pid: number;
  bootId?: string;
  isProcessAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  writeRunLine: typeof appendRunLine;
  warn: (message: string) => void;
  // When false, the whole report-lock + run-log block is skipped: no lock
  // file, no directory creation, no append, no correction. The plan-first
  // operator CLI sets this for mode-less runs, whose contract is that a plan
  // persists nothing (and cannot fail on an unwritable run-log path).
  // Default true — timer-driven and execute runs always report.
  persistReport?: boolean;
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
  let lockReleased = false;
  let reportLock: AcquireResult = { acquired: false };
  let reportLockReleased = false;
  const makeLine = () => buildRunLine({
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
    if (args.execute) {
      try {
        lock = await acquireLock(config.lockPath, lockDeps(deps));
      } catch (e) {
        // An unusable lock path (bad mount, wrong owner, a failed reclaim) is a
        // crashed run, not a silent exit: it has to reach the run log and the
        // failure ping like any other fatal error, rather than only stderr.
        status = "crashed";
        error = e;
        deps.warn(`extract-agent: could not acquire the run lock: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (status === "ok" && !lock.acquired) {
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

    if (status === "ok") {
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

    // Cleanup is part of completion. Do it before recording a successful run
    // or pinging its healthcheck, otherwise a failed release can strand the
    // lock while monitoring records a success.
    if (lock.acquired) {
      try {
        await lock.release();
        lockReleased = true;
      } catch (e) {
        status = "crashed";
        error = e;
        deps.warn(`extract-agent: failed to release the run lock: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // The execution lock protects paid work; this shorter lock protects the
    // shared log's rotate+append transaction. Every *reporting* writer takes
    // it, including dry runs and runs that yielded, so rotation stays bounded
    // without racing the report from a just-finished execute run. A
    // persistReport:false run (the CLI's plan mode) skips the whole block —
    // no lock file, no append — because a plan must leave nothing behind.
    if (deps.persistReport !== false) {
      try {
        reportLock = await acquireReportLock(deps);
      } catch (e) {
        deps.warn(
          `extract-agent: failed to lock the run report at ${config.runLogPath}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return { status, exitCode: 1, summary };
      }

      const line = makeLine();

      try {
        await deps.writeRunLine(config.runLogPath, line, { maxBytes: config.runLogMaxBytes });
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

      if (reportLock.acquired) {
        try {
          await reportLock.release();
          reportLockReleased = true;
        } catch (e) {
          // The first line was serialized correctly, but cleanup is now the
          // terminal failure. Record a correction with one atomic append (an
          // unlocked rotation would recreate the race this lock exists to stop),
          // then route the execute run through failure monitoring.
          reportLockReleased = true;
          status = "crashed";
          error = e;
          deps.warn(`extract-agent: failed to release the report lock: ${e instanceof Error ? e.message : String(e)}`);
          try {
            await appendRunLineCorrection(config.runLogPath, makeLine(), { maxBytes: config.runLogMaxBytes });
          } catch (correctionError) {
            deps.warn(
              `extract-agent: failed to correct the run report at ${config.runLogPath}: ${
                correctionError instanceof Error ? correctionError.message : String(correctionError)
              }`,
            );
            return { status, exitCode: 1, summary };
          }
        }
      }
    }

    // already_running is not a run: it pings neither url. The holder is the run
    // that gets to satisfy (or miss) the dead-man window.
    if (args.execute && status !== "already_running") {
      const url = status === "ok" ? config.healthcheckUrl : config.healthcheckFailUrl;
      await pingHealthcheck(url, { fetch: deps.fetch, warn: deps.warn });
    }
    return { status, exitCode: status === "crashed" ? 1 : 0, summary };
  } finally {
    if (reportLock.acquired && !reportLockReleased) {
      try {
        await reportLock.release();
      } catch (e) {
        deps.warn(`extract-agent: failed to release the report lock: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // All normal paths release above so release errors can be reported and
    // pinged as failures. This only protects exceptional paths before then.
    if (lock.acquired && !lockReleased) {
      try {
        await lock.release();
      } catch (e) {
        deps.warn(`extract-agent: failed to release the run lock: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

const REPORT_LOCK_ATTEMPTS = 100;
const REPORT_LOCK_RETRY_MS = 50;
const REPORT_LOCK_MAX_AGE_SECONDS = 30;

async function acquireReportLock(deps: SessionDeps): Promise<AcquireResult & { acquired: true }> {
  const path = `${deps.config.runLogPath}.lock`;
  for (let attempt = 0; attempt < REPORT_LOCK_ATTEMPTS; attempt += 1) {
    const lock = await acquireLock(path, {
      ...lockDeps(deps),
      runId: `${deps.runId}_report`,
      maxAgeSeconds: REPORT_LOCK_MAX_AGE_SECONDS,
      liveMaxAgeSeconds: REPORT_LOCK_MAX_AGE_SECONDS,
    });
    if (lock.acquired) return lock;
    await deps.sleep(REPORT_LOCK_RETRY_MS);
  }
  throw new Error(`timed out waiting for the report lock at ${path}`);
}

function lockDeps(deps: SessionDeps) {
  return {
    now: deps.now,
    pid: deps.pid,
    host: deps.host,
    runId: deps.runId,
    bootId: deps.bootId,
    isProcessAlive: deps.isProcessAlive,
    maxAgeSeconds: deps.config.lockMaxAgeSeconds,
    warn: deps.warn,
  };
}
