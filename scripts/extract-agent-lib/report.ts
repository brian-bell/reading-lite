// Run report: one JSON line per run, appended to a size-rotated JSONL log.
//
// The log is the only durable evidence a timer-driven run leaves behind, so the
// line has to be readable a week later with `jq` and small enough to keep every
// run: `rows` is therefore filtered (below) while `counts` stays complete, and
// the line carries the corpus it touched (`api_base`) but never the token.
//
// The dead-man ping is the one piece of agent egress that deliberately does NOT
// go through safeFetch. That guard exists because corpus URLs are attacker-
// shaped input; the healthcheck URL is operator config, and a home-box operator
// plausibly points it at a LAN Uptime Kuma — exactly the private-range target
// safeFetch refuses. Plain injected fetch with a short timeout instead.
//
// Appends are single-`write` and O_APPEND, so concurrent runs (a lock loser
// reporting `already_running` alongside the holder's own line) interleave
// safely. Rotation is the one racy part and is best-effort: whoever loses the
// rename just appends to the fresh file. The worst case is an older rotated log
// being replaced early, which costs history, not a run.
//
// A failed write is not swallowed — the caller fails the run on it. The corpus
// work may have succeeded, but a paid-action run with no evidence is exactly
// what the dead-man ping exists to catch; a false-positive page beats silent
// evidence loss.

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentConfig } from "./config";
import type { LockFile } from "./lock";
import type { PerRowOutcome, RunArgs, RunSummary } from "./run";

export type RunStatus = "ok" | "crashed" | "already_running";

const ERROR_MESSAGE_MAX = 500;
// Rotation only bounds the file between lines, so the line itself has to be
// bounded by construction — a corpus with thousands of manual-route or
// backed-off rows would otherwise serialize one multi-megabyte line and blow
// past AGENT_RUN_LOG_MAX_BYTES in a single append. The overflow is counted, not
// silently dropped, and `counts` stays complete either way.
const ROWS_PER_LINE_MAX = 200;
const URL_MAX = 500;
const WHY_MAX = 200;
const DETAIL_MAX = 300;

export interface RunLine {
  v: 1;
  run_id: string;
  status: RunStatus;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  host: string;
  pid: number;
  api_base: string;
  args: RunArgs;
  caps: { max_paid_actions: number; max_attempts: number };
  counts?: Record<string, number>;
  rows?: PerRowOutcome[];
  rows_omitted?: number;
  error?: { name: string; message: string };
  lock?: { run_id: string; pid: number; host: string; started_at: string };
}

export interface BuildRunLineInput {
  status: RunStatus;
  args: RunArgs;
  config: AgentConfig;
  summary?: RunSummary;
  error?: unknown;
  holder?: LockFile;
  startedAt: Date;
  finishedAt: Date;
  runId: string;
  host: string;
  pid: number;
}

export function buildRunLine(input: BuildRunLineInput): RunLine {
  const { config, summary } = input;
  const line: RunLine = {
    v: 1,
    run_id: input.runId,
    status: input.status,
    dry_run: summary?.dry_run ?? !input.args.execute,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    duration_ms: input.finishedAt.getTime() - input.startedAt.getTime(),
    host: input.host,
    pid: input.pid,
    api_base: config.api.base,
    args: { ...input.args },
    caps: { max_paid_actions: config.maxPaidActions, max_attempts: config.maxAttempts },
  };
  if (summary) {
    // Derived from the summary's own numeric fields rather than a hand-written
    // list, so a counter added in a later phase shows up in the log the day it
    // exists.
    line.counts = Object.fromEntries(
      Object.entries(summary).filter(([, value]) => typeof value === "number"),
    ) as Record<string, number>;
    const reportable = summary.rows.filter(isReportable);
    line.rows = reportable.slice(0, ROWS_PER_LINE_MAX).map(clampRow);
    if (reportable.length > ROWS_PER_LINE_MAX) line.rows_omitted = reportable.length - ROWS_PER_LINE_MAX;
  }
  if (input.status === "crashed") line.error = describeError(input.error);
  // Who we yielded to: enough to tell an operator which process to look at (or
  // which stale file to clear) without opening the lock file themselves.
  if (input.holder) {
    line.lock = {
      run_id: input.holder.run_id,
      pid: input.holder.pid,
      host: input.holder.host,
      started_at: input.holder.started_at,
    };
  }
  return line;
}

// A dry run against the whole corpus buckets one row per reading, nearly all of
// them ineligible. Serializing those would make the log unusable and unbounded,
// so only rows that did something (every `attempt`, including planned/deferred)
// or need a human (manual, backed_off) reach the line. The counts still tell
// the whole story.
function isReportable(row: PerRowOutcome): boolean {
  return row.decision === "attempt" || row.decision === "manual" || row.decision === "backed_off";
}

