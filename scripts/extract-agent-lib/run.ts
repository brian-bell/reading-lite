// Orchestrator: plan → act → summary. Everything side-effectful is injected
// (pager, extractor, submitter, sidecar persistence, clock) so the run's
// behavior — bucketing, budget, gates, sidecar bookkeeping — is testable pure.

import type { ListIndexItem } from "../../src/schemas/api";
import type { AgentConfig } from "./config";
import { makeBudget, markdownGate, type Budget } from "./gates";
import { HeadlessUnavailableError } from "./headless-tier";
import { classify, type Route } from "./policy";
import {
  recordAttempt,
  shouldAttempt,
  type AttemptOutcome,
  type SidecarState,
} from "./sidecar";
import type { ExtractOutcome } from "./outcome";
import type { RedditOutcome } from "./reddit";
import type { SubmitBody, SubmitFn } from "./submit";

export interface RunArgs {
  execute: boolean;
  limit?: number;
  only?: string;
  // Console-only: prints every bucketed row instead of the acted-on ones. The
  // run report applies the same filter and has no escape hatch — a JSONL line
  // per reading in the corpus, every 45 minutes, is not a log anyone can read.
  verbose?: boolean;
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
      case "--verbose":
        args.verbose = true;
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
  extract: (url: string) => Promise<ExtractOutcome>;
  reddit: (url: string) => Promise<RedditOutcome>;
  // Tier 2. Optional: a run without it is still a legal run (the static tier
  // recovers most rows on its own), and leaving it out is how a box with no
  // browser installed behaves by configuration rather than by failure.
  render?: (url: string) => Promise<ExtractOutcome>;
  submit: SubmitFn;
  loadState: () => Promise<SidecarState>;
  saveState: (state: SidecarState) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  warn?: (line: string) => void;
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
  // Which tier produced the recorded outcome. Absent when nothing was
  // extracted at all (planned, deferred, manual rows) — and on Reddit rows,
  // where the extraction route is already named by `route` and the
  // static/headless distinction this field exists to mark does not apply.
  tier?: "static" | "headless";
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
  // Tier-2 accounting, kept separate from the outcome counters above: a render
  // is not an outcome, it is an attempt to improve one. `rendered_failed`
  // counts renders that produced no usable article (the row keeps its tier-1
  // outcome); `renders_skipped` counts rows that qualified for a render and
  // did not get one — cap reached, or the box cannot render at all.
  rendered: number;
  rendered_failed: number;
  renders_skipped: number;
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
    rendered: 0,
    rendered_failed: 0,
    renders_skipped: 0,
    rows: [],
  };

  const rows = args.only ? allRows.filter((r) => r.id === args.only || r.url === args.only) : allRows;

  // Plan: bucket every row; collect attemptable routes in input order.
  const attemptQueue: Array<{ row: ListIndexItem; route: "static" | "reddit"; why: string }> = [];
  for (const row of rows) {
    const decision = classify(row);
    if (decision.decision !== "attempt") {
      summary[decision.decision] += 1;
      summary.rows.push({ id: row.id, url: row.url, decision: decision.decision, why: decision.why });
      continue;
    }
    const verdict = shouldAttempt(state.readings[row.id], row, { now: deps.now, maxAttempts: config.maxAttempts });
    if (!verdict.ok) {
      if (decision.route === "reddit" && state.readings[row.id]?.last_outcome === "manual") {
        summary.manual += 1;
        summary.rows.push({
          id: row.id,
          url: row.url,
          decision: "manual",
          route: "reddit",
          why: `${decision.why} — anonymous access requires the reddit-import skill`,
          outcome: "manual",
        });
        continue;
      }
      summary.backed_off += 1;
      summary.rows.push({ id: row.id, url: row.url, decision: "backed_off", route: decision.route, why: verdict.why ?? "backing off" });
      continue;
    }
    if (decision.route === "youtube") {
      // YouTube recovery lands in Phase 7; until then these rows remain in the
      // manual youtube-import skill queue.
      summary.manual += 1;
      summary.rows.push({
        id: row.id,
        url: row.url,
        decision: "manual",
        route: decision.route,
        why: `${decision.why} — route not yet implemented (Phase 7)`,
        outcome: "manual",
      });
      continue;
    }
    summary.eligible += 1;
    attemptQueue.push({ row, route: decision.route, why: decision.why });
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
  const renders = makeRenderBudget(config.maxRenders, summary, deps.warn);

  for (const { row, route, why } of attemptQueue) {
    const entry: PerRowOutcome = { id: row.id, url: row.url, decision: "attempt", route, why };
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
    const acted = await attemptRow(row, route, entry, deps, budget, renders, summary);
    summary[acted.summaryKey] += 1;
    state = recordAttempt(state, row, acted.sidecarOutcome, { now: deps.now, maxAttempts: config.maxAttempts });
    await deps.saveState(state);
    log(`${row.id} ${entry.outcome}${entry.detail ? ` — ${entry.detail}` : ""} (${row.url})`);
  }

  return summary;
}

