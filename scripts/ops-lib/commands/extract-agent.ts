// `ops extract agent` — the local extraction agent (plan 016): polls the
// reading API for fetch_source-failed readings, re-extracts them locally
// (residential IP, browser headers) through the SSRF-guarded static tier —
// falling back to a headless render when that tier is challenged or finds no
// real article — or fetches Reddit thread JSON anonymously and leaves
// challenged threads in the manual-skill queue. Successful markdown re-enters
// through import-markdown.
//
// Plan-first: a mode-less run polls, classifies, and prints the same per-row
// plan the old --dry-run produced, but persists nothing — the sidecar save and
// run-log seams are no-ops in plan mode, no Markdown is submitted, and the
// session itself only takes the run lock and pings the dead-man healthcheck on
// execute runs. --execute retains locks, caps, summaries, and failure
// semantics unchanged. Every submit is a paid action, capped per run.
//
// This module is dependency composition only — the run itself lives in
// extract-agent-lib/session.ts, where the ordering guarantees are tested.
// Heavy dependencies (Playwright renderer, extractors, pollers) load inside
// buildSessionDeps, never at registry/help time.

import { parseArgs } from "node:util";
import type { RunArgs, RunSummary } from "../../extract-agent-lib/run";
import type { SessionDeps, SessionResult } from "../../extract-agent-lib/session";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ExtractAgentDeps extends BaseDeps {
  // Composes the full SessionDeps for this run. `persist` is false in plan
  // mode: the sidecar save and run-log append seams must then be no-ops.
  buildSessionDeps: (opts: { persist: boolean }) => Promise<SessionDeps>;
  runSession: (args: RunArgs, deps: SessionDeps) => Promise<SessionResult>;
}

interface Args extends RunArgs {
  verbose?: boolean;
}

function parseAgentArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        execute: { type: "boolean", default: false },
        limit: { type: "string" },
        only: { type: "string" },
        verbose: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const args: Args = { execute: values.execute === true };
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new UsageError(`--limit requires a positive integer, got ${JSON.stringify(values.limit)}`);
    }
    args.limit = n;
  }
  if (values.only !== undefined) {
    if (!values.only) throw new UsageError("--only requires a reading id or url");
    args.only = values.only;
  }
  if (values.verbose) args.verbose = true;
  return args;
}

async function runExtractAgent(argv: string[], deps: ExtractAgentDeps): Promise<number> {
  const args = parseAgentArgs(argv);
  const sessionDeps = await deps.buildSessionDeps({ persist: args.execute });
  const result = await deps.runSession(args, sessionDeps);

  if (result.status === "already_running") {
    deps.io.stdout("extract agent: another run holds the lock; this run did nothing (see the run log)");
  }
  if (result.summary) printSummary(deps.io, result.summary, args);
  return result.exitCode;
}

function printSummary(io: CommandIo, summary: RunSummary, args: Args): void {
  io.stdout(`\n${summary.dry_run ? "PLAN — nothing submitted; rerun with --execute to act" : "EXECUTED"}`);
  // Same filter as the run report: a plan against the whole corpus buckets
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
    io.stdout(
      `  ${outcome.padEnd(13)} ${row.id}${tier}  ${row.url}\n${" ".repeat(16)}${row.why}${row.detail ? ` — ${row.detail}` : ""}`,
    );
  }
  if (!args.verbose && rows.length < summary.rows.length) {
    io.stdout(`  (${summary.rows.length - rows.length} unattempted rows hidden — --verbose to show)`);
  }
  const counts = Object.entries(summary)
    .filter(([key, value]) => key !== "rows" && key !== "dry_run" && typeof value === "number")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  io.stdout(`\n${counts}`);
}

