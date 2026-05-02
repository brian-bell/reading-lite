#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import {
  readRecordInput,
  retryDecisionForRecord,
  type FailedAttemptRecord,
} from "./reprocess-failed-lib/records";

interface Args {
  input: string;
  base: string;
  token: string;
  execute: boolean;
  force: boolean;
  includeNonRetryable: boolean;
  limit: number;
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
      base: { type: "string" },
      token: { type: "string" },
      execute: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "include-non-retryable": { type: "boolean", default: false },
      limit: { type: "string" },
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

  const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit);
  if (!Number.isFinite(limit) && values.limit !== undefined) {
    console.error("--limit must be a number");
    process.exit(2);
  }

  return {
    input,
    base: base.replace(/\/+$/, ""),
    token,
    execute: values.execute === true,
    force: values.force === true,
    includeNonRetryable: values["include-non-retryable"] === true,
    limit,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run reprocess:failed -- --input <file-or-dir> [options]

Reads failed-attempt JSON records produced by gather:failed and reprocesses the
retryable readings. Dry-run by default; pass --execute to POST reprocess jobs.

  --input <path>              Record file or directory containing record JSON.
  --base <url>                Worker base URL. Default: READER_BASE_URL env,
                              then http://127.0.0.1:8787.
  --token <token>             Bearer token. Default: READER_API_TOKEN env,
                              then .dev.vars READER_API_TOKEN.
  --execute                   Actually call POST /readings/:id/reprocess.
  --force                     Send { "force": true } to bypass active attempts.
  --include-non-retryable     Reprocess records even when retry rules say skip.
  --limit <n>                 Stop after n queued records.
  --help                      Show this message.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const records = await readRecordInput(args.input);
  const headers = {
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
  };
  const results: Result[] = [];
  let queued = 0;

  for (const record of records) {
    const decision = retryDecisionForRecord(record);
    if (!decision.retry && !args.includeNonRetryable) {
      results.push({
        id: record.reading.id,
        url: record.reading.url,
        classification: "skipped",
        reason: decision.reason,
      });
      process.stderr.write(`SKIP  ${record.reading.id} ${record.reading.url} (${decision.reason})\n`);
      continue;
    }
    if (queued >= args.limit) {
      results.push({
        id: record.reading.id,
        url: record.reading.url,
        classification: "skipped",
        reason: "limit reached",
      });
      continue;
    }

    if (!args.execute) {
      queued += 1;
      results.push({
        id: record.reading.id,
        url: record.reading.url,
        classification: "queued",
        reason: `dry run: ${decision.reason}`,
      });
      process.stderr.write(`WOULD ${record.reading.id} ${record.reading.url} (${decision.reason})\n`);
      continue;
    }

    const result = await reprocessOne(args.base, headers, record, args.force);
    results.push(result);
    if (result.classification === "queued") {
      queued += 1;
      process.stderr.write(`QUEUE ${record.reading.id} attempt=${result.attempt_id ?? "(unknown)"}\n`);
    } else {
      process.stderr.write(`ERROR ${record.reading.id} ${result.error ?? "unknown"}\n`);
    }
  }

  const summary = {
    input: args.input,
    execute: args.execute,
    total_records: records.length,
    queued: results.filter((r) => r.classification === "queued").length,
    skipped: results.filter((r) => r.classification === "skipped").length,
    errors: results.filter((r) => r.classification === "error").length,
    results,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.errors > 0) process.exit(1);
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
