// Local extraction agent (plan 016, Phases 1-4): polls the reading API for
// fetch_source-failed readings, re-extracts them locally (residential IP,
// browser headers) through the SSRF-guarded static tier — falling back to a
// headless render when that tier is challenged or finds no real article — or
// fetches Reddit thread JSON anonymously and leaves challenged threads in the
// manual-skill queue. Successful markdown re-enters through import-markdown.
// Dry-run by default; every submit is a paid action, capped per run. Each run
// appends one JSON line to the run log and a completed --execute run pings the
// dead-man healthcheck. A lockfile keeps two overlapping runs from
// double-submitting paid work.
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
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { resolveAgentConfig } from "./extract-agent-lib/config";
import { pageAllReadings } from "./extract-agent-lib/poll";
import { parseRunArgs, type RunArgs, type RunSummary } from "./extract-agent-lib/run";
import { appendRunLine } from "./extract-agent-lib/report";
import { runSession } from "./extract-agent-lib/session";
import { loadSidecar, saveSidecar } from "./extract-agent-lib/sidecar";
import { extractHeadless } from "./extract-agent-lib/headless-tier";
import { makePlaywrightRenderPage } from "./extract-agent-lib/render-playwright";
import { extractReddit } from "./extract-agent-lib/reddit";
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
  // Built once per run, but Playwright is still only imported when a row
  // actually earns a render: the lazy import lives inside the returned seam.
  const renderPage = makePlaywrightRenderPage({ lookup });
  const result = await runSession(args, {
    config,
    pageReadings: () => pageAllReadings({ fetch, base: config.api.base, token: config.api.token }),
    extract: (url) => extractStatic(url, { fetch, lookup, maxBytes: config.fetchMaxBytes }),
    reddit: (url) => extractReddit(url, { fetch, lookup, maxBytes: config.fetchMaxBytes }),
    render: (url) => extractHeadless(url, { renderPage, lookup, maxBytes: config.fetchMaxBytes }),
    submit: makeImportSubmitter({ ...config.api, fetch, email: config.email }),
    loadState: () => loadSidecar(config.statePath, { warn }),
    saveState: (state) => saveSidecar(config.statePath, state),
    now: () => new Date(),
    log: (line) => console.log(line),
    fetch,
    runId: randomUUID(),
    host: hostname(),
    pid: process.pid,
    bootId: await linuxBootId(),
    isProcessAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    writeRunLine: appendRunLine,
    warn,
  });

  if (result.status === "already_running") {
    console.log("extract-agent: another run holds the lock; this run did nothing (see the run log)");
  }
  if (result.summary) printSummary(result.summary, args);
  // exitCode, not exit(): process.exit() drops pending stdout writes, which
  // truncates this summary whenever the timer pipes the agent into a collector.
  process.exitCode = result.exitCode;
}

async function linuxBootId(): Promise<string | undefined> {
  try {
    const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim();
    return id || undefined;
  } catch {
    // Non-Linux systems have no portable reboot-stable identifier. Falling back
    // to PID liveness may leave a reused pid held until an operator intervenes,
    // but it never breaks a live lock because the wall clock moved.
    return undefined;
  }
}

// Signal 0 tests for existence without delivering anything. EPERM means the
// process exists and belongs to someone else — still alive, still holding the
// lock.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
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
    // The tier is worth a glance on every acted row: "imported" from a render
    // and "imported" from a plain fetch are the same word for very different
    // amounts of work.
    const tier = row.tier === "headless" ? " [rendered]" : "";
    console.log(
      `  ${outcome.padEnd(13)} ${row.id}${tier}  ${row.url}\n${" ".repeat(16)}${row.why}${row.detail ? ` — ${row.detail}` : ""}`,
    );
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
  process.exitCode = 1;
});
