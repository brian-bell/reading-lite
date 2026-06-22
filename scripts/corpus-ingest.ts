#!/usr/bin/env -S npx tsx
import path from "node:path";
import { parseArgs } from "node:util";
import { ManifestSchema, ByUrlPointerSchema, type Manifest, type ByUrlPointer, type ManifestStatus } from "../src/schemas/manifest";
import { ListIndexItemSchema, type ListIndexItem } from "../src/schemas/api";
import { mintReadingId, sha256Hex } from "../src/services";
import { resolveBatchConfig } from "./corpus-lib/config";
import { MARKDOWN_IMPORT_MAX_BYTES, readMarkdownDir } from "./import-markdown-lib/parse";
import { planFreshMarkdownIngest, type IngestPlan } from "./corpus-lib/batch/ingest-plan";
import { runFreshMarkdownBatch } from "./corpus-lib/batch/run-fresh-markdown";
import { clearSidecar, loadSidecar, saveSidecar } from "./corpus-lib/batch/sidecar";
import { makeR2Client, makeVectorizeClient, type R2Client } from "./lib/cf-clients";
import { makeAnthropicBatchClient, makeOpenAIEmbedClient } from "./corpus-lib/batch/clients";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args {
  dir: string;
  execute: boolean;
  limit: number;
  bucket?: string;
  sidecar: string;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      execute: { type: "boolean", default: false },
      limit: { type: "string" },
      bucket: { type: "string" },
      sidecar: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  if (!values.dir) {
    console.error("missing required --dir <path>");
    printUsage();
    process.exit(2);
  }
  return {
    dir: values.dir,
    execute: values.execute === true,
    limit: parseLimit(values.limit),
    ...(values.bucket === undefined ? {} : { bucket: values.bucket }),
    sidecar: values.sidecar ?? path.join(values.dir, ".corpus-ingest.batch.json"),
  };
}

// A malformed --limit must not silently disable the cap: Number("abc") is NaN,
// which downstream treats as unbounded and could submit an entire (paid) backlog.
// Reject anything that isn't a positive integer before any batch is created.
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--limit must be a positive integer (got ${raw})`);
    process.exit(2);
  }
  return n;
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-ingest -- --dir <path> [options]

Bulk-ingests a directory of fresh markdown files into the corpus, summarizing
via the Anthropic Message Batch API (~50% cheaper, async, no rate-limit retries)
instead of the realtime queue. The markdown is the article — no URL is fetched.

  --dir <path>      Directory of .md files (required). Each needs a source line:
                      **Source:** https://example.com/article
                    Duplicates (same source) collapse to the largest file.
  --execute         Actually submit + write (otherwise prints the plan only).
  --limit <n>       Cap how many readings to submit. Applied AFTER the
                    idempotency check, so already-ready/pending owners don't
                    consume a slot — re-runs chunk through the remaining files.
  --bucket <name>   R2 bucket override. Default: CORPUS_R2_BUCKET / reading-lite.
  --sidecar <path>  Batch sidecar path (resume marker).
                    Default: <dir>/.corpus-ingest.batch.json.
  --help            Show this message.

Dry-run by default. Idempotent: re-running skips ready owners (by-url pointer OR
a pointerless legacy reading in index/list.json) and re-ingests failed (and
stranded-pending, past the worker's PENDING_TTL) owners in place; never
duplicates an already-ready URL. A by-url pointer written just before its pending
manifest (the worker's claim window) is honored as in-flight, not clobbered.
Crash-safe via the sidecar — a re-run resumes the in-flight batch, not re-bills.

Needs R2 + Vectorize creds (.corpus.vars) and ANTHROPIC/OPENAI keys, the same
credential world as 'corpus-recover --batch' (not the HTTP bearer token).

CAVEAT: write-phase only claims the by-url slot on success, so the URL stays
unclaimed during the in-flight batch window. A concurrent realtime submit of the
same URL could create a duplicate. Run this as the sole writer for the URLs.
Source URLs are normalized (via new URL().toString()) before hashing, so a
trailing-slash variant of a URL imported through the realtime HTTP route may not
dedup against it; this tool is self-consistent for re-runs.
A target that terminally fails (batch errored/expired/bad tool input) is written
as an addressable failed reading (by-id pointer) — recover it with reprocess.
Re-running the directory would mint a new id for it, since the by-url slot is
only claimed on success.`);
}

