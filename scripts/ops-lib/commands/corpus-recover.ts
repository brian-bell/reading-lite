// `ops corpus recover` — act on a corpus-audit index.json: reprocess
// recoverable readings via the reading API and re-extract fetch-blocked ones
// locally (browser UA), or route the same work through the offline provider
// Batch API with --batch.
//
// This is the CLI's first remote mutation. Plan mode (no --execute) applies the
// per-reason policy table and prints exactly what each mode would do — no
// submissions, no provider calls, no sidecar writes, no corpus writes, and no
// result annotations back into the audit index. --execute enables the existing
// realtime or batch action path unchanged, including the --sole-writer
// acknowledgement that --batch --execute still requires.

import { parseArgs } from "node:util";
import type { ExtractedContent } from "../../../src/modules/extractor/index";
import { resolveApiTarget, resolveBatchConfig, resolveBucket, type ApiTarget, type BatchConfig } from "../../corpus-lib/config";
import type { ApiResult } from "../../corpus-lib/api";
import { planByAction, recoveryAction } from "../../corpus-lib/policy";
import { shouldPauseAfter } from "../../corpus-lib/throttle";
import { tallyByIds } from "../../corpus-lib/audit";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { BatchRunResult } from "../../corpus-lib/batch/run";
import type { PersistedSidecar } from "../../corpus-lib/batch/types";
import { sidecarPath } from "../../corpus-lib/batch/sidecar";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import type { AuditRow, RecoveryAction } from "../../corpus-lib/types";
import type { ListItem } from "../../corpus-lib/types";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface CorpusRecoverDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, body: string) => Promise<void>;
  resolveApiTarget: (flags: { url?: string; token?: string }) => ApiTarget;
  api: {
    reprocessReading: (id: string, deps: { base: string; token: string; fetch: typeof fetch }) => Promise<ApiResult>;
    importMarkdown: (
      body: { source_url: string; markdown: string; title?: string },
      deps: { base: string; token: string; fetch: typeof fetch },
    ) => Promise<ApiResult>;
  };
  fetch: typeof fetch;
  // Realtime local-extract (browser-header fetch wired in by defaultDeps).
  extract: (url: string) => Promise<ExtractedContent>;
  readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  batch: {
    loadSidecar: (path: string) => Promise<PersistedSidecar | null>;
    clearSidecar: (path: string) => Promise<void>;
    resolveConfig: (flags: { bucket?: string; resumeProvider?: PersistedSidecar["provider"] }) => BatchConfig;
    // Runs the whole batch pipeline (clients + sidecar seams wired in by
    // defaultDeps). The unit tests stub this boundary to cover routing.
    execute: (rows: AuditRow[], cfg: BatchConfig, scPath: string) => Promise<BatchRunResult>;
  };
}

interface Args {
  index: string;
  execute: boolean;
  only?: RecoveryAction;
  limit: number;
  bucket: string;
  url?: string;
  token?: string;
  monitor: boolean;
  wave: number;
  wavePauseMs: number;
  batch: boolean;
  soleWriter: boolean;
  // Raw --bucket flag (undefined when not passed). The read/monitor path uses
  // the defaulted `bucket`; the batch *write* path must pass this through so
  // resolveBatchConfig can fall back to CORPUS_R2_BUCKET (an alternate bucket)
  // rather than being masked by the default production bucket.
  bucketFlag?: string;
}

const ONLY_ACTIONS: RecoveryAction[] = ["reprocess", "local-extract", "skip", "none"];

