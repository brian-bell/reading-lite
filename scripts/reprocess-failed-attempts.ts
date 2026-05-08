#!/usr/bin/env -S npx tsx
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import { pollReadingTerminal } from "./reprocess-failed-lib/poll";
import {
  readRecordInput,
  retryDecisionForRecord,
  selectSingleRecord,
  type FailedAttemptRecord,
} from "./reprocess-failed-lib/records";

const DEFAULT_INPUT = ".failed-attempts";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;

interface Args {
  input: string;
  readingId: string | undefined;
  all: boolean;
  base: string;
  token: string;
  execute: boolean;
  force: boolean;
  includeNonRetryable: boolean;
  poll: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  failFast: boolean;
}

interface Result {
  id: string;
  url: string;
  attempt_id?: string;
  classification: "queued" | "ready" | "skipped" | "error" | "timeout";
  reason?: string;
  error?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      reading: { type: "string" },
      all: { type: "boolean", default: false },
      base: { type: "string" },
      token: { type: "string" },
      execute: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "include-non-retryable": { type: "boolean", default: false },
      poll: { type: "boolean", default: false },
      "poll-interval-ms": { type: "string" },
      "poll-timeout-ms": { type: "string" },
      "fail-fast": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const input = values.input ?? positionals[0] ?? DEFAULT_INPUT;
  if (values.all && values.reading) {
    console.error("pass either --all or --reading <id>, not both");
    printUsage();
    process.exit(2);
  }
  const pollIntervalMs = parsePositiveIntFlag(
    "--poll-interval-ms",
    values["poll-interval-ms"],
    DEFAULT_POLL_INTERVAL_MS,
  );
  const pollTimeoutMs = parsePositiveIntFlag(
    "--poll-timeout-ms",
    values["poll-timeout-ms"],
    DEFAULT_POLL_TIMEOUT_MS,
  );

  const devVars = loadDotVars(".dev.vars");
  const base =
    values.base ?? process.env.READER_BASE_URL ?? "http://127.0.0.1:8787";
  const token =
    values.token ?? process.env.READER_API_TOKEN ?? devVars.READER_API_TOKEN ?? "";
  if (!token) {
    console.error(
      "missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars.",
    );
    process.exit(2);
  }

  return {
    input,
    readingId: values.reading,
    all: values.all === true,
    base: base.replace(/\/+$/, ""),
    token,
    execute: values.execute === true,
    force: values.force === true,
    includeNonRetryable: values["include-non-retryable"] === true,
    poll: values.poll === true,
    pollIntervalMs,
    pollTimeoutMs,
    failFast: values["fail-fast"] === true,
  };
}

function parsePositiveIntFlag(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${name} must be a positive integer (got ${raw})`);
    process.exit(2);
  }
  return n;
}

function printUsage(): void {
  console.log(`Usage: npm run reprocess:failed -- [--input <path> | <path>] [--reading <id> | --all] [options]

Reads failed-attempt JSON records produced by gather:failed and reprocesses one
or all retryable failed readings. Dry-run by default; pass --execute to POST.

  --input <path>              Record file or directory containing record JSON.
                              May also be passed as the first positional
                              argument. Default: ${DEFAULT_INPUT}.
  --reading <id>              Required when --input is a directory with more
                              than one failed reading.
  --all                       Reprocess every failed reading in the input once.
  --base <url>                Worker base URL. Default: READER_BASE_URL env,
                              then http://127.0.0.1:8787.
  --token <token>             Bearer token. Default: READER_API_TOKEN env,
                              then .dev.vars READER_API_TOKEN.
  --execute                   Actually call POST /readings/:id/reprocess.
  --force                     Send { "force": true } to bypass active attempts.
  --include-non-retryable     Reprocess records even when retry rules say skip.
  --poll                      With --execute, poll GET /readings/:id after
                              queueing and wait for ready/failed before moving
                              to the next reading.
  --poll-interval-ms <n>      Polling interval. Default: ${DEFAULT_POLL_INTERVAL_MS}.
  --poll-timeout-ms <n>       Per-reading polling timeout. Default: ${DEFAULT_POLL_TIMEOUT_MS}.
  --fail-fast                 Stop processing further records on the first
                              error/failed/timeout result.
  --help                      Show this message.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const records = selectRecords(args, await readRecordInput(args.input));
  const headers = {
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
  };
  const results: Result[] = [];
  let stoppedEarly = false;
  for (const record of records) {
    const decision = retryDecisionForRecord(record);
    const result = await processOneRecord(args, headers, record, decision.reason, decision.retry);
    results.push(result);
    if (args.failFast && isFailureClassification(result.classification)) {
      stoppedEarly = records.indexOf(record) < records.length - 1;
      if (stoppedEarly) {
        process.stderr.write(
          `STOP  fail-fast: ${result.classification} on ${record.reading.id}; skipping remaining ${records.length - results.length} record(s)\n`,
        );
      }
      break;
    }
  }

  const summary = args.all
    ? allSummary(args, records, results, stoppedEarly)
    : oneSummary(args, records[0]!, results[0]!);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (results.some((result) => isFailureClassification(result.classification))) process.exit(1);
}