interface ActResult {
  summaryKey: "imported" | "gate_rejected" | "challenge" | "dead" | "no_article" | "errors" | "manual";
  sidecarOutcome: AttemptOutcome;
}

// The render budget, plus the run-wide "this box cannot render" latch. Renders
// are not paid actions — nothing is submitted — so they get their own cap:
// what they cost is wall clock, and an unattended run that spends hours on
// renders is one whose lock outlives its own staleness ceiling.
interface RenderBudget {
  available(): boolean;
  consume(): void;
  disable(reason: string): void;
}

function makeRenderBudget(cap: number, summary: RunSummary, warn?: (line: string) => void): RenderBudget {
  let disabled = false;
  return {
    available: () => !disabled && summary.rendered < cap,
    consume: () => {
      summary.rendered += 1;
    },
    // Said once, not once per row: the point of latching is that a box without
    // a working browser stops paying for the discovery.
    disable: (reason) => {
      if (disabled) return;
      disabled = true;
      warn?.(`extract-agent: headless tier disabled for this run — ${reason}`);
    },
  };
}

// Tier 2 is worth its wall clock exactly when tier 1 came back without a real
// article: challenged (the page we got was the block, not the content), no
// article at all (the JS-shell case), or salvage-only (Readability crashed and
// we kept boilerplate soup). A dead link or a hard error is not a rendering
// problem, and a clean static article needs no second opinion.
function deservesRender(outcome: ExtractOutcome): boolean {
  return (
    outcome.kind === "challenge" ||
    outcome.kind === "no_article" ||
    (outcome.kind === "extracted" && outcome.salvaged)
  );
}

// Runs tier 2 and decides which tier's result the row keeps.
//
// A tier-2 article or challenge always wins: a rendered DOM is the reason we
// rendered, and a rendered challenge must not fall back to submitting salvaged
// boilerplate. Other tier-2 non-results never cost the row anything — a
// salvage-only tier-1 article is still worth submitting, and a challenged row
// stays challenged when rendering finds nothing or fails. Either way the row's
// detail names both tiers, so a run log line explains itself.
async function renderRow(
  row: ListIndexItem,
  entry: PerRowOutcome,
  tier1: ExtractOutcome,
  deps: RunDeps,
  renders: RenderBudget,
  summary: RunSummary,
): Promise<ExtractOutcome> {
  if (!deps.render) {
    // A run configured without a renderer is a supported configuration, not a
    // silent one: the row qualified, and the report has to say it went
    // unrendered or `renders_skipped: 0` would read as "nothing was missed".
    summary.renders_skipped += 1;
    entry.detail = `${describe(tier1)} — no render (headless tier not configured)`;
    return tier1;
  }
  if (!renders.available()) {
    summary.renders_skipped += 1;
    entry.detail = `${describe(tier1)} — no render (cap reached or unavailable)`;
    return tier1;
  }

  let tier2: ExtractOutcome;
  try {
    renders.consume();
    tier2 = await deps.render(row.url);
  } catch (e) {
    if (e instanceof HeadlessUnavailableError) {
      // Not this row's failure, and not a render that happened: give the slot
      // back, latch the tier off, and let the row keep its tier-1 outcome.
      summary.rendered -= 1;
      summary.renders_skipped += 1;
      renders.disable(e.message);
      entry.detail = `${describe(tier1)} — no render (${e.message})`;
      return tier1;
    }
    summary.rendered_failed += 1;
    entry.detail = `${describe(tier1)} — render failed: ${e instanceof Error ? e.message : String(e)}`;
    return tier1;
  }

  if (tier2.kind === "extracted") {
    entry.tier = "headless";
    return tier2;
  }
  summary.rendered_failed += 1;
  entry.detail = `${describe(tier1)} — render: ${describe(tier2)}`;
  if (tier2.kind === "challenge") {
    entry.tier = "headless";
    return tier2;
  }
  return tier1;
}

