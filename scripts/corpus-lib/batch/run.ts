import type { ExtractedContent } from "../../../src/modules/extractor";
import type { R2Client, VectorizeClient } from "../../lib/cf-clients";
import type { AnthropicBatchClient, OpenAIEmbedClient } from "./clients";
import type { AuditRow } from "../types";
import { findByUrlInList, readManifest } from "./r2-reads";
import { prepareTargets } from "./prepare";
import { extractTargets } from "./extract-phase";
import { resolveSimilar } from "./similar-phase";
import { claimByUrlSlots } from "./claim-phase";
import { makePendingHeartbeat } from "./heartbeat-phase";
import { assertBatchWithinSizeCap, buildSummarizeRequest, submitBatch } from "./submit-phase";
import { pollUntilEnded } from "./poll-phase";
import { writeResults, type WriteReportRow } from "./write-phase";
import type { DroppedTarget, ExtractedTarget, Sidecar } from "./types";

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
  poll?: { intervalMs?: number; maxPolls?: number; heartbeatMs?: number };
  // Anthropic batch payload safety cap in bytes (default MAX_BATCH_BYTES).
  // Injectable so tests can drive the oversize-abort path without 200MB of data.
  maxBatchBytes?: number;
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

  const { extracted, dropped } = await produce();
  // Surface *why* each reading dropped — a bare "dropped: N" count hides dead
  // origins, missing manifests, etc., leaving the operator no thread to pull.
  for (const d of dropped) {
    log(`  dropped ${d.readingId}: ${d.reason}`);
  }

  // Validate the batch payload size BEFORE claiming any by-url slots: an oversize
  // batch must abort WITHOUT mutating R2, because an eager pending claim would
  // strand the operator's `--limit` rerun (prepareFreshMarkdown skips pending
  // owners even past TTL). Checked here on the extracted targets (similar context
  // isn't resolved yet) with an empty similar block — the extracted markdown
  // dominates the request body and there is ~56MB of headroom under Anthropic's
  // 256MB limit, so omitting the small per-reading similar context is safe.
  if (extracted.length > 0) {
    assertBatchWithinSizeCap(
      extracted.map((et) => buildSummarizeRequest({ extracted: et, similar: [], queryEmbedTokens: 0 }, deps.model)),
      deps.maxBatchBytes,
    );
  }

  // Eagerly claim the by-url slot (pending manifest + by-url + by-id + list row)
  // for every target BEFORE the similarity phase (which embeds every target +
  // queries Vectorize — a paid, possibly rate-limited pre-submit window) and the
  // (minutes-to-hours) Message Batch — the offline mirror of the online
  // activateAttempt. An online submit for one of these URLs during that whole
  // pre-submit window then sees an owned pending reading and defers instead of
  // racing (issue #66). Targets whose slot is owned by a different reading (or are
  // already ready) are deferred (dropped + logged), never summarized — and never
  // embedded, since we claim first.
  const { kept, deferred } = await claimByUrlSlots(extracted, {
    r2: deps.r2,
    now: deps.now,
    ...(deps.log ? { log: deps.log } : {}),
  });

  // Deferred targets (slot owned by another writer / damaged, or already ready)
  // were never summarized — surface them in the machine-readable `dropped` list,
  // not just the log, so a CLI/JSON summary can't report them as silently
  // accounted for. `reason` is already self-describing per target.
  const allDropped: DroppedTarget[] = [
    ...dropped,
    ...deferred.map((d) => ({ readingId: d.id, reason: d.reason })),
  ];

  if (kept.length === 0) {
    log("No readings to summarize after extraction and slot claim.");
    return { report: [], dropped: allDropped, resumed: false };
  }

  // Resolve similar-readings context only for the kept (claimed) targets — the
  // deferred ones are never embedded.
  const summarizeTargets = await resolveSimilar(kept, {
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    query: (vector, opts) => deps.vectorize.query(vector, opts),
  });

  log(`Submitting Message Batch: ${kept.length} readings${deferred.length ? ` (${deferred.length} deferred)` : ""}`);
  const { info, sidecar } = await submitBatch(summarizeTargets, {
    model: deps.model,
    batch: deps.batch,
    saveSidecar: deps.saveSidecar,
  });
  log(`Batch ${info.id} created; polling for completion...`);

  const report = await pollAndWrite(sidecar, deps);
  return { report, dropped: allDropped, resumed: false, batchId: sidecar.batchId };
}

// Recover path: resolve audit rows into targets (existing manifest authoritative)
// and re-extract any whose markdown isn't already captured, then run the pipeline.
export async function runBatch(rows: AuditRow[], deps: BatchRunDeps): Promise<BatchRunResult> {
  return runBatchPipeline(async () => {
    const prepared = await prepareTargets(rows, {
      readManifest: (keyPrefix) => readManifest(deps.r2, keyPrefix),
      findByUrlInList: (url, urlHash) => findByUrlInList(deps.r2, url, urlHash),
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
  // Keep the eager pending manifests fresh for the whole in-flight window so an
  // online submit never annotates them stale and reprocesses them (issue #66).
  const heartbeat = makePendingHeartbeat(sidecar, {
    r2: deps.r2,
    now: deps.now,
    ...(deps.poll?.heartbeatMs === undefined ? {} : { intervalMs: deps.poll.heartbeatMs }),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const ended = await pollUntilEnded(sidecar.batchId, {
    batch: deps.batch,
    sleep: deps.sleep,
    onTick: heartbeat,
    ...(deps.poll?.intervalMs === undefined ? {} : { intervalMs: deps.poll.intervalMs }),
    ...(deps.poll?.maxPolls === undefined ? {} : { maxPolls: deps.poll.maxPolls }),
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (!ended.results_url) {
    throw new Error(`batch ${sidecar.batchId} ended without a results_url`);
  }
  // Refresh once more before the terminal write. If the batch was already `ended`
  // on the FIRST poll (a resume after the process died while the batch finished),
  // pollUntilEnded returned before any onTick fired, so the eager pendings — by
  // then possibly aged past PENDING_TTL_SECONDS — were never refreshed. Without
  // this, an online submit during the results-fetch/embed/write window could
  // reprocess a stale pending and reopen the issue #66 race. heartbeat() is gated,
  // so when polling already refreshed them this is a no-op.
  await heartbeat();
  const results = await deps.batch.results(ended.results_url);
  return writeResults(sidecar, results, {
    r2: deps.r2,
    vectorize: deps.vectorize,
    embedMany: (inputs) => deps.embed.embedMany(inputs),
    now: deps.now,
    ...(deps.log ? { log: deps.log } : {}),
  });
}