function isFailureClassification(c: Result["classification"]): boolean {
  return c === "error" || c === "timeout";
}

function selectRecords(args: Args, records: FailedAttemptRecord[]): FailedAttemptRecord[] {
  if (!args.all) return [selectSingleRecord(records, args.readingId)];
  if (records.length === 0) throw new Error("no failed-attempt records found");
  return records;
}

function oneSummary(args: Args, record: FailedAttemptRecord, result: Result) {
  return {
    input: args.input,
    reading: record.reading.id,
    execute: args.execute,
    classification: result.classification,
    reason: result.reason,
    error: result.error,
    attempt_id: result.attempt_id,
    result,
  };
}

function allSummary(
  args: Args,
  records: FailedAttemptRecord[],
  results: Result[],
  stoppedEarly: boolean,
) {
  return {
    input: args.input,
    readings: records.map((record) => record.reading.id),
    execute: args.execute,
    poll: args.poll,
    fail_fast: args.failFast,
    stopped_early: stoppedEarly,
    processed: results.length,
    queued: results.filter((result) => result.classification === "queued").length,
    ready: results.filter((result) => result.classification === "ready").length,
    skipped: results.filter((result) => result.classification === "skipped").length,
    timeouts: results.filter((result) => result.classification === "timeout").length,
    errors: results.filter((result) => result.classification === "error").length,
    results,
  };
}

async function processOneRecord(
  args: Args,
  headers: Record<string, string>,
  record: FailedAttemptRecord,
  reason: string,
  retryable: boolean,
): Promise<Result> {
  if (!retryable && !args.includeNonRetryable) {
    process.stderr.write(`SKIP  ${record.reading.id} ${record.reading.url} (${reason})\n`);
    return {
      id: record.reading.id,
      url: record.reading.url,
      classification: "skipped",
      reason,
    };
  }

  if (!args.execute) {
    process.stderr.write(`WOULD ${record.reading.id} ${record.reading.url} (${reason})\n`);
    return {
      id: record.reading.id,
      url: record.reading.url,
      classification: "queued",
      reason: `dry run: ${reason}`,
    };
  }

  const result = await reprocessOne(args.base, headers, record, args.force);
  if (result.classification === "queued") {
    process.stderr.write(`QUEUE ${record.reading.id} attempt=${result.attempt_id ?? "(unknown)"}\n`);
  } else {
    process.stderr.write(`ERROR ${record.reading.id} ${result.error ?? "unknown"}\n`);
    return result;
  }
  if (!args.poll) return result;
  return await pollOne(args, headers, record, result);
}

async function pollOne(
  args: Args,
  headers: Record<string, string>,
  record: FailedAttemptRecord,
  queued: Result,
): Promise<Result> {
  const outcome = await pollReadingTerminal(
    {
      base: args.base,
      headers,
      id: record.reading.id,
      intervalMs: args.pollIntervalMs,
      timeoutMs: args.pollTimeoutMs,
    },
    {
      fetch,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
    },
  );

  if (outcome.kind === "ready") {
    process.stderr.write(`READY ${record.reading.id} attempt=${queued.attempt_id ?? "(unknown)"}\n`);
    return { ...queued, classification: "ready" };
  }
  if (outcome.kind === "failed") {
    const errMsg = outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : "failed";
    process.stderr.write(`FAIL  ${record.reading.id} ${errMsg}\n`);
    return { ...queued, classification: "error", error: errMsg };
  }
  process.stderr.write(
    `TIME  ${record.reading.id} still ${outcome.lastStatus} after ${args.pollTimeoutMs}ms\n`,
  );
  return {
    ...queued,
    classification: "timeout",
    error: `still ${outcome.lastStatus} after ${args.pollTimeoutMs}ms`,
  };
}

async function reprocessOne(
  base: string,
  headers: Record<string, string>,
  record: FailedAttemptRecord,
  force: boolean,
): Promise<Result> {
  const url = new URL(`/readings/${encodeURIComponent(record.reading.id)}/reprocess`, base);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(force ? { force: true } : {}),
  });
  if (!res.ok) {
    return {
      id: record.reading.id,
      url: record.reading.url,
      classification: "error",
      error: `${res.status} ${await res.text()}`.trim(),
    };
  }
  const body = (await res.json()) as { attempt_id?: string };
  return {
    id: record.reading.id,
    url: record.reading.url,
    attempt_id: body.attempt_id,
    classification: "queued",
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