async function defaultBuildSessionDeps(
  io: CommandIo,
  opts: { persist: boolean },
): Promise<SessionDeps> {
  const { randomUUID } = await import("node:crypto");
  const { lookup: dnsLookup } = await import("node:dns/promises");
  const { readFile } = await import("node:fs/promises");
  const { homedir, hostname } = await import("node:os");
  const { resolveAgentConfig } = await import("../../extract-agent-lib/config");
  const { pageAllReadings } = await import("../../extract-agent-lib/poll");
  const { appendRunLine } = await import("../../extract-agent-lib/report");
  const { loadSidecar, saveSidecar } = await import("../../extract-agent-lib/sidecar");
  const { extractHeadless } = await import("../../extract-agent-lib/headless-tier");
  const { makePlaywrightRenderPage } = await import("../../extract-agent-lib/render-playwright");
  const { extractReddit } = await import("../../extract-agent-lib/reddit");
  const { extractStatic } = await import("../../extract-agent-lib/static-tier");
  const { makeImportSubmitter } = await import("../../extract-agent-lib/submit");
  const { readingApiFor } = await import("../../lib/reading-api");
  const { loadDotVars } = await import("../../lib/dotvars");

  const config = resolveAgentConfig({
    vars: { ...loadDotVars(".extract-agent.vars"), ...process.env },
    homedir: homedir(),
  });
  const lookup = (hostname_: string) => dnsLookup(hostname_, { all: true });
  const warn = (message: string) => io.stderr(message);
  // Built once per run, but Playwright is still only imported when a row
  // actually earns a render: the lazy import lives inside the returned seam.
  const renderPage = makePlaywrightRenderPage({ lookup });

  const linuxBootId = async (): Promise<string | undefined> => {
    try {
      const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim();
      return id || undefined;
    } catch {
      // Non-Linux systems have no portable reboot-stable identifier. Falling
      // back to PID liveness may leave a reused pid held until an operator
      // intervenes, but it never breaks a live lock because the clock moved.
      return undefined;
    }
  };
  // Signal 0 tests for existence without delivering anything. EPERM means the
  // process exists and belongs to someone else — still alive, still holding
  // the lock.
  const isProcessAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
  };

  return {
    config,
    pageReadings: () => pageAllReadings({ fetch, base: config.api.base, token: config.api.token }),
    extract: (url) => extractStatic(url, { fetch, lookup, maxBytes: config.fetchMaxBytes }),
    reddit: (url) => extractReddit(url, { fetch, lookup, maxBytes: config.fetchMaxBytes }),
    render: (url) => extractHeadless(url, { renderPage, lookup, maxBytes: config.fetchMaxBytes }),
    submit: makeImportSubmitter({ api: readingApiFor({ ...config.api, fetch }), email: config.email }),
    loadState: () => loadSidecar(config.statePath, { warn }),
    // Plan mode persists nothing: sidecar and run-log writes become no-ops
    // while reads stay live so back-off state still shapes the plan.
    saveState: opts.persist ? (state) => saveSidecar(config.statePath, state) : async () => {},
    now: () => new Date(),
    log: (line) => io.stdout(line),
    fetch,
    runId: randomUUID(),
    host: hostname(),
    pid: process.pid,
    bootId: await linuxBootId(),
    isProcessAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    writeRunLine: appendRunLine,
    // Plan mode skips the whole report-lock + run-log block inside the
    // session (no lock file, no append), not just the append callback.
    persistReport: opts.persist,
    warn,
  };
}

export const extractAgentCommand: CommandDefinition<ExtractAgentDeps> = {
  group: "extract",
  name: "agent",
  summary: "Re-extract fetch-blocked readings locally and re-import them",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- extract agent [options]

Polls the reading API for fetch_source-failed readings and re-extracts them
locally: an SSRF-guarded static tier with browser headers, a headless render
fallback, and an anonymous Reddit thread-JSON path. Successful markdown
re-enters through import-markdown.

Plan by default: polls, classifies, and prints the per-row plan without
submitting Markdown, persisting sidecar or run-log state, or pinging the
healthcheck. --execute submits (paid summarization per import, capped per
run), takes the run lock, appends the run report, and pings the dead-man
healthcheck.

Options:
  --limit <n>    Cap paid submits per run.
  --only <sel>   Restrict to one reading id or url.
  --verbose      Print every scanned row, not just acted ones.
  --execute      Act (otherwise prints the plan).
  --help         Show this message.

Config: .extract-agent.vars (dotvars, gitignored) or env — see
scripts/extract-agent-lib/config.ts for the knobs.`,
  defaultDeps: (io: CommandIo): ExtractAgentDeps => ({
    io,
    buildSessionDeps: (opts) => defaultBuildSessionDeps(io, opts),
    runSession: async (args, sessionDeps) => {
      const { runSession } = await import("../../extract-agent-lib/session");
      return runSession(args, sessionDeps);
    },
  }),
  run: runExtractAgent,
};