// Row count alone doesn't bound the line: a reading URL has no schema maximum
// and an error `detail` is whatever an upstream said. Clamping each free-text
// field is what makes the line's worst case (~200 × ~1 KB) actually fit inside
// AGENT_RUN_LOG_MAX_BYTES, whose whole job is bounding disk growth. Long values
// stay identifiable — the prefix is the part an operator greps for.
function clampRow(row: PerRowOutcome): PerRowOutcome {
  const clamped: PerRowOutcome = { ...row, url: row.url.slice(0, URL_MAX), why: row.why.slice(0, WHY_MAX) };
  if (row.detail !== undefined) clamped.detail = row.detail.slice(0, DETAIL_MAX);
  return clamped;
}

function describeError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return { name, message: message.slice(0, ERROR_MESSAGE_MAX) };
}

export async function appendRunLine(
  path: string,
  line: RunLine,
  opts: { maxBytes: number },
): Promise<void> {
  const record = `${serializeWithinBudget(line, opts.maxBytes - 1)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(path, opts.maxBytes, Buffer.byteLength(record, "utf-8"));
  // Owner-only: the log holds every URL the agent touched, which on a shared box
  // is nobody else's business. The mode applies at creation only — a log that
  // predates this is the operator's to chmod.
  await appendFile(path, record, { encoding: "utf-8", mode: 0o600 });
}

export interface PingDeps {
  fetch: typeof fetch;
  warn: (message: string) => void;
  timeoutMs?: number;
}

const PING_TIMEOUT_MS = 10_000;

// Never throws: a healthcheck that can't be reached is a monitoring problem,
// not a run failure. The dead-man window catches a persistently missing ping on
// its own — failing the run here would only add noise.
export async function pingHealthcheck(url: string | undefined, deps: PingDeps): Promise<void> {
  if (!url) return;
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(deps.timeoutMs ?? PING_TIMEOUT_MS),
    });
    if (!res.ok) deps.warn(`healthcheck ping to ${redactPingUrl(url)} returned ${res.status}`);
  } catch (e) {
    // The exception text can quote the URL back at us verbatim ("Failed to
    // parse URL from …"), so scrub it there too — redacting only the prefix
    // would leak exactly the malformed-config case.
    const detail = (e instanceof Error ? e.message : String(e)).split(url).join("<healthcheck url>");
    deps.warn(`healthcheck ping to ${redactPingUrl(url)} failed: ${detail}`);
  }
}

// Healthchecks.io-style endpoints put an unguessable token in the path, and a
// warning goes to stderr — i.e. to journald, where it is readable by principals
// who cannot read `.extract-agent.vars`. Anyone holding the token can ping it
// themselves and mask a dead timer, so identify the endpoint by origin only.
function redactPingUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return "the configured healthcheck url";
  }
}

// Rotation bounds the file between appends; this bounds the append itself, so
// the two together actually hold the log to ~2 × maxBytes at any configured
// cap. Rows are the only elastic part of the line, so they are what gives: drop
// them (counted, never silent) until the record fits. A line whose fixed fields
// alone exceed the cap is written anyway — status and counts are the record's
// reason to exist, and an operator who set a 200-byte cap gets one small line
// per run, not a lost run.
function serializeWithinBudget(line: RunLine, maxBytes: number): string {
  let candidate = JSON.stringify(line);
  if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) return candidate;

  let kept = line.rows ?? [];
  let omitted = line.rows_omitted ?? 0;
  while (kept.length > 0) {
    const drop = Math.ceil(kept.length / 2);
    kept = kept.slice(0, kept.length - drop);
    omitted += drop;
    candidate = JSON.stringify({ ...line, rows: kept, rows_omitted: omitted });
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) return candidate;
  }
  return candidate;
}

// Two files, so the log is bounded at ~2 × maxBytes without needing logrotate.
// Rotate when the *pending* record would cross the cap, not merely when the
// file already has: checking only the current size lets a log sitting just
// under the cap accept a full-size line, so each retained file could reach ~2 ×
// maxBytes and the pair ~4 ×.
async function rotateIfNeeded(path: string, maxBytes: number, pendingBytes: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw e;
  }
  if (size + pendingBytes <= maxBytes) return;
  try {
    await rename(path, `${path}.1`);
  } catch (e) {
    // A lock loser writes its `already_running` line while the holder is still
    // running, so two processes can decide to rotate at once. Losing that race
    // means the log was already rotated — the append below lands in the fresh
    // file either way, and a run must not fail over housekeeping.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
}