function parseRecoverArgs(argv: string[], io: CommandIo): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        index: { type: "string" },
        execute: { type: "boolean", default: false },
        only: { type: "string" },
        limit: { type: "string" },
        bucket: { type: "string" },
        url: { type: "string" },
        token: { type: "string" },
        monitor: { type: "boolean", default: false },
        wave: { type: "string" },
        "wave-pause": { type: "string" },
        batch: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.only !== undefined && !ONLY_ACTIONS.includes(values.only as RecoveryAction)) {
    throw new UsageError(`--only must be one of: ${ONLY_ACTIONS.join(", ")}`);
  }
  return {
    index: values.index ?? "./index.json",
    execute: values.execute === true,
    only: values.only as RecoveryAction | undefined,
    limit: values.limit ? Number(values.limit) : Infinity,
    bucket: resolveBucket(values.bucket),
    ...(values.bucket === undefined ? {} : { bucketFlag: values.bucket }),
    url: values.url,
    token: values.token,
    monitor: values.monitor === true,
    wave: parsePositive(values.wave, "wave", Infinity, io),
    wavePauseMs: parsePositive(values["wave-pause"], "wave-pause", 60, io) * 1000,
    batch: values.batch === true,
    soleWriter: values["sole-writer"] === true,
  };
}

// Operator-supplied numbers: a malformed value must not silently disable
// pacing mid-recovery. Warn and fall back to the default instead.
function parsePositive(raw: string | undefined, name: string, fallback: number, io: CommandIo): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    io.stderr(`  ! --${name} "${raw}" is not a positive number; using default ${fallback}`);
    return fallback;
  }
  return n;
}

function printSummary(
  io: CommandIo,
  s: { executed: boolean; reprocessed: number; extracted: number; errors: number; touched: string[] },
): void {
  io.stdout(JSON.stringify({
    executed: s.executed, reprocessed: s.reprocessed, extracted: s.extracted, errors: s.errors, touched: s.touched.length,
  }, null, 2));
}

