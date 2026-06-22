import { resolveSimilar } from "./similar-phase";
import { submitBatch } from "./submit-phase";
import { pollAndWrite, type BatchRunDeps, type BatchRunResult } from "./run";
import type { ExtractedTarget } from "./types";

// The fresh-markdown path never fetches URLs (the markdown is the article), so it
// drops `extract` from the batch deps. Everything else mirrors runBatch.
export type FreshMarkdownRunDeps = Omit<BatchRunDeps, "extract">;

// Orchestrate the markdown-ingest bulk path:
//   resume? -> poll existing batch -> write
//   fresh   -> similar -> submit (+sidecar) -> poll -> write
// A live sidecar always means "resume" — we never recreate a batch, so a re-run
// after a crash can't double-bill the summarize step (mirrors runBatch).
export async function runFreshMarkdownBatch(
  targets: ExtractedTarget[],
  deps: FreshMarkdownRunDeps,
): Promise<BatchRunResult> {
  const log = deps.log ?? (() => {});

  const existing = await deps.loadSidecar();
  if (existing) {
    if (!existing.batchId) {
      throw new Error(
        "found a pending batch sidecar with no batch id — a previous --batch run " +
          "may have created (and been billed for) a batch without recording its id. " +
          "Check the Anthropic console, then delete the .batch.json sidecar before retrying.",
      );
    }
    log(`Resuming batch ${existing.batchId} (${existing.targets.length} readings)`);
    const report = await pollAndWrite(existing, deps);
    return { report, dropped: [], resumed: true, batchId: existing.batchId };
  }

  if (targets.length === 0) {
    log("No markdown to summarize.");
    return { report: [], dropped: [], resumed: false };
  }

  const summarizeTargets = await resolveSimilar(targets, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: (vector, opts) => deps.vectorize.query(vector, opts),
  });

  log(`Submitting Message Batch: ${summarizeTargets.length} readings`);
  const { info, sidecar } = await submitBatch(summarizeTargets, {
    model: deps.model,
    batch: deps.batch,
    putObject: (key, body, contentType) => deps.r2.put(key, body, { contentType }),
    saveSidecar: deps.saveSidecar,
  });
  log(`Batch ${info.id} created; polling for completion...`);

  const report = await pollAndWrite(sidecar, deps);
  return { report, dropped: [], resumed: false, batchId: sidecar.batchId };
}