// R2-backed idempotency reader for prepareFreshMarkdown.
function idempotencyDeps(r2: R2Client) {
  return {
    readByUrlPointer: async (urlHash: string): Promise<ByUrlPointer | null> => {
      const raw = await r2.get(`index/by-url/${urlHash}`);
      return raw ? ByUrlPointerSchema.parse(JSON.parse(raw)) : null;
    },
    readManifest: async (keyPrefix: string): Promise<Manifest | null> => {
      const raw = await r2.get(`${keyPrefix}/manifest.json`);
      return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
    },
    findListCandidates: makeListCandidatesResolver(r2),
    mintId: mintReadingId,
    now: () => new Date().toISOString(),
    sha256: sha256Hex,
  };
}

const OWNERSHIP_RANK: Record<ManifestStatus, number> = { ready: 3, pending: 2, failed: 1 };

// Lazily index index/list.json by URL (the master list, which includes legacy
// readings with no by-url pointer) and return ALL candidate pointers for a URL,
// ranked best-first — ready > pending > failed, then most recent (updated_at ??
// created_at, matching ListIndexStore). prepareFreshMarkdown re-reads and verifies
// each candidate's manifest until one matches, so a stale top row can't mask a
// valid lower one. Read once and cached across articles.
function makeListCandidatesResolver(r2: R2Client): (url: string) => Promise<ByUrlPointer[]> {
  let byUrl: Map<string, ListIndexItem[]> | null = null;
  const load = async (): Promise<Map<string, ListIndexItem[]>> => {
    const map = new Map<string, ListIndexItem[]>();
    const raw = await r2.get("index/list.json");
    if (!raw) return map;
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(raw) as { items?: unknown[] };
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return map;
    }
    for (const candidate of items) {
      const item = ListIndexItemSchema.safeParse(candidate);
      if (!item.success) continue;
      const group = map.get(item.data.url) ?? [];
      group.push(item.data);
      map.set(item.data.url, group);
    }
    for (const group of map.values()) group.sort(byOwnershipThenRecency);
    return map;
  };
  return async (url: string): Promise<ByUrlPointer[]> => {
    if (!byUrl) byUrl = await load();
    return (byUrl.get(url) ?? []).map((item) => ({ id: item.id, key_prefix: item.key_prefix }));
  };
}

