import type { ExtractedContent } from "../../../src/modules/extractor";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
import type { AnthropicBatchClient, OpenAIEmbedClient } from "./clients";
import type { AuditRow } from "../types";
import { readManifest } from "./r2-reads";
import { prepareTargets } from "./prepare";
import { extractTargets } from "./extract-phase";
import { resolveSimilar } from "./similar-phase";
import { submitBatch } from "./submit-phase";
import { pollUntilEnded } from "./poll-phase";
import { writeResults, type WriteReportRow } from "./write-phase";
import type { DroppedTarget, ExtractedTarget, PersistedSidecar, Sidecar } from "./types";
import type { ActivationResult } from "./activation-phase";

export interface BatchRunDeps {
  r2: R2Client;
  vectorize: VectorizeClient;
  batch: AnthropicBatchClient;
  embed: OpenAIEmbedClient;
  // Fresh extraction (browser UA) for readings without saved markdown.
  extract(url: string): Promise<ExtractedContent>;
  model: string;
  now(): string;
  sleep(ms: number): Promise<void>;
  // Resume support: the sidecar persists the in-flight batch so a crashed poll
  // resumes without re-summarizing (cost-safe).
  loadSidecar(): Promise<PersistedSidecar | null>;
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  clearSidecar(): Promise<void>;
  activateExtracted?(targets: ExtractedTarget[]): Promise<ActivationResult>;
  log?(line: string): void;
  poll?: { intervalMs?: number; maxPolls?: number };
}

export interface BatchRunResult {
  report: WriteReportRow[];
  dropped: DroppedTarget[];
  resumed: boolean;
  batchId?: string;
}

// The front-end half of a bulk run: produce the extracted-and-in-hand targets to
// summarize (plus any rows dropped along the way). The recover path resolves
// these from audit rows + R2; the fresh-markdown path builds them from files.
export type ProduceExtracted = () => Promise<{
  extracted: ExtractedTarget[];
  dropped: DroppedTarget[];
}>;

// Orchestrate the shared bulk tail end-to-end:
//   resume? -> poll existing batch -> write
//   fresh  -> produce -> similar -> submit (+sidecar) -> poll -> write
// A live sidecar always means "resume" — we never recreate a batch, so a re-run
// after a crash can't double-bill the summarize step. `produce` runs only on a
// fresh run (after the resume check), so resuming never re-does the front-end.
export async function runBatchPipeline(
  produce: ProduceExtracted,
  deps: BatchRunDeps,
): Promise<BatchRunResult> {
  const log = deps.log ?? (() => {});

  const existing = await deps.loadSidecar();
  if (existing) {
    if (!existing.batchId) {
      // A sidecar with no batch id means a prior run crashed either while
      // activating eager owners or in the create window. Abort rather than risk
      // silently skipping stranded owners or creating a second, double-billed batch.
      throw new Error(
        "found a batch sidecar with no batch id — a previous --batch run may have " +
          "activated eager owners or created (and been billed for) a batch without recording its id. " +
          "Check the Anthropic console, then delete the .batch.json sidecar before retrying.",
      );
    }
    const sidecar = existing as Sidecar;
    log(`Resuming batch ${sidecar.batchId} (${sidecar.targets.length} readings)`);
    const report = await pollAndWrite(sidecar, deps);
    return { report, dropped: [], resumed: true, batchId: sidecar.batchId };
  }

  let { extracted, dropped } = await produce();
  // Surface *why* each reading dropped — a bare "dropped: N" count hides dead
  // origins, missing manifests, etc., leaving the operator no thread to pull.
  for (const d of dropped) {
    log(`  dropped ${d.readingId}: ${d.reason}`);
  }

  let activationSkipped: WriteReportRow[] = [];
  if (deps.activateExtracted) {
    const activated = await deps.activateExtracted(extracted);
    extracted = activated.activated;
    activationSkipped = activated.skipped;
    for (const row of activationSkipped) {
      log(`  skipped ${row.id}: ${row.reason ?? "batch activation skipped"}`);
    }
    if (extracted.length === 0) {
      await deps.clearSidecar();
      log("No readings to summarize after batch activation.");
      return { report: activationSkipped, dropped, resumed: false };
    }
  }

  const summarizeTargets = await resolveSimilar(extracted, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: (vector, opts) => deps.vectorize.query(vector, opts),
  });

  if (summarizeTargets.length === 0) {
    log("No readings to summarize after extraction.");
    return { report: activationSkipped, dropped, resumed: false };
  }

  log(`Submitting Message Batch: ${summarizeTargets.length} readings`);
  const { info, sidecar } = await submitBatch(summarizeTargets, {
    model: deps.model,
    batch: deps.batch,
    putObject: (key, body, contentType) => deps.r2.put(key, body, { contentType }),
    saveSidecar: deps.saveSidecar,
  });
  log(`Batch ${info.id} created; polling for completion...`);

  const report = await pollAndWrite(sidecar, deps);
  return { report: [...activationSkipped, ...report], dropped, resumed: false, batchId: sidecar.batchId };
}

// Recover path: resolve audit rows into targets (existing manifest authoritative)
// and re-extract any whose markdown isn't already captured, then run the pipeline.
export async function runBatch(rows: AuditRow[], deps: BatchRunDeps): Promise<BatchRunResult> {
  return runBatchPipeline(async () => {
    const prepared = await prepareTargets(rows, {
      readManifest: (keyPrefix) => readManifest(deps.r2, keyPrefix),
    });
    const extracted = await extractTargets(prepared.targets, {
      loadExtracted: (kp) => deps.r2.get(`${kp}/extracted.md`),
      extract: deps.extract,
    });
    return {
      extracted: extracted.extracted,
      dropped: [...prepared.dropped, ...extracted.dropped],
    };
  }, deps);
}

async function pollAndWrite(sidecar: Sidecar, deps: BatchRunDeps): Promise<WriteReportRow[]> {
  const ended = await pollUntilEnded(sidecar.batchId, {
    batch: deps.batch,
    sleep: deps.sleep,
    ...(deps.poll?.intervalMs === undefined ? {} : { intervalMs: deps.poll.intervalMs }),
    ...(deps.poll?.maxPolls === undefined ? {} : { maxPolls: deps.poll.maxPolls }),
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (!ended.results_url) {
    throw new Error(`batch ${sidecar.batchId} ended without a results_url`);
  }
  const results = await deps.batch.results(ended.results_url);
  return writeResults(sidecar, results, {
    r2: deps.r2,
    vectorize: deps.vectorize,
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    now: deps.now,
    ...(deps.log ? { log: deps.log } : {}),
  });
}
