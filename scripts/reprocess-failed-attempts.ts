#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import {
  readRecordInput,
  retryDecisionForRecord,
  selectSingleRecord,
  type FailedAttemptRecord,
} from "./reprocess-failed-lib/records";

interface Args {
  input: string;
  readingId: string | undefined;
  base: string;
  token: string;
  execute: boolean;
  force: boolean;
  includeNonRetryable: boolean;
}

interface Result {
  id: string;
  url: string;
  attempt_id?: string;
  classification: "queued" | "skipped" | "error";
  reason?: string;
  error?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      reading: { type: "string" },
      base: { type: "string" },
      token: { type: "string" },
      execute: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "include-non-retryable": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const input = values.input ?? positionals[0];
  if (!input) {
    console.error("missing required --input <file-or-dir>");
    printUsage();
    process.exit(2);
  }

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
    base: base.replace(/\/+$/, ""),
    token,
    execute: values.execute === true,
    force: values.force === true,
    includeNonRetryable: values["include-non-retryable"] === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run reprocess:failed -- --input <file-or-dir> [--reading <id>] [options]

Reads failed-attempt JSON records produced by gather:failed and reprocesses one
retryable failed reading. Dry-run by default; pass --execute to POST the job.

  --input <path>              Record file or directory containing record JSON.
  --reading <id>              Required when --input is a directory with more
                              than one failed reading.
  --base <url>                Worker base URL. Default: READER_BASE_URL env,
                              then http://127.0.0.1:8787.
  --token <token>             Bearer token. Default: READER_API_TOKEN env,
                              then .dev.vars READER_API_TOKEN.
  --execute                   Actually call POST /readings/:id/reprocess.
  --force                     Send { "force": true } to bypass active attempts.
  --include-non-retryable     Reprocess records even when retry rules say skip.
  --help                      Show this message.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const record = selectSingleRecord(await readRecordInput(args.input), args.readingId);
  const headers = {
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
  };
  const decision = retryDecisionForRecord(record);
  const result = await processOneRecord(args, headers, record, decision.reason, decision.retry);

  const summary = {
    input: args.input,
    reading: record.reading.id,
    execute: args.execute,
    classification: result.classification,
    reason: result.reason,
    error: result.error,
    attempt_id: result.attempt_id,
    result,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.classification === "error") process.exit(1);
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
  }
  return result;
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
