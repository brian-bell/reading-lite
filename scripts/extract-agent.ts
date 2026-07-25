// Local extraction agent (plan 016, Phases 1–2): polls the reading API for
// fetch_source-failed readings, re-extracts them locally (residential IP,
// browser headers) through the SSRF-guarded static tier, and re-submits the
// markdown via import-markdown. Dry-run by default; every submit is a paid
// action, capped per run. Each run appends one JSON line to the run log and a
// completed --execute run pings the dead-man healthcheck.
//
// This file is dependency composition only — the run itself lives in
// extract-agent-lib/session.ts, which is where the ordering guarantees are
// tested.
//
// Usage: npm run extract-agent -- [--dry-run|--execute] [--limit N] [--only <id|url>] [--verbose]
// Config: .extract-agent.vars (dotvars, gitignored) or env — see
// scripts/extract-agent-lib/config.ts for the knobs.

import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { homedir, hostname } from "node:os";
import { resolveAgentConfig } from "./extract-agent-lib/config";
import { pageAllReadings } from "./extract-agent-lib/poll";
import { parseRunArgs, type RunArgs, type RunSummary } from "./extract-agent-lib/run";
import { runSession } from "./extract-agent-lib/session";
import { loadSidecar, saveSidecar } from "./extract-agent-lib/sidecar";
import { extractStatic } from "./extract-agent-lib/static-tier";
import { makeImportSubmitter } from "./extract-agent-lib/submit";
import { loadDotVars } from "./lib/dotvars";

async function main(): Promise<void> {
  const args = parseRunArgs(process.argv.slice(2));
  const config = resolveAgentConfig({
    vars: { ...loadDotVars(".extract-agent.vars"), ...process.env },
    homedir: homedir(),
  });

  const lookup = (hostname_: string) => dnsLookup(hostname_, { all: true });
  const warn = (message: string) => console.warn(message);
  const result = await runSession(args, {
    config,
    pageReadings: () => pageAllReadings({ fetch, base: config.api.base, token: config.api.token }),
    extract: (url) => extractStatic(url, { fetch, lookup, maxBytes: config.fetchMaxBytes }),
    submit: makeImportSubmitter({ ...config.api, fetch, email: config.email }),
    loadState: () => loadSidecar(config.statePath, { warn }),
    saveState: (state) => saveSidecar(config.statePath, state),
    now: () => new Date(),
    log: (line) => console.log(line),
    fetch,
    runId: randomUUID(),
    host: hostname(),
    pid: process.pid,
    warn,
  });

  if (result.summary) printSummary(result.summary, args);
  process.exit(result.exitCode);
}

function printSummary(summary: RunSummary, args: RunArgs): void {
  console.log(`\n${summary.dry_run ? "DRY RUN — plan only, nothing submitted" : "EXECUTED"}`);
  // Same filter as the run report: a dry run against the whole corpus buckets
  // one row per reading, and printing all of them buries the handful that acted.
  // --verbose prints everything.
  const rows = args.verbose
    ? summary.rows
    : summary.rows.filter((row) => row.decision === "attempt" || row.decision === "manual" || row.decision === "backed_off");
  for (const row of rows) {
    const outcome = row.outcome ?? row.decision;
    console.log(`  ${outcome.padEnd(13)} ${row.id}  ${row.url}\n${" ".repeat(16)}${row.why}${row.detail ? ` — ${row.detail}` : ""}`);
  }
  if (!args.verbose && rows.length < summary.rows.length) {
    console.log(`  (${summary.rows.length - rows.length} unattempted rows hidden — --verbose to show)`);
  }
  const counts = Object.entries(summary)
    .filter(([key, value]) => key !== "rows" && key !== "dry_run" && typeof value === "number")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`\n${counts}`);
}

main().catch((e) => {
  console.error(`extract-agent: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
