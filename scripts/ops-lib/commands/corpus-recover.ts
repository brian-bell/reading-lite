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
import { operatorTenantSelector, type OperatorTenant } from "../../corpus-lib/tenant";
import { requireOperatorTenant } from "../tenant-flag";
import {
  assertOperatorLedgerAvailable,
  operatorVectorLedger,
} from "../../account-lib/operator-ledger";
import {
  classifyOutcome,
  readingApiFor,
  type ReadingApi,
  type ReadingApiOutcome,
} from "../../lib/reading-api";
import { planByAction, recoveryAction } from "../../corpus-lib/policy";
import { verifyRealtimeTenant } from "../../corpus-lib/realtime-tenant";
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
  // Constructed only on the execute path (plan mode never touches the network).
  makeApi: (
    target: ApiTarget,
    opts?: { expectedTenant?: string },
  ) => Pick<ReadingApi, "reprocess" | "importMarkdown" | "whoami">;
  // Realtime local-extract (browser-header fetch wired in by defaultDeps).
  extract: (url: string) => Promise<ExtractedContent>;
  readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  batch: {
    loadSidecar: (path: string) => Promise<PersistedSidecar | null>;
    clearSidecar: (path: string) => Promise<void>;
    resolveConfig: (flags: {
      bucket?: string;
      resumeProvider?: PersistedSidecar["provider"];
      tenant: OperatorTenant;
    }) => BatchConfig;
    // Runs the whole batch pipeline (clients + sidecar seams wired in by
    // defaultDeps). The unit tests stub this boundary to cover routing.
    execute: (rows: AuditRow[], cfg: BatchConfig, scPath: string) => Promise<BatchRunResult>;
  };
}

interface Args {
  index: string;
  tenant?: string;
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
        tenant: { type: "string" },
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
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
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
  s: { executed: boolean; reprocessed: number; extracted: number; inProgress: number; errors: number; touched: string[] },
): void {
  io.stdout(JSON.stringify({
    executed: s.executed, reprocessed: s.reprocessed, extracted: s.extracted,
    in_progress: s.inProgress, errors: s.errors, touched: s.touched.length,
  }, null, 2));
}

// An initializing owner or an active-attempt conflict means work is already in
// flight for this reading — the recover run should report it as in progress
// and move on, not count it as a failure. Other conflicts (missing_markdown —
// the only one a force reprocess can produce besides active_attempt) are real
// failures and fall through to the error bucket.
function isInProgress(out: ReadingApiOutcome): boolean {
  return (
    out.kind === "initializing" ||
    (out.kind === "conflict" && out.reason === "active_attempt")
  );
}

function isAccepted(out: ReadingApiOutcome): boolean {
  return out.kind === "activated" || out.kind === "existing";
}

function describeError(out: ReadingApiOutcome): string {
  return classifyOutcome(out).error ?? out.kind;
}

