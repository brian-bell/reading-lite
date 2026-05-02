#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import {
  failedAttemptRecordsFromDiagnostics,
  recordFileName,
  runStamp,
  type FailedAttemptRecord,
  type ReadingDiagnosticsLike,
  type ReadingListItemLike,
} from "./reprocess-failed-lib/records";

interface Args {
  base: string;
  token: string;
  outDir: string;
  dryRun: boolean;
}

interface ListResponse {
  readings: ReadingListItemLike[];
  has_more: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      token: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
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
    base: base.replace(/\/+$/, ""),
    token,
    outDir: values.out ?? path.join(".failed-attempts", runStamp()),
    dryRun: values["dry-run"] === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run gather:failed -- [--base <url>] [--token <t>] [--out <dir>] [--dry-run]

Fetches every reading's diagnostics, extracts failed processing attempts, and
writes one local JSON record per failed attempt plus index.json.

Token resolution: --token > READER_API_TOKEN env > .dev.vars READER_API_TOKEN.
Base URL resolution: --base > READER_BASE_URL env > http://127.0.0.1:8787.
Default output: .failed-attempts/<timestamp>.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const gatheredAt = new Date().toISOString();
  const headers = {
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
  };

  const readings = await listAllReadings(args.base, headers);
  const records: FailedAttemptRecord[] = [];
  let diagnosticsErrors = 0;

  for (const reading of readings) {
    try {
      const diagnostics = await getDiagnostics(args.base, headers, reading.id);
      records.push(...failedAttemptRecordsFromDiagnostics(args.base, gatheredAt, diagnostics));
    } catch (e) {
      diagnosticsErrors += 1;
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`diagnostics failed id=${reading.id}: ${msg}\n`);
    }
  }

  records.sort((a, b) =>
    a.attempt.started_at < b.attempt.started_at
      ? 1
      : a.attempt.started_at > b.attempt.started_at
        ? -1
        : a.attempt.id.localeCompare(b.attempt.id),
  );

  const retryable = records.filter((record) => record.retry.retry).length;
  process.stderr.write(
    `readings=${readings.length} failed_attempts=${records.length} retryable=${retryable} diagnostics_errors=${diagnosticsErrors}\n`,
  );

  if (args.dryRun) {
    for (const record of records) {
      process.stderr.write(
        `${record.retry.retry ? "RETRY" : "SKIP "} ${record.reading.id} ${record.attempt.id} ${record.reading.url} (${record.retry.reason})\n`,
      );
    }
    return;
  }

  await fs.mkdir(args.outDir, { recursive: true });
  const files: string[] = [];
  for (const record of records) {
    const file = recordFileName(record);
    files.push(file);
    await fs.writeFile(
      path.join(args.outDir, file),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

  await fs.writeFile(
    path.join(args.outDir, "index.json"),
    `${JSON.stringify(
      {
        version: 1,
        gathered_at: gatheredAt,
        base_url: args.base,
        readings: readings.length,
        failed_attempts: records.length,
        retryable,
        diagnostics_errors: diagnosticsErrors,
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(JSON.stringify({ out_dir: args.outDir, failed_attempts: records.length, retryable }, null, 2) + "\n");
  if (diagnosticsErrors > 0) process.exit(1);
}

async function listAllReadings(
  base: string,
  headers: Record<string, string>,
): Promise<ReadingListItemLike[]> {
  const out: ReadingListItemLike[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = new URL("/readings", base);
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GET /readings -> ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as ListResponse;
    out.push(...body.readings);
    if (!body.has_more) return out;
  }
}

async function getDiagnostics(
  base: string,
  headers: Record<string, string>,
  id: string,
): Promise<ReadingDiagnosticsLike> {
  const url = new URL(`/readings/${encodeURIComponent(id)}/diagnostics`, base);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET /readings/${id}/diagnostics -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ReadingDiagnosticsLike;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