// Best owner first: ready > pending > failed, then most recent. Mirrors
// ListIndexStore's recency tie-break on updated_at ?? created_at.
function byOwnershipThenRecency(a: ListIndexItem, b: ListIndexItem): number {
  const ra = OWNERSHIP_RANK[a.status] ?? 0;
  const rb = OWNERSHIP_RANK[b.status] ?? 0;
  if (ra !== rb) return rb - ra;
  return Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at);
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const articles = await readMarkdownDir(args.dir);

  // Resolve config + idempotency. Both modes want the ready/pending-skip preview;
  // it just needs the R2 read creds (the full config also carries the LLM keys).
  let cfg: ReturnType<typeof resolveBatchConfig> | null = null;
  let plan: IngestPlan | null = null;
  try {
    cfg = resolveBatchConfig({ ...(args.bucket === undefined ? {} : { bucket: args.bucket }) });
    const r2 = makeR2Client(cfg.r2, globalThis.fetch);
    plan = await planFreshMarkdownIngest(articles, args.limit, idempotencyDeps(r2));
  } catch (e) {
    if (args.execute) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    process.stderr.write(
      `  ! could not resolve corpus creds — skipping the ready/pending idempotency preview\n` +
        `    (${e instanceof Error ? e.message : String(e)})\n`,
    );
  }

  const existing = await loadSidecar(args.sidecar);
  logPlan(args, plan, existing !== null);

  if (!args.execute) {
    printSummary({
      executed: false,
      resumed: existing !== null,
      ready: 0,
      failed: 0,
      skipped: plan?.prep.skipped.length ?? 0,
      wouldSubmit: plan?.prep.targets.length ?? 0,
    });
    return;
  }

  // execute: the catch above already exits on a resolve failure, so cfg + plan
  // are set here — but narrow it explicitly so the compiler enforces the
  // invariant rather than trusting a comment past a distant branch.
  if (!cfg || !plan) {
    console.error("internal: missing resolved config/plan on the execute path");
    process.exit(2);
  }
  const fetchFn = globalThis.fetch;
  const result = await runFreshMarkdownBatch(plan.prep.targets, {
    r2: makeR2Client(cfg.r2, fetchFn),
    vectorize: makeVectorizeClient(cfg.vectorize, fetchFn),
    batch: makeAnthropicBatchClient({ fetch: fetchFn, apiKey: cfg.anthropicApiKey }),
    embed: makeOpenAIEmbedClient({ fetch: fetchFn, apiKey: cfg.openaiApiKey }),
    model: cfg.anthropicModel,
    now: () => new Date().toISOString(),
    sleep: (ms: number) => sleep(ms).then(() => undefined),
    loadSidecar: () => loadSidecar(args.sidecar),
    saveSidecar: (s) => saveSidecar(args.sidecar, s),
    log: (line) => process.stderr.write(line + "\n"),
  });

  // The batch finished and results are written — the sidecar is no longer needed.
  await clearSidecar(args.sidecar);

  const ready = result.report.filter((r) => r.status === "ready").length;
  const failed = result.report.filter((r) => r.status === "failed").length;
  process.stdout.write(
    JSON.stringify(
      {
        executed: true,
        resumed: result.resumed,
        batch_id: result.batchId,
        ready,
        failed,
        // On a resume the work came from the old sidecar, not this run's plan, so
        // the freshly-computed skip count would be misleading — report it only for
        // a fresh run.
        skipped: result.resumed ? 0 : plan.prep.skipped.length,
      },
      null,
      2,
    ) + "\n",
  );
  if (failed > 0) process.exit(1);
}

function logPlan(args: Args, plan: IngestPlan | null, resuming: boolean): void {
  if (resuming) {
    process.stderr.write(`Sidecar:          ${args.sidecar} (would RESUME in-flight batch)\n`);
  }
  if (!plan) {
    process.stderr.write(`Directory:        ${args.dir}\n  (idempotency unresolved — no corpus creds)\n\n`);
    return;
  }

  process.stderr.write(
    `Directory:        ${args.dir}\n` +
      `Files found:      ${plan.fileCount}\n` +
      `Unique sources:   ${plan.uniqueSources}\n` +
      `Duplicate groups: ${plan.duplicateGroups.length}\n` +
      `Missing source:   ${plan.missingSource.length}\n` +
      `Oversized:        ${plan.oversized.length}  (> ${MARKDOWN_IMPORT_MAX_BYTES} bytes)\n`,
  );
  for (const group of plan.duplicateGroups) {
    process.stderr.write(`duplicate ${group.sourceUrl} -> ${group.selected.fileName} (${group.selected.bytes} bytes)\n`);
  }
  for (const file of plan.missingSource) {
    process.stderr.write(`  missing source: ${file.fileName}\n`);
  }
  for (const o of plan.oversized) {
    process.stderr.write(`  oversized: ${o.article.fileName} (${o.article.bytes} bytes, ${o.excessBytes} over)\n`);
  }

  const ready = plan.prep.skipped.filter((s) => s.reason === "already-ready").length;
  const pending = plan.prep.skipped.filter((s) => s.reason === "pending-in-flight").length;
  process.stderr.write(
    `Already ready:    ${ready}  (skipped)\n` +
      `Pending in-flight:${pending}  (skipped)\n` +
      `Would submit:     ${plan.prep.targets.length}\n\n`,
  );
  for (const s of plan.prep.skipped) {
    process.stderr.write(`  skip ${s.reason}: ${s.url}\n`);
  }
}

function printSummary(s: {
  executed: boolean;
  resumed: boolean;
  ready: number;
  failed: number;
  skipped: number;
  wouldSubmit: number;
}): void {
  process.stdout.write(
    JSON.stringify(
      {
        executed: s.executed,
        resumed: s.resumed,
        would_submit: s.wouldSubmit,
        ready: s.ready,
        failed: s.failed,
        skipped: s.skipped,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