async function runCorpusRecover(argv: string[], deps: CorpusRecoverDeps): Promise<number> {
  const args = parseRecoverArgs(argv, deps.io);
  const tenant = requireOperatorTenant(args.tenant);
  const doc = JSON.parse(await deps.readFile(args.index)) as {
    rows: AuditRow[];
    tenant?: string;
  };
  // Audit provenance (s1k.4.3): recover acts only on an audit taken under the
  // SAME tenant selector, else tenant A's audited URLs would be extracted and
  // written under tenant B's namespace. Legacy audits (no stamp) are global.
  const auditTenant = doc.tenant ?? "global";
  if (auditTenant !== operatorTenantSelector(tenant)) {
    deps.io.stderr(
      `audit ${args.index} was taken under tenant '${auditTenant}' but --tenant is '${operatorTenantSelector(tenant)}'; ` +
        "re-run corpus audit under the selected tenant, or pass the audit's tenant.",
    );
    return 1;
  }
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
    return runBatchMode(args, tenant, plan, actions, deps);
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
    deps.io.stderr(
      "Rerun with --execute to act. Realtime --execute first verifies the bearer token's " +
        "tenant against --tenant via GET /api/whoami and refuses on mismatch.",
    );
    printSummary(deps.io, { executed: false, reprocessed: 0, extracted: 0, inProgress: 0, errors: 0, touched: [] });
    return 0;
  }

  const target = deps.resolveApiTarget({ url: args.url, token: args.token });
  if (!target.token) {
    throw new UsageError("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)");
  }
  // Realtime API writes act as the BEARER TOKEN's tenant, not --tenant (which
  // scopes only this command's direct R2 reads). Ask the worker who the token
  // is and refuse any selector/principal/gate combination where writes would
  // land somewhere other than the selected layout — the matrix lives in
  // verifyRealtimeTenant (realtime-tenant.ts, reading-lite-1xk). The
  // expectedTenant pin then re-asserts the verified layout on every
  // subsequent write (x-expected-tenant), so a gate flip or rolling deploy
  // mid-run is rejected by the worker atomically, not just at this preflight.
  const api = deps.makeApi(target, { expectedTenant: operatorTenantSelector(tenant) });
  const verdict = verifyRealtimeTenant(tenant, await api.whoami());
  if (!verdict.ok) {
    deps.io.stderr(verdict.reason);
    return 1;
  }
  deps.io.stderr(verdict.note);

  const touched: string[] = [];
  let reprocessed = 0;
  let extracted = 0;
  let inProgress = 0;
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
      const res = await api.reprocess(r.reading_id, { force: true });
      if (isAccepted(res)) {
        reprocessed++; submitted++; touched.push(r.reading_id); (r as any).result = `reprocess: ${res.kind}`;
        deps.io.stderr(`  reprocess ${r.short} -> ${res.kind}`);
      } else if (isInProgress(res)) {
        inProgress++; (r as any).result = `reprocess skipped: in progress (${res.kind})`;
        deps.io.stderr(`  reprocess ${r.short} -> in progress (${res.kind})`);
      } else {
        errors++; (r as any).result = `reprocess error: ${describeError(res)}`;
        deps.io.stderr(`  reprocess ${r.short} -> error ${describeError(res)}`);
      }
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
        const res = await api.importMarkdown(
          { source_url: r.url, markdown: ex.markdown, ...(ex.title ? { title: ex.title } : {}) },
        );
        const resId = "id" in res && typeof res.id === "string" ? res.id : undefined;
        if (isAccepted(res)) {
          extracted++; submitted++; if (resId) touched.push(resId);
          (r as any).result = `local-extract+import: ${res.kind} ${resId ?? ""}`;
          deps.io.stderr(`  local-extract ${r.short} -> import ${res.kind}${resId ? " " + resId : ""}`);
        } else if (isInProgress(res)) {
          inProgress++; (r as any).result = `import skipped: in progress (${res.kind})`;
          deps.io.stderr(`  local-extract ${r.short} -> import in progress (${res.kind})`);
        } else {
          errors++; (r as any).result = `import error: ${describeError(res)}`;
          deps.io.stderr(`  local-extract ${r.short} -> import error ${describeError(res)}`);
        }
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
      const items = await deps.readListIndex({ bucket: args.bucket, keyRoot: tenant.keyRoot, remote: true });
      const t = tallyByIds(items, touched);
      const ts = new Date(deps.now()).toISOString().slice(11, 19);
      deps.io.stderr(`  ${ts} ready=${t.ready} pending=${t.pending} failed=${t.failed} absent=${t.absent}`);
      if (t.pending === 0) break;
      await deps.sleep(15_000);
    }
  }

  printSummary(deps.io, { executed: true, reprocessed, extracted, inProgress, errors, touched });
  return errors > 0 ? 1 : 0;
}