function describe(outcome: ExtractOutcome): string {
  switch (outcome.kind) {
    case "extracted":
      return outcome.salvaged ? "salvaged article" : "article";
    case "error":
      return `${outcome.code}: ${outcome.detail}`;
    default:
      return `${outcome.kind}: ${outcome.detail}`;
  }
}

async function attemptRow(
  row: ListIndexItem,
  route: "static" | "reddit",
  entry: PerRowOutcome,
  deps: RunDeps,
  budget: Pick<Budget, "tryConsume" | "release">,
  renders: RenderBudget,
  summary: RunSummary,
): Promise<ActResult> {
  if (route === "reddit") {
    let outcome: RedditOutcome;
    try {
      outcome = await deps.reddit(row.url);
    } catch (e) {
      entry.outcome = "error";
      entry.detail = e instanceof Error ? e.message : String(e);
      return { summaryKey: "errors", sidecarOutcome: "error" };
    }

    switch (outcome.kind) {
      case "manual":
        entry.outcome = "manual";
        entry.detail = outcome.detail;
        return { summaryKey: "manual", sidecarOutcome: "manual" };
      case "dead":
        entry.outcome = "dead";
        entry.detail = outcome.detail;
        return { summaryKey: "dead", sidecarOutcome: "error" };
      case "error":
        entry.outcome = "error";
        entry.detail = `${outcome.code}: ${outcome.detail}`;
        return { summaryKey: "errors", sidecarOutcome: "error" };
      case "extracted":
        return submitBody(row, entry, outcome.body, deps, budget);
    }
  }

  let outcome: ExtractOutcome;
  try {
    outcome = await deps.extract(row.url);
  } catch (e) {
    entry.outcome = "error";
    entry.detail = e instanceof Error ? e.message : String(e);
    return { summaryKey: "errors", sidecarOutcome: "error" };
  }
  entry.tier = "static";

  if (deservesRender(outcome)) {
    outcome = await renderRow(row, entry, outcome, deps, renders, summary);
  }

  // A detail composed above already names both tiers; don't flatten it back to
  // tier 1's half.
  const detail = (text: string) => {
    if (entry.detail === undefined) entry.detail = text;
  };

  switch (outcome.kind) {
    case "challenge":
      entry.outcome = "challenge";
      detail(outcome.detail);
      return { summaryKey: "challenge", sidecarOutcome: "challenge" };
    case "dead":
      entry.outcome = "dead";
      detail(outcome.detail);
      return { summaryKey: "dead", sidecarOutcome: "error" };
    case "no_article":
      entry.outcome = "no_article";
      detail(outcome.detail);
      return { summaryKey: "no_article", sidecarOutcome: "no_article" };
    case "error":
      entry.outcome = "error";
      detail(`${outcome.code}: ${outcome.detail}`);
      return { summaryKey: "errors", sidecarOutcome: "error" };
    case "extracted":
      const body: SubmitBody = { source_url: row.url, markdown: outcome.markdown, title: outcome.title };
      return submitBody(row, entry, body, deps, budget);
  }
}

// Gate and submit the exact route-produced body. The object used for sizing can
// be a safe superset: when a route omits title, import-markdown inherits the
// manifest title mirrored on the list row. Counting that inherited title keeps
// the eventual queue message under its cap, while forwarding only `body`
// preserves the route contract and avoids sending a whitespace-only stored
// title through the request schema's stricter trim/min check.
async function submitBody(
  row: ListIndexItem,
  entry: PerRowOutcome,
  body: SubmitBody,
  deps: RunDeps,
  budget: Pick<Budget, "tryConsume" | "release">,
): Promise<ActResult> {
  const gate = markdownGate({ ...body, title: body.title ?? row.title }, deps.config);
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
  if (result.outcome === "existing") {
    // 200/existing means a ready or pending owner: the Worker enqueued no new
    // summarization, so this cost nothing and the slot goes back.
    budget.release();
  }
  entry.outcome = "imported";
  entry.detail = result.outcome === "existing" ? "already existing (worker got there first)" : undefined;
  return { summaryKey: "imported", sidecarOutcome: "imported" };
}
