import type { ExtractedContent } from "../../../src/modules/extractor";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
import type { AnthropicBatchClient, OpenAIEmbedClient } from "./clients";
import type { AuditRow } from "../types";
import { readManifest } from "./r2-reads";
import { prepareTargets } from "./prepare";
import { extractTargets } from "./extract-phase";
import { resolveSimilar } from "./similar-phase";
import { pendingSidecarForTargets, submitBatch } from "./submit-phase";
import { pollUntilEnded } from "./poll-phase";
import { writeResults, type WriteReportRow } from "./write-phase";
import type { ClaimRollback, DroppedTarget, ExtractedTarget, Sidecar, SummarizeTarget } from "./types";
import { restoreClaimRollback } from "./eager-claim";

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
  loadSidecar(): Promise<Sidecar | null>;
  saveSidecar(sidecar: Sidecar): Promise<void>;
  clearSidecar?(): Promise<void>;
  beforeSubmit?(targets: SummarizeTarget[]): Promise<BeforeSubmitResult>;
  log?(line: string): void;
  poll?: { intervalMs?: number; maxPolls?: number };
}

export interface BeforeSubmitResult {
  targets: SummarizeTarget[];
  claimRollback?: ClaimRollback;
  rollback?(): Promise<void>;
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
      if (existing.claimRollback && existing.claimRollbackPhase === "pre_create") {
        log(`Recovering pending pre-create claims (${existing.targets.length} readings)`);
        await restoreClaimRollback({ r2: deps.r2 }, existing.claimRollback);
        if (!deps.clearSidecar) {
          throw new Error("found a recoverable pending batch sidecar but no clearSidecar hook is configured");
        }
        await deps.clearSidecar();
        throw new Error("recovered pre-create eager claims; rerun corpus-ingest to replan and submit");
      } else {
        // A pending sidecar with no batch id means a prior run crashed in the
        // create window: a batch MAY have been created and billed. Abort rather
        // than risk a second, double-billed batch.
        const claimGuidance = existing.claimRollback
          ? " This sidecar also records eager R2 ownership claims; do NOT delete it by itself. " +
            "If Anthropic shows a batch was created, record that batch id in the sidecar and rerun. " +
            "If no batch exists, restore the sidecar's claimRollback snapshot before clearing it."
          : " Check the Anthropic console, then delete the .batch.json sidecar before retrying.";
        throw new Error(
          "found a pending batch sidecar with no batch id — a previous --batch run " +
            "may have created (and been billed for) a batch without recording its id." +
            claimGuidance,
        );
      }
    } else {
      log(`Resuming batch ${existing.batchId} (${existing.targets.length} readings)`);
      const report = await pollAndWrite(existing, deps);
      return { report, dropped: [], resumed: true, batchId: existing.batchId };
    }
  }

  const { extracted, dropped } = await produce();
  // Surface *why* each reading dropped — a bare "dropped: N" count hides dead
  // origins, missing manifests, etc., leaving the operator no thread to pull.
  for (const d of dropped) {
    log(`  dropped ${d.readingId}: ${d.reason}`);
  }

  let summarizeTargets = await resolveSimilar(extracted, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: (vector, opts) => deps.vectorize.query(vector, opts),
  });
  let beforeSubmitRollback: (() => Promise<void>) | undefined;
  let beforeSubmitClaimRollback: ClaimRollback | undefined;
  if (deps.beforeSubmit) {
    let beforeSubmit: BeforeSubmitResult;
    try {
      beforeSubmit = await deps.beforeSubmit(summarizeTargets);
    } catch (err) {
      throw err;
    }
    summarizeTargets = beforeSubmit.targets;
    beforeSubmitRollback = beforeSubmit.rollback;
    beforeSubmitClaimRollback = beforeSubmit.claimRollback;
  }

  if (summarizeTargets.length === 0) {
    if (beforeSubmitRollback) await deps.clearSidecar?.();
    log("No readings to summarize after extraction.");
    return { report: [], dropped, resumed: false };
  }

  log(`Submitting Message Batch: ${summarizeTargets.length} readings`);
  let pendingSidecarSaved = false;
  if (beforeSubmitRollback) {
    try {
      await deps.saveSidecar({
        ...pendingSidecarForTargets(summarizeTargets, deps.model),
        ...(beforeSubmitClaimRollback
          ? { claimRollback: beforeSubmitClaimRollback, claimRollbackPhase: "pre_create" as const }
          : {}),
      });
      pendingSidecarSaved = true;
    } catch (err) {
      await beforeSubmitRollback();
      await deps.clearSidecar?.();
      throw err;
    }
  }
  let info;
  let sidecar;
  let createStarted = false;
  try {
    const submitted = await submitBatch(summarizeTargets, {
      model: deps.model,
      batch: {
        ...deps.batch,
        create: async (requests) => {
          createStarted = true;
          return deps.batch.create(requests);
        },
      },
      ...(beforeSubmitClaimRollback ? { claimRollback: beforeSubmitClaimRollback } : {}),
      putObject: (key, body, contentType) => deps.r2.put(key, body, { contentType }),
      saveSidecar: async (s) => {
        await deps.saveSidecar(s);
        if (s.batchId === "") pendingSidecarSaved = true;
      },
    });
    info = submitted.info;
    sidecar = submitted.sidecar;
  } catch (err) {
    if (!createStarted) {
      await beforeSubmitRollback?.();
      if (pendingSidecarSaved) await deps.clearSidecar?.();
    }
    throw err;
  }
  log(`Batch ${info.id} created; polling for completion...`);

  const report = await pollAndWrite(sidecar, deps);
  return { report, dropped, resumed: false, batchId: sidecar.batchId };
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
