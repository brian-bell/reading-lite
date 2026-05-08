#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import { createPrompter } from "./import-bookmarks-lib/confirm";
import {
  failedAttemptRecordsFromDiagnostics,
  newestRecordPerReading,
  recordFileName,
  type FailedAttemptRecord,
  type ReadingDiagnosticsLike,
  type ReadingListItemLike,
} from "./reprocess-failed-lib/records";

const DEFAULT_OUT_DIR = ".failed-attempts";

interface Args {
  base: string;
  token: string;
  outDir: string;
  dryRun: boolean;
  yes: boolean;
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
      yes: { type: "boolean", short: "y", default: false },
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
    outDir: values.out ?? DEFAULT_OUT_DIR,
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run gather:failed -- [--base <url>] [--token <t>] [--out <dir>] [--dry-run] [--yes|-y]

Fetches every reading's diagnostics, extracts failed processing attempts, and
also captures legacy failed manifests that predate attempt history. Writes one
local rd_<id>.json per failed reading (newest attempt wins) plus index.json.

The output directory is cleared on each run; existing rd_*.json/index.json
files are deleted after a y/n confirmation. Pass --yes to skip the prompt.

Token resolution: --token > READER_API_TOKEN env > .dev.vars READER_API_TOKEN.
Base URL resolution: --base > READER_BASE_URL env > http://127.0.0.1:8787.
Default output: ${DEFAULT_OUT_DIR}.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const gatheredAt = new Date().toISOString();
  const headers = {
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
  };

  const readings = await listAllReadings(args.base, headers);
  const allFailures: FailedAttemptRecord[] = [];
  let diagnosticsErrors = 0;

  for (const reading of readings) {
    try {
      const diagnostics = await getDiagnostics(args.base, headers, reading.id);
      allFailures.push(...failedAttemptRecordsFromDiagnostics(args.base, gatheredAt, diagnostics));
    } catch (e) {
      diagnosticsErrors += 1;
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`diagnostics failed id=${reading.id}: ${msg}\n`);
    }
  }

  const records = newestRecordPerReading(allFailures);
  const retryable = records.filter((record) => record.retry.retry).length;
  process.stderr.write(
    `readings=${readings.length} failed_readings=${records.length} retryable=${retryable} diagnostics_errors=${diagnosticsErrors}\n`,
  );

  if (args.dryRun) {
    for (const record of records) {
      process.stderr.write(
        `${record.retry.retry ? "RETRY" : "SKIP "} ${record.reading.id} ${record.attempt.id} ${record.reading.url} (${record.retry.reason})\n`,
      );
    }
    return;
  }

  if (!(await confirmAndClearOutDir(args.outDir, args.yes))) {
    process.stderr.write("aborted: output directory not cleared\n");
    process.exit(1);
  }

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
        failed_readings: records.length,
        retryable,
        diagnostics_errors: diagnosticsErrors,
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(JSON.stringify({ out_dir: args.outDir, failed_readings: records.length, retryable }, null, 2) + "\n");
  if (diagnosticsErrors > 0) process.exit(1);
}

async function confirmAndClearOutDir(dir: string, autoYes: boolean): Promise<boolean> {
  const existing = await listClearableEntries(dir);
  if (existing.length === 0) {
    await fs.mkdir(dir, { recursive: true });
    return true;
  }

  if (!autoYes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `${dir} contains ${existing.length} file(s) from a previous run. Re-run with --yes to clear non-interactively.\n`,
      );
      return false;
    }
    const prompter = createPrompter();
    try {
      const answer = await prompter.ask(
        `Clear ${existing.length} file(s) from ${dir}? [Y/n/q]`,
      );
      if (answer !== "yes") return false;
    } finally {
      prompter.close();
    }
  }

  for (const entry of existing) {
    await fs.rm(path.join(dir, entry), { force: true });
  }
  return true;
}

async function listClearableEntries(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries.filter(
    (name) => name === "index.json" || (name.startsWith("rd_") && name.endsWith(".json")),
  );
}

// Paginates by offset; if list/index.json is mutated mid-scan a reading can be
// duplicated (handled by newestRecordPerReading downstream) or skipped. Run
// against an idle deployment when full coverage matters.
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