async function runCorpusRecover(argv: string[], deps: CorpusRecoverDeps): Promise<number> {
  const args = parseRecoverArgs(argv, deps.io);
  const doc = JSON.parse(await deps.readFile(args.index)) as { rows: AuditRow[] };
  const rows = doc.rows ?? [];
  const plan = planByAction(rows);

  deps.io.stderr(
    `Plan from ${args.index}:\n` +
      `  reprocess:     ${plan.reprocess.length}\n` +
      `  local-extract: ${plan["local-extract"].length}\n` +
      `  skip:          ${plan.skip.length}\n` +
      `  none:          ${plan.none.length}\n`,
  );

  const actions: RecoveryAction[] = args.only ? [args.only] : ["reprocess", "local-extract"];

  if (args.batch) {
    return runBatchMode(args, plan, actions, deps);
  }

  if (!args.execute) {
    let remaining = args.limit;
    for (const a of actions) {
      for (const r of plan[a]) {
        if (remaining <= 0) break;
        remaining--;
        deps.io.stderr(`  [plan ${a}] ${r.short} — ${recoveryAction(r).why}`);
      }
    }
    deps.io.stderr("Rerun with --execute to act.");
    printSummary(deps.io, { executed: false, reprocessed: 0, extracted: 0, errors: 0, touched: [] });
    return 0;
  }

  const target = deps.resolveApiTarget({ url: args.url, token: args.token });
  if (!target.token) {
    throw new UsageError("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)");
  }
  const api = { ...target, fetch: deps.fetch };

  const touched: string[] = [];
  let reprocessed = 0;
  let extracted = 0;
  let errors = 0;
  // One cap across the whole batch — --limit bounds total writes, not per-action.
  let remaining = args.limit;
  // Successful submissions across the whole batch, for wave pacing (see
  // throttle.ts). We pace *before* each submission once a wave boundary has been
  // crossed: pausing before (not after) means the final submission never
  // triggers a needless trailing pause, and only enqueued work counts toward a
  // wave (a failed call added no draining pressure).
  let submitted = 0;
  const paceBeforeSubmit = async () => {
    if (shouldPauseAfter(submitted, args.wave)) {
      deps.io.stderr(`  ...${submitted} submitted; pausing ${Math.round(args.wavePauseMs / 1000)}s to let the queue drain`);
      await deps.sleep(args.wavePauseMs);
    }
  };

  if (actions.includes("reprocess")) {
    for (const r of plan.reprocess) {
      if (remaining <= 0) break;
      remaining--;
      await paceBeforeSubmit();
      const res = await deps.api.reprocessReading(r.reading_id, api);
      if (res.outcome === "error") { errors++; (r as any).result = `reprocess error: ${res.error}`; }
      else { reprocessed++; submitted++; touched.push(r.reading_id); (r as any).result = `reprocess: ${res.outcome}`; }
      deps.io.stderr(`  reprocess ${r.short} -> ${res.outcome}${res.error ? " " + res.error : ""}`);
    }
  }

  if (actions.includes("local-extract")) {
    for (const r of plan["local-extract"]) {
      if (remaining <= 0) break;
      remaining--;
      try {
        const ex = await deps.extract(r.url);
        if (ex.content_status !== "captured" || !ex.markdown?.trim()) {
          errors++; (r as any).result = `local-extract failed: ${ex.content_status} (${ex.content_type})`;
          deps.io.stderr(`  local-extract ${r.short} -> no markdown (${ex.content_status})`);
          continue;
        }
        await paceBeforeSubmit();
        const res = await deps.api.importMarkdown(
          { source_url: r.url, markdown: ex.markdown, ...(ex.title ? { title: ex.title } : {}) },
          api,
        );
        if (res.outcome === "error") { errors++; (r as any).result = `import error: ${res.error}`; }
        else { extracted++; submitted++; if (res.id) touched.push(res.id); (r as any).result = `local-extract+import: ${res.outcome} ${res.id ?? ""}`; }
        deps.io.stderr(`  local-extract ${r.short} -> import ${res.outcome}${res.id ? " " + res.id : ""}`);
      } catch (e) {
        errors++; (r as any).result = `local-extract threw: ${e instanceof Error ? e.message : String(e)}`;
        deps.io.stderr(`  local-extract ${r.short} -> ERROR ${(e as Error).message}`);
      }
    }
  }

  await deps.writeFile(args.index, JSON.stringify(doc, null, 2) + "\n");

  if (args.monitor && touched.length > 0) {
    deps.io.stderr(`\nMonitoring ${touched.length} readings...`);
    for (let i = 0; i < 60; i++) {
      const items = await deps.readListIndex({ bucket: args.bucket, remote: true });
      const t = tallyByIds(items, touched);
      const ts = new Date(deps.now()).toISOString().slice(11, 19);
      deps.io.stderr(`  ${ts} ready=${t.ready} pending=${t.pending} failed=${t.failed} absent=${t.absent}`);
      if (t.pending === 0) break;
      await deps.sleep(15_000);
    }
  }

  printSummary(deps.io, { executed: true, reprocessed, extracted, errors, touched });
  return errors > 0 ? 1 : 0;
}

