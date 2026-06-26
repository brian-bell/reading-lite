import type { MarkdownArticle } from "../../import-markdown-lib/parse";
import { runBatchPipeline, type BatchRunDeps, type BatchRunResult } from "./run";
import { r2ReadDeps } from "./r2-reads";
import { prepareFreshMarkdown, type FreshDisposition } from "./prepare-fresh-markdown";
import { activateFreshTargets } from "./activation-phase";

// The fresh-markdown bulk path reuses the whole batch tail (similar → submit →
// poll → write); it only adds `newId` for minting unclaimed-URL readings (R2 read
// helpers are derived from deps.r2) and an optional `limit` that caps how many
// readings are actually submitted.
export interface FreshMarkdownRunDeps extends BatchRunDeps {
  newId(): string;
  // Cap on submitted readings, applied *after* ownership resolution so skipped
  // ready/pending owners never consume the budget (re-runs keep making progress).
  limit?: number;
}

export interface FreshMarkdownRunResult extends BatchRunResult {
  // Per-article verdicts (empty on a resume — the sidecar drives the work).
  dispositions: FreshDisposition[];
}

// Ingest a directory of fresh markdown articles through the Anthropic Message
// Batch API: resolve by-url ownership (skip ready/pending owners, re-ingest
// failed owners in place, mint new ids for unclaimed URLs), then run the shared
// pipeline. A live sidecar resumes the in-flight batch instead of re-planning.
export async function runFreshMarkdownBatch(
  articles: MarkdownArticle[],
  deps: FreshMarkdownRunDeps,
): Promise<FreshMarkdownRunResult> {
  // Capture the plan so the result can report what was skipped vs ingested. The
  // closure runs only on a fresh run (runBatchPipeline calls `produce` after its
  // resume check), so a resume never re-reads the directory or re-resolves
  // ownership — dispositions stay empty.
  let dispositions: FreshDisposition[] = [];

  const base = await runBatchPipeline(async () => {
    const plan = await prepareFreshMarkdown(articles, {
      ...r2ReadDeps(deps.r2),
      newId: deps.newId,
      now: deps.now,
    });
    dispositions = plan.dispositions;
    const toIngest =
      deps.limit === undefined ? plan.toIngest : plan.toIngest.slice(0, deps.limit);
    return { extracted: toIngest, dropped: [] };
  }, {
    ...deps,
    activateExtracted: (targets) =>
      activateFreshTargets(targets, {
        r2: deps.r2,
        model: deps.model,
        now: deps.now,
        saveSidecar: deps.saveSidecar,
        ...(deps.log ? { log: deps.log } : {}),
      }),
  });

  return { ...base, dispositions };
}
