// Local extraction agent (plan 016, Phase 1): polls the reading API for
// fetch_source-failed readings, re-extracts them locally (residential IP,
// browser headers) through the SSRF-guarded static tier, and re-submits the
// markdown via import-markdown. Dry-run by default; every submit is a paid
// action, capped per run.
//
// Usage: npm run extract-agent -- [--dry-run|--execute] [--limit N] [--only <id|url>]
// Config: .extract-agent.vars (dotvars, gitignored) or env — see
// scripts/extract-agent-lib/config.ts for the knobs.

import { lookup as dnsLookup } from "node:dns/promises";
import { homedir } from "node:os";
import { resolveAgentConfig } from "./extract-agent-lib/config";
import { pageAllReadings } from "./extract-agent-lib/poll";
import { parseRunArgs, runAgent, type RunSummary } from "./extract-agent-lib/run";
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

  const lookup = (hostname: string) => dnsLookup(hostname, { all: true });
  const summary = await runAgent(args, {
    config,
    pageReadings: () => pageAllReadings({ fetch, base: config.api.base, token: config.api.token }),
    extract: (url) => extractStatic(url, { fetch, lookup, maxBytes: config.fetchMaxBytes }),
    submit: makeImportSubmitter({ ...config.api, fetch, email: config.email }),
    loadState: () => loadSidecar(config.statePath, { warn: (m) => console.warn(m) }),
    saveState: (state) => saveSidecar(config.statePath, state),
    now: () => new Date(),
    log: (line) => console.log(line),
  });

  printSummary(summary);
}

function printSummary(summary: RunSummary): void {
  console.log(`\n${summary.dry_run ? "DRY RUN — plan only, nothing submitted" : "EXECUTED"}`);
  for (const row of summary.rows) {
    const outcome = row.outcome ?? row.decision;
    console.log(`  ${outcome.padEnd(13)} ${row.id}  ${row.url}\n${" ".repeat(16)}${row.why}${row.detail ? ` — ${row.detail}` : ""}`);
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