// Bulk path: summarize reprocess + local-extract rows through the configured
// provider's Batch API. --wave is irrelevant here (no realtime burst to pace).
async function runBatchMode(
  args: Args,
  plan: Record<RecoveryAction, AuditRow[]>,
  actions: RecoveryAction[],
  deps: CorpusRecoverDeps,
): Promise<number> {
  if (Number.isFinite(args.wave)) {
    deps.io.stderr("  ! --wave is ignored in --batch mode (no realtime queue to pace)");
  }

  // Sole-writer preflight (issue #68): activated targets eagerly claim by-url
  // slots, but that is defense-in-depth rather than a replacement for pausing
  // and draining the realtime writer. Resumes are gated too. No-op for plan mode.
  const verdict = soleWriterGuard({ execute: args.execute, acknowledged: args.soleWriter, tool: "ops corpus recover --batch" });
  if (verdict.message) deps.io.stderr(verdict.message);
  if (!verdict.proceed) return 2;

  // reprocess + local-extract both reduce to extract→summarize→embed→write here.
  const batchRows: AuditRow[] = [];
  let remaining = args.limit;
  for (const a of actions) {
    if (a !== "reprocess" && a !== "local-extract") continue;
    for (const r of plan[a]) {
      if (remaining <= 0) break;
      remaining--;
      batchRows.push(r);
    }
  }

  const scPath = sidecarPath(args.index);
  const existing = await deps.batch.loadSidecar(scPath);

  if (!args.execute) {
    if (existing) {
      deps.io.stderr(`  [plan batch] would RESUME in-flight batch ${existing.batchId} (${existing.targets.length} readings) from ${scPath}`);
    } else {
      for (const r of batchRows) {
        deps.io.stderr(`  [plan batch] ${r.short} — summarize via the configured provider's Batch API (async)`);
      }
      deps.io.stderr(`  [plan batch] would submit ${batchRows.length} reading(s) in one batch`);
    }
    deps.io.stderr("Rerun with --execute (and --sole-writer) to act.");
    printSummary(deps.io, { executed: false, reprocessed: 0, extracted: 0, errors: 0, touched: [] });
    return 0;
  }

  let cfg: BatchConfig;
  try {
    cfg = deps.batch.resolveConfig({
      ...(args.bucketFlag === undefined ? {} : { bucket: args.bucketFlag }),
      ...(existing === null ? {} : { resumeProvider: existing.provider }),
    });
  } catch (e) {
    deps.io.stderr(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const result = await deps.batch.execute(batchRows, cfg, scPath);

  // The batch finished and results are written — the sidecar is no longer needed.
  await deps.batch.clearSidecar(scPath);

  const ready = result.report.filter((r) => r.status === "ready").length;
  const failed = result.report.filter((r) => r.status === "failed").length;
  const skipped = result.report.filter((r) => r.status === "skipped").length;
  deps.io.stdout(
    JSON.stringify(
      {
        executed: true,
        mode: "batch",
        resumed: result.resumed,
        batch_id: result.batchId,
        ready,
        failed,
        skipped,
        dropped: result.dropped.length,
      },
      null,
      2,
    ),
  );
  return failed > 0 ? 1 : 0;
}

function defaultDeps(io: CommandIo): CorpusRecoverDeps {
  // Heavy seams load lazily so `ops --help` and unit tests never pull in
  // wrangler, provider clients, or the extractor.
  return {
    io,
    readFile: async (p) => {
      const { promises: fs } = await import("node:fs");
      return fs.readFile(p, "utf8");
    },
    writeFile: async (p, body) => {
      const { promises: fs } = await import("node:fs");
      await fs.writeFile(p, body);
    },
    resolveApiTarget,
    api: {
      reprocessReading: async (id, apiDeps) => {
        const { reprocessReading } = await import("../../corpus-lib/api");
        return reprocessReading(id, apiDeps);
      },
      importMarkdown: async (body, apiDeps) => {
        const { importMarkdown } = await import("../../corpus-lib/api");
        return importMarkdown(body, apiDeps);
      },
    },
    fetch: globalThis.fetch,
    extract: async (url) => {
      const { extractFromUrl } = await import("../../../src/modules/extractor/index");
      const { makeBrowserFetch } = await import("../../corpus-lib/browser-fetch");
      return extractFromUrl(url, {
        fetch: makeBrowserFetch(globalThis.fetch),
        timeoutMs: 30_000,
        maxBytes: 30_000_000,
      });
    },
    readListIndex: async (r2Deps) => {
      const { readListIndex } = await import("../../corpus-lib/wrangler-r2");
      return readListIndex(r2Deps);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    batch: {
      loadSidecar: async (p) => {
        const { loadSidecar } = await import("../../corpus-lib/batch/sidecar");
        return loadSidecar(p);
      },
      clearSidecar: async (p) => {
        const { clearSidecar } = await import("../../corpus-lib/batch/sidecar");
        await clearSidecar(p);
      },
      resolveConfig: (flags) => resolveBatchConfig(flags),
      execute: async (rows, cfg, scPath) => {
        const { randomUUID } = await import("node:crypto");
        const { runBatch } = await import("../../corpus-lib/batch/run");
        const { makeR2Client, makeVectorizeClient } = await import("../../lib/cf-clients");
        const { makeAnthropicBatchClient, makeOpenAIBatchClient, makeOpenAIEmbedClient } =
          await import("../../corpus-lib/batch/clients");
        const { loadSidecar, saveSidecar, clearSidecar, saveInputJsonl, loadInputJsonl } =
          await import("../../corpus-lib/batch/sidecar");
        const { extractFromUrl } = await import("../../../src/modules/extractor/index");
        const { makeBrowserFetch } = await import("../../corpus-lib/browser-fetch");
        const fetchFn = globalThis.fetch;
        const browserFetch = makeBrowserFetch(fetchFn);
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        return runBatch(rows, {
          r2: makeR2Client(cfg.r2, fetchFn),
          vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
          ...(cfg.anthropicApiKey
            ? { batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }) }
            : {}),
          openaiBatch: makeOpenAIBatchClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
          embed: makeOpenAIEmbedClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
          extract: (url: string) =>
            extractFromUrl(url, { fetch: browserFetch, timeoutMs: 30_000, maxBytes: 30_000_000 }),
          configuredProvider: cfg.summarizerProvider,
          model: cfg.summarizerProvider === "openai" ? cfg.openaiModel : cfg.anthropicModel,
          reasoningEffort: cfg.openaiReasoningEffort,
          newRunId: randomUUID,
          now: () => new Date().toISOString(),
          sleep,
          loadSidecar: () => loadSidecar(scPath),
          saveSidecar: (s) => saveSidecar(scPath, s),
          clearSidecar: () => clearSidecar(scPath),
          saveInputJsonl: (jsonl) => saveInputJsonl(scPath, jsonl),
          loadInputJsonl: () => loadInputJsonl(scPath),
          sidecarFilePath: scPath,
          log: (line) => io.stderr(line),
        });
      },
    },
  };
}

export const corpusRecoverCommand: CommandDefinition<CorpusRecoverDeps> = {
  group: "corpus",
  name: "recover",
  summary: "Act on an audit index.json: reprocess or re-extract non-ready readings",
  safety: "plan-first",
  helpText: `Acts on a corpus-audit index.json: reprocesses recoverable readings and
re-extracts fetch-blocked ones locally. Plans by default; --execute submits
(realtime queue, or the provider Batch API with --batch) and triggers paid
summarization/embedding.

Options:
  --index <path>    Audit index.json. Default: ./index.json.
  --execute         Actually perform the actions (otherwise prints the plan).
  --only <action>   Restrict to one action: reprocess | local-extract | skip.
  --limit <n>       Cap how many rows to act on.
  --bucket <name>   R2 bucket for --monitor reads. Default: reading-lite.
  --url <url>       Reading API base. Default: READER_URL, then production.
  --token <token>   Bearer token. Default: READER_API_TOKEN, then .prd/.dev.vars.
  --monitor         After executing, poll until the touched readings finish.
  --wave <n>        Pause between every n submissions so the queue can drain
                    (prevents swamping upstream rate limits). Default: unbounded.
  --wave-pause <s>  Seconds to pause at each wave boundary. Default: 60.
  --batch           Bulk path: summarize reprocess+local-extract rows via the
                    configured provider's Batch API (OpenAI by default, or
                    Anthropic) instead of the realtime queue. --wave is ignored.
                    Resumes an in-flight batch from ./index.batch.json. Needs R2
                    + Vectorize creds and OPENAI_API_KEY for embeddings;
                    ANTHROPIC_API_KEY only for an Anthropic start/resume.
                    Sidecars pin provider/model/effort; there is no fallback.
  --sole-writer     Required with --batch --execute: assert the realtime writer
                    is paused/drained. Eager by-url claims are defense-in-depth,
                    not a replacement for excluding the realtime writer.
                    Refuses without the acknowledgment.
  --help            Show this message.

Policy (per audit row): stranded/transient/5xx/summarize hiccups -> reprocess;
fetch-blocked 403/429 + oversized -> local-extract + markdown import;
dead links / paywalls / non-articles / teasers / thin-source rejects -> skip;
reddit -> skip (reddit-import skill); thin YouTube floors -> skip
(youtube-import skill).`,
  defaultDeps,
  run: runCorpusRecover,
};
