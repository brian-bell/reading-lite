import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import type { ExtractedContent } from "../../../src/modules/extractor";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
import type { AnthropicBatchClient, OpenAIEmbedClient } from "./clients";
import type { AuditRow } from "../types";
import { prepareTargets } from "./prepare";
import { extractTargets } from "./extract-phase";
import { resolveSimilar } from "./similar-phase";
import { submitBatch } from "./submit-phase";
import { pollUntilEnded } from "./poll-phase";
import { writeResults, type WriteReportRow } from "./write-phase";
import type { DroppedTarget, Sidecar } from "./types";

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
  log?(line: string): void;
  poll?: { intervalMs?: number; maxPolls?: number };
}

export interface BatchRunResult {
  report: WriteReportRow[];
  dropped: DroppedTarget[];
  resumed: boolean;
  batchId?: string;
}

// Orchestrate the bulk path end-to-end:
//   resume? -> poll existing batch -> write
//   fresh  -> prepare -> extract -> similar -> submit (+sidecar) -> poll -> write
// A live sidecar always means "resume" — we never recreate a batch, so a re-run
// after a crash can't double-bill the summarize step.
export async function runBatch(rows: AuditRow[], deps: BatchRunDeps): Promise<BatchRunResult> {
  const log = deps.log ?? (() => {});

  const existing = await deps.loadSidecar();
  if (existing) {
    if (!existing.batchId) {
      // A pending sidecar with no batch id means a prior run crashed in the
      // create window: a batch MAY have been created and billed. Abort rather
      // than risk a second, double-billed batch.
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

  const readManifest = async (keyPrefix: string): Promise<Manifest | null> => {
    const raw = await deps.r2.get(`${keyPrefix}/manifest.json`);
    return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
  };

  const prepared = await prepareTargets(rows, { readManifest });
  const extracted = await extractTargets(prepared.targets, {
    loadExtracted: (kp) => deps.r2.get(`${kp}/extracted.md`),
    extract: deps.extract,
  });
  const dropped = [...prepared.dropped, ...extracted.dropped];

  const summarizeTargets = await resolveSimilar(extracted.extracted, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: (vector, opts) => deps.vectorize.query(vector, opts),
  });

  if (summarizeTargets.length === 0) {
    log("No readings to summarize after extraction.");
    return { report: [], dropped, resumed: false };
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
  return { report, dropped, resumed: false, batchId: sidecar.batchId };
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