// Bulk path: summarize reprocess + local-extract rows through the configured
// provider's Batch API. --wave is irrelevant here (no realtime burst to pace).
async function runBatchMode(
  args: Args,
  tenant: OperatorTenant,
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

  // Same tenant pinning as ops corpus ingest: an in-flight batch resumes only
  // under the tenant selector it was submitted with (legacy sidecars = global).
  const selector = operatorTenantSelector(tenant);
  if (existing && (existing.tenant ?? "global") !== selector) {
    deps.io.stderr(
      `sidecar ${scPath} belongs to tenant '${existing.tenant ?? "global"}' but --tenant is '${selector}'; ` +
        "resume with the sidecar's tenant, or clear the sidecar after reconciling the batch manually.",
    );
    return 1;
  }

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
    printSummary(deps.io, { executed: false, reprocessed: 0, extracted: 0, inProgress: 0, errors: 0, touched: [] });
    return 0;
  }

  let cfg: BatchConfig;
  try {
    cfg = deps.batch.resolveConfig({
      ...(args.bucketFlag === undefined ? {} : { bucket: args.bucketFlag }),
      ...(existing === null ? {} : { resumeProvider: existing.provider }),
      tenant,
    });
    // Refuse a tenant/bucket pair the vector ledger cannot serve, before the
    // batch is submitted rather than at the first upsert (issue #195 S3).
    assertOperatorLedgerAvailable(cfg.tenant, cfg.r2.bucket);
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
    makeApi: (target, opts) =>
      readingApiFor({ ...target, fetch: globalThis.fetch, ...(opts ?? {}) }),
    extract: async (url) => {
      const { extractFromUrl } = await import("../../../src/modules/extractor/index");
      const { makeBrowserFetch } = await import("../../corpus-lib/browser-fetch");
      const { lookup: dnsLookup } = await import("node:dns/promises");
      return extractFromUrl(url, {
        fetch: makeBrowserFetch(globalThis.fetch),
        lookup: (hostname) => dnsLookup(hostname, { all: true }),
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
        const { makeR2Client, makeVectorizeClient, withKeyRoot } = await import("../../lib/cf-clients");
        const { makeAnthropicBatchClient, makeOpenAIBatchClient, makeOpenAIEmbedClient } =
          await import("../../corpus-lib/batch/clients");
        const { loadSidecar, saveSidecar, clearSidecar, saveInputJsonl, loadInputJsonl } =
          await import("../../corpus-lib/batch/sidecar");
        const { extractFromUrl } = await import("../../../src/modules/extractor/index");
        const { makeBrowserFetch } = await import("../../corpus-lib/browser-fetch");
        const { lookup: dnsLookup } = await import("node:dns/promises");
        const fetchFn = globalThis.fetch;
        const browserFetch = makeBrowserFetch(fetchFn);
        const lookup = (hostname: string) => dnsLookup(hostname, { all: true });
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        return runBatch(rows, {
        // Ledger every vector this batch writes (issue #195 S3). Resolved from
        // the run's own tenant and bucket; the no-op for --tenant global, which
        // no account wipe addresses.
        ledger: operatorVectorLedger({ tenant: cfg.tenant, bucket: cfg.r2.bucket, execute: true }),
          r2: withKeyRoot(makeR2Client(cfg.r2, fetchFn), cfg.keyRoot),
          vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
          ...(cfg.anthropicApiKey
            ? { batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }) }
            : {}),
          openaiBatch: makeOpenAIBatchClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
          embed: makeOpenAIEmbedClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
          extract: (url: string) =>
            extractFromUrl(url, {
              fetch: browserFetch,
              lookup,
              timeoutMs: 30_000,
              maxBytes: 30_000_000,
            }),
          configuredProvider: cfg.summarizerProvider,
          model: cfg.summarizerProvider === "openai" ? cfg.openaiModel : cfg.anthropicModel,
          reasoningEffort: cfg.openaiReasoningEffort,
          anthropicReasoningEffort: cfg.anthropicReasoningEffort,
          newRunId: randomUUID,
          now: () => new Date().toISOString(),
          sleep,
          loadSidecar: () => loadSidecar(scPath),
          // Stamp the tenant selector on every checkpoint (resume guard above).
          saveSidecar: (s) => saveSidecar(scPath, { ...s, tenant: cfg.tenantSelector }),
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
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant
                       layout. Scopes this command's direct R2 reads and the batch
                       path. Realtime API writes act as the bearer token's tenant,
                       so realtime --execute first verifies the token against the
                       selector via GET /api/whoami and refuses on mismatch (a
                       usr_… selector also requires the worker's tenant data-plane
                       gate to be on; 'global' requires it off).
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
