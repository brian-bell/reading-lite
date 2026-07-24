// Orchestrator: plan → act → summary. Everything side-effectful is injected
// (pager, extractor, submitter, sidecar persistence, clock) so the run's
// behavior — bucketing, budget, gates, sidecar bookkeeping — is testable pure.

import type { ListIndexItem } from "../../src/schemas/api";
import type { AgentConfig } from "./config";
import { makeBudget, markdownGate } from "./gates";
import { classify, type Route } from "./policy";
import {
  recordAttempt,
  shouldAttempt,
  type AttemptOutcome,
  type SidecarState,
} from "./sidecar";
import type { StaticOutcome } from "./static-tier";
import type { SubmitBody, SubmitFn } from "./submit";

export interface RunArgs {
  execute: boolean;
  limit?: number;
  only?: string;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const args: RunArgs = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--execute":
        args.execute = true;
        break;
      case "--dry-run":
        args.execute = false;
        break;
      case "--limit": {
        const raw = argv[++i];
        const n = Number(raw);
        if (raw === undefined || !Number.isInteger(n) || n <= 0) {
          throw new Error(`--limit requires a positive integer, got ${JSON.stringify(raw)}`);
        }
        args.limit = n;
        break;
      }
      case "--only": {
        const value = argv[++i];
        if (!value) throw new Error("--only requires a reading id or url");
        args.only = value;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

export interface RunDeps {
  config: AgentConfig;
  pageReadings: () => Promise<ListIndexItem[]>;
  extract: (url: string) => Promise<StaticOutcome>;
  submit: SubmitFn;
  loadState: () => Promise<SidecarState>;
  saveState: (state: SidecarState) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
}

export type RowOutcome =
  | "planned"
  | "imported"
  | "gate_rejected"
  | "challenge"
  | "dead"
  | "no_article"
  | "error"
  | "deferred"
  | "manual";

export interface PerRowOutcome {
  id: string;
  url: string;
  decision: string;
  route?: Route;
  why: string;
  outcome?: RowOutcome;
  detail?: string;
}

export interface RunSummary {
  dry_run: boolean;
  scanned: number;
  eligible: number;
  ineligible: number;
  out_of_scope: number;
  never: number;
  manual: number;
  backed_off: number;
  attempted: number;
  imported: number;
  gate_rejected: number;
  challenge: number;
  dead: number;
  no_article: number;
  errors: number;
  deferred: number;
  rows: PerRowOutcome[];
}

export async function runAgent(args: RunArgs, deps: RunDeps): Promise<RunSummary> {
  const { config, log } = deps;
  const allRows = await deps.pageReadings();
  let state = await deps.loadState();

  const summary: RunSummary = {
    dry_run: !args.execute,
    scanned: allRows.length,
    eligible: 0,
    ineligible: 0,
    out_of_scope: 0,
    never: 0,
    manual: 0,
    backed_off: 0,
    attempted: 0,
    imported: 0,
    gate_rejected: 0,
    challenge: 0,
    dead: 0,
    no_article: 0,
    errors: 0,
    deferred: 0,
    rows: [],
  };

  const rows = args.only ? allRows.filter((r) => r.id === args.only || r.url === args.only) : allRows;

  // Plan: bucket every row; collect the attemptable static-route ones in order.
  const attemptQueue: Array<{ row: ListIndexItem; why: string }> = [];
  for (const row of rows) {
    const decision = classify(row);
    if (decision.decision !== "attempt") {
      summary[decision.decision] += 1;
      summary.rows.push({ id: row.id, url: row.url, decision: decision.decision, why: decision.why });
      continue;
    }
    const verdict = shouldAttempt(state.readings[row.id], row, { now: deps.now, maxAttempts: config.maxAttempts });
    if (!verdict.ok) {
      summary.backed_off += 1;
      summary.rows.push({ id: row.id, url: row.url, decision: "backed_off", route: decision.route, why: verdict.why ?? "backing off" });
      continue;
    }
    if (decision.route !== "static") {
      // Reddit/YouTube routes land in Phases 4 and 7; until then these rows are
      // the manual reddit-import / youtube-import skill queue.
      summary.manual += 1;
      summary.rows.push({
        id: row.id,
        url: row.url,
        decision: "manual",
        route: decision.route,
        why: `${decision.why} — route not yet implemented (Phase 4/7)`,
        outcome: "manual",
      });
      continue;
    }
    summary.eligible += 1;
    attemptQueue.push({ row, why: decision.why });
  }

  const budget = makeBudget(config.maxPaidActions);
  const attemptCap = args.limit ?? Number.POSITIVE_INFINITY;
  // Dry-run rows never reach the budget, so the plan tracks its own count and
  // applies --limit itself: an operator validating a limited rollout has to see
  // the same planned/deferred split the execute run would attempt. Only the
  // attempt cap is honored here, never maxPaidActions — the attempt cap counts
  // attempts, which a plan knows exactly, while the paid cap counts submits,
  // which it cannot: a challenge, dead, no_article, error, or gate-rejected row
  // costs nothing and leaves the slot for a later row. Deferring on the paid cap
  // would make the plan claim skips that an execute run would go on to import.
  let planned = 0;

  for (const { row, why } of attemptQueue) {
    const entry: PerRowOutcome = { id: row.id, url: row.url, decision: "attempt", route: "static", why };
    summary.rows.push(entry);

    if (!args.execute) {
      if (planned >= attemptCap) {
        entry.outcome = "deferred";
        summary.deferred += 1;
        continue;
      }
      entry.outcome = "planned";
      planned += 1;
      continue;
    }
    if (summary.attempted >= attemptCap || budget.consumed >= config.maxPaidActions) {
      entry.outcome = "deferred";
      summary.deferred += 1;
      continue;
    }

    summary.attempted += 1;
    const acted = await attemptRow(row, entry, deps, budget);
    summary[acted.summaryKey] += 1;
    state = recordAttempt(state, row, acted.sidecarOutcome, { now: deps.now, maxAttempts: config.maxAttempts });
    await deps.saveState(state);
    log(`${row.id} ${entry.outcome}${entry.detail ? ` — ${entry.detail}` : ""} (${row.url})`);
  }

  return summary;
}

interface ActResult {
  summaryKey: "imported" | "gate_rejected" | "challenge" | "dead" | "no_article" | "errors";
  sidecarOutcome: AttemptOutcome;
}

async function attemptRow(
  row: ListIndexItem,
  entry: PerRowOutcome,
  deps: RunDeps,
  budget: { tryConsume(): boolean },
): Promise<ActResult> {
  let outcome: StaticOutcome;
  try {
    outcome = await deps.extract(row.url);
  } catch (e) {
    entry.outcome = "error";
    entry.detail = e instanceof Error ? e.message : String(e);
    return { summaryKey: "errors", sidecarOutcome: "error" };
  }

  switch (outcome.kind) {
    case "challenge":
      entry.outcome = "challenge";
      entry.detail = outcome.detail;
      return { summaryKey: "challenge", sidecarOutcome: "challenge" };
    case "dead":
      entry.outcome = "dead";
      entry.detail = outcome.detail;
      return { summaryKey: "dead", sidecarOutcome: "error" };
    case "no_article":
      // Tier 2 (headless render) picks these up in Phase 3.
      entry.outcome = "no_article";
      entry.detail = outcome.detail;
      return { summaryKey: "no_article", sidecarOutcome: "no_article" };
    case "error":
      entry.outcome = "error";
      entry.detail = `${outcome.code}: ${outcome.detail}`;
      return { summaryKey: "errors", sidecarOutcome: "error" };
    case "extracted": {
      // Build the body once and gate that exact object — the gate sizes what
      // actually goes on the queue, so it can't drift from what we submit.
      const body: SubmitBody = { source_url: row.url, markdown: outcome.markdown, title: outcome.title };
      const gate = markdownGate(body, deps.config);
      if (!gate.ok) {
        entry.outcome = "gate_rejected";
        entry.detail = gate.why;
        return { summaryKey: "gate_rejected", sidecarOutcome: "gate_rejected" };
      }
      if (!budget.tryConsume()) {
        // Shouldn't happen (checked before attempting), but never submit past the cap.
        entry.outcome = "deferred";
        entry.detail = "paid-action budget exhausted";
        return { summaryKey: "errors", sidecarOutcome: "error" };
      }
      const result = await deps.submit(body);
      if (result.outcome === "error") {
        entry.outcome = "error";
        entry.detail = result.error;
        return { summaryKey: "errors", sidecarOutcome: "error" };
      }
      entry.outcome = "imported";
      entry.detail = result.outcome === "existing" ? "already existing (worker got there first)" : undefined;
      return { summaryKey: "imported", sidecarOutcome: "imported" };
    }
  }
}
