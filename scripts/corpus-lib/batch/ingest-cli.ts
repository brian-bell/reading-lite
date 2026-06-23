import type { MarkdownArticle } from "../../import-markdown-lib/parse";
import type { BatchConfig } from "../config";
import { buildIngestPlan, type IngestPlan } from "./ingest-plan";
import type { FreshMarkdownDeps } from "./fresh-markdown";
import type { ExtractedTarget } from "./types";
import type { BatchRunResult } from "./run";

export interface IngestArgs {
  dir: string;
  execute: boolean;
  limit: number;
}

// All external I/O is injected so the decision logic (dry-run vs execute, the
// missing-creds fallback, exit codes) is unit-testable without R2 / Anthropic /
// process globals.
export interface IngestDeps {
  readMarkdownDir(dir: string): Promise<MarkdownArticle[]>;
  // Resolves R2 + Anthropic/OpenAI creds; throws when any are missing.
  resolveConfig(): BatchConfig;
  // R2-backed idempotency deps (reads index/by-url pointers + manifests).
  freshDepsFromConfig(cfg: BatchConfig): FreshMarkdownDeps;
  // Used only for dry-run when creds are absent: shows every eligible file as
  // would-submit (idempotency unchecked).
  offlineFreshDeps: FreshMarkdownDeps;
  // Wires the batch clients, runs runFreshBatch, and clears the sidecar.
  runBatch(targets: ExtractedTarget[], cfg: BatchConfig): Promise<BatchRunResult>;
  out(line: string): void;
  err(line: string): void;
}

function printPlan(plan: IngestPlan, wouldSubmit: number, err: (l: string) => void): void {
  err(
    `Plan:\n` +
      `  would-submit:       ${wouldSubmit}\n` +
      `  already/pending:    ${plan.skipped.length}\n` +
      `  duplicate groups:   ${plan.duplicateGroups.length}\n` +
      `  oversized skipped:  ${plan.oversized.length}\n` +
      `  missing-source:     ${plan.missingSource.length}\n`,
  );
  for (const s of plan.skipped) err(`  [skip ${s.reason}] ${s.url}`);
  for (const g of plan.duplicateGroups) {
    err(`  [dup ${g.files.length}->1] ${g.sourceUrl} (kept ${g.selected.fileName})`);
  }
  for (const o of plan.oversized) err(`  [skip oversized +${o.excessBytes}B] ${o.article.fileName}`);
  for (const a of plan.missingSource) err(`  [skip no-source] ${a.fileName}`);
}

// Returns the process exit code. 0 = ok, 1 = some readings failed, 2 = bad
// invocation / missing creds for --execute.
export async function runIngest(args: IngestArgs, deps: IngestDeps): Promise<number> {
  const articles = await deps.readMarkdownDir(args.dir);

  // Resolve creds up front. For --execute they're required (exit 2 if missing);
  // for dry-run we still try (accurate idempotency) but fall back to offline
  // planning so the operator can preview the shape without creds.
  let cfg: BatchConfig | null = null;
  try {
    cfg = deps.resolveConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (args.execute) {
      deps.err(msg);
      return 2;
    }
    deps.err(`  ! ${msg}`);
    deps.err(`  ! dry-run: skipping idempotency check (every eligible file shown as would-submit)`);
  }

  const freshDeps = cfg ? deps.freshDepsFromConfig(cfg) : deps.offlineFreshDeps;
  const plan = await buildIngestPlan(articles, freshDeps);
  // --limit caps readings submitted *this run*, applied after idempotency skips,
  // so a re-run picks up where the last left off (the now-ready ones are skipped).
  const targets = Number.isFinite(args.limit) ? plan.targets.slice(0, args.limit) : plan.targets;
  printPlan(plan, targets.length, deps.err);

  if (!args.execute) {
    for (const t of targets) deps.err(`  [dry-run] would summarize ${t.target.url} via Message Batch`);
    deps.out(
      JSON.stringify(
        {
          executed: false,
          wouldSubmit: targets.length,
          skipped: plan.skipped.length,
          oversized: plan.oversized.length,
          missingSource: plan.missingSource.length,
          // false means creds were absent and we couldn't check idempotency —
          // the would-submit count may include URLs already in the corpus.
          idempotencyChecked: cfg !== null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  // Execute: creds are guaranteed (we returned 2 above when they were missing).
  if (!cfg) return 2;
  if (targets.length === 0) {
    deps.out(JSON.stringify({ executed: true, ready: 0, failed: 0, skipped: plan.skipped.length }, null, 2));
    return 0;
  }

  const result = await deps.runBatch(targets, cfg);
  const ready = result.report.filter((r) => r.status === "ready").length;
  const failed = result.report.filter((r) => r.status === "failed").length;
  const skipped = result.report.filter((r) => r.status === "skipped").length;
  deps.out(
    JSON.stringify(
      {
        executed: true,
        mode: "batch",
        resumed: result.resumed,
        batch_id: result.batchId,
        ready,
        failed,
        skipped,
        clientSkipped: plan.skipped.length,
      },
      null,
      2,
    ),
  );
  return failed > 0 ? 1 : 0;
}
