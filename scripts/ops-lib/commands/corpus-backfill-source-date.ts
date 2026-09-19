// `ops corpus backfill-source-date` — fill missing `source_date` on existing
// readings by re-running `readabilityFromHtml` over stored R2 `raw.html`.
//
// No network: the raw bytes are already under `layout.rawKey`. Plan-first: a
// mode-less run reports already-dated / skip (markdown) / no-raw /
// unparseable / would-gain counts (would-gain is the A1 HTML hit-rate
// numerator). --execute writes only `source_date` onto manifests that lack
// one. Markdown imports are skipped — they have no HTML object to parse.
//
// Execute re-reads the live manifest immediately before put and merges only
// source_date onto that object. The classify-pass snapshot is never written
// back. Resumable and idempotent: a dated reading is left alone.
//
// Storage: same --via / credential auto-select as refresh-neighbours, via
// chooseR2Backend. S3 keys alone take the direct path — this command never
// queries Vectorize, so CORPUS_CF_API_TOKEN is not required.

import {
  classifySourceDateCandidate,
  classifyStoredHtml,
  validateSourceDateBackfillWrite,
} from "../../corpus-lib/backfill-source-date";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import { loadDotVars } from "../../lib/dotvars";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import {
  chooseR2Backend,
  describeBackend,
  type BackendChoice,
  type CorpusObjectR2,
  type NeighboursBackend,
} from "../neighbours-r2";
import { requireOperatorTenant } from "../tenant-flag";

const layout = r2KeyLayout();
const HTML_EXT = "html";

export type CorpusBackfillSourceDateR2 = CorpusObjectR2;

export interface CorpusBackfillSourceDateDeps extends BaseDeps {
  r2: CorpusBackfillSourceDateR2;
  /**
   * The direct (S3/REST) path, built lazily so a wrangler run resolves no
   * credentials. Absent means this environment has no direct path (tests).
   */
  directR2?: () => CorpusBackfillSourceDateR2;
  /** Credentials consulted to auto-select a backend. Default: none. */
  storageVars?: () => Record<string, string | undefined>;
  now: () => number;
  // Injected so tests can throw from classify without a pathological HTML
  // fixture. Production uses classifyStoredHtml.
  classifyHtml?: typeof classifyStoredHtml;
}

interface Opts {
  tenant?: string;
  via?: NeighboursBackend;
  only: string[];
  bucket: string;
  remote: boolean;
  execute: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    only: [],
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--tenant") opts.tenant = requireValue(argv[++i], a);
    else if (a === "--via") opts.via = parseVia(requireValue(argv[++i], a));
    else if (a === "--limit") opts.limit = parsePositiveInt(requireValue(argv[++i], a));
    else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else opts.only.push(a);
  }
  if (opts.via === "direct" && !opts.remote) {
    throw new UsageError("--via direct cannot be combined with --local");
  }
  return opts;
}

function parseVia(raw: string): NeighboursBackend {
  if (raw === "wrangler" || raw === "direct") return raw;
  throw new UsageError(`--via "${raw}" is not one of: direct, wrangler`);
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--limit "${raw}" is not a positive integer`);
  return n;
}

function selectStorage(
  opts: Opts,
  deps: CorpusBackfillSourceDateDeps,
): { choice: BackendChoice; storage: CorpusBackfillSourceDateR2 } {
  const requested = chooseR2Backend({
    ...(opts.via === undefined ? {} : { via: opts.via }),
    local: !opts.remote,
    vars: deps.storageVars?.() ?? {},
  });
  const direct = deps.directR2;
  if (requested.backend !== "direct") return { choice: requested, storage: deps.r2 };
  if (direct === undefined) {
    return {
      choice: { backend: "wrangler", reason: `${requested.reason}, but no direct client available` },
      storage: deps.r2,
    };
  }
  return { choice: requested, storage: direct() };
}

async function runCorpusBackfillSourceDate(
  argv: string[],
  deps: CorpusBackfillSourceDateDeps,
): Promise<number> {
  const opts = parseArgs(argv);
  const { io } = deps;
  const { choice, storage: r2 } = selectStorage(opts, deps);
  const inspectHtml = deps.classifyHtml ?? classifyStoredHtml;
  const tenant = requireOperatorTenant(opts.tenant);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };
  const nowMs = deps.now();

  const items = await r2.readListIndex(r2Deps);
  const only = opts.only.length > 0 ? new Set(opts.only) : null;
  const scoped = only === null ? items : items.filter((i) => only.has(i.id));

  for (const line of describeBackend(choice)) io.stdout(line);
  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Corpus: ${items.length} readings`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

  let alreadyDated = 0;
  let skipMarkdown = 0;
  const candidates: ListItem[] = [];
  let errored = 0;
  let invalid = 0;

  for (const item of scoped) {
    let manifest: unknown;
    try {
      manifest = await r2.readManifest(item.key_prefix, r2Deps);
    } catch (e) {
      errored++;
      io.stderr(`  ! manifest unparseable for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      errored++;
      io.stderr(`  ! manifest unreadable for ${item.id}`);
      continue;
    }
    const rec = manifest as Record<string, unknown>;
    const cls = classifySourceDateCandidate(rec);
    if (cls === "already-dated") {
      alreadyDated++;
      continue;
    }
    if (cls === "skip-markdown") {
      skipMarkdown++;
      continue;
    }
    candidates.push(item);
  }

  const targets = opts.limit === undefined ? candidates : candidates.slice(0, opts.limit);
  io.stdout(
    `To inspect stored HTML: ${candidates.length}${opts.limit === undefined ? "" : ` (limited to ${targets.length})`}`,
  );

  let noRaw = 0;
  let unparseable = 0;
  let wouldGain = 0;
  const written = new Map<string, string>();

  const flushIndex = async (): Promise<void> => {
    if (!opts.execute || written.size === 0) return;
    const updated = items.map((i) => {
      const date = written.get(i.id);
      return date === undefined ? i : { ...i, source_date: date };
    });
    await r2.writeListIndex(updated, r2Deps);
    io.stdout(`index/list.json rewritten (${written.size} row(s) updated).`);
  };

  try {
    for (const item of targets) {
      // One reading, one catch: a salvage/turndown throw or a live-manifest
      // read failure must not abort the remaining walk. Written rows still
      // flush in `finally`.
      try {
        const rawHtml = await r2.readRawHtml(item.key_prefix, r2Deps);
        const inspected = inspectHtml({ rawHtml, url: item.url, nowMs });
        if (inspected.kind === "no-raw") {
          noRaw++;
          io.stdout(`  ${item.id}  no-raw  ${item.url}`);
          continue;
        }
        if (inspected.kind === "unparseable") {
          unparseable++;
          io.stdout(`  ${item.id}  unparseable  ${item.url}`);
          continue;
        }

        wouldGain++;
        io.stdout(`  ${item.id}  would-gain  ${inspected.source_date}  ${item.url}`);
        if (!opts.execute) continue;

        // Re-read at write time. The classify pass's object is stale by then
        // and must not be the put body — merge source_date onto the live
        // manifest only (parse as gate, not transform).
        const live = await r2.readManifest(item.key_prefix, r2Deps);
        const check = validateSourceDateBackfillWrite(live, inspected.source_date);
        if (!check.ok) {
          invalid++;
          io.stderr(`  ! manifest fails write gate for ${item.id}: ${check.error}`);
          continue;
        }
        await r2.putManifest(item.key_prefix, check.manifest, r2Deps);
        written.set(item.id, inspected.source_date);
      } catch (e) {
        errored++;
        io.stderr(
          `  ! inspect/write failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    await flushIndex();
  }

  io.stdout(`\nAlready dated: ${alreadyDated}`);
  io.stdout(`Skipped (markdown): ${skipMarkdown}`);
  io.stdout(`No raw HTML: ${noRaw}`);
  io.stdout(`Unparseable: ${unparseable}`);
  io.stdout(`Would gain a date: ${wouldGain}${opts.execute ? `, written: ${written.size}` : ""}`);
  if (errored > 0) {
    io.stdout(`Query or manifest read/write failures: ${errored}`);
  }
  if (invalid > 0) {
    io.stdout(`Manifests failing the write gate: ${invalid} — skipped rather than rewritten.`);
  }

  const failed = errored + invalid;
  if (failed > 0) {
    io.stderr(`\n${failed} reading(s) were not inspected or written — run incomplete.`);
    return 1;
  }

  if (!opts.execute) {
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
  }
  return 0;
}

export const corpusBackfillSourceDateCommand: CommandDefinition<CorpusBackfillSourceDateDeps> = {
  group: "corpus",
  name: "backfill-source-date",
  summary: "Fill missing source_date from stored raw HTML (no refetch)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus backfill-source-date [rd_ID...] [options]

Fills missing manifest.source_date by re-running readabilityFromHtml over the
stored R2 raw.html object. No network fetch, no politeness budget, no risk of
a dead URL changing what we store. Writes only source_date; title, tags,
summary, and updated_at stay untouched.

Never overwrites an existing source_date. Skips markdown-imported readings
(no raw HTML object to parse). Readings whose stored HTML has no usable
published time are reported as unparseable and left alone.

The PLAN "Would gain a date" count is the numerator for the A1 HTML hit rate;
pair it with the A-prep composition counts to decompose the coverage gap.

Resumable: a second run is a no-op on readings this pass already dated.
--limit caps how many HTML objects are inspected in one pass.

Plan by default. Add --execute to write.

Run when nothing is being submitted: the list.json rewrite is a plain put, not a
CAS write, so a concurrent queue write could be lost.

Options:
  --limit <n>         Cap how many readings are inspected this pass.
  --bucket <name>     R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  --via <path>        Storage path: 'direct' (R2 over S3 or the Cloudflare
                      REST API) or 'wrangler' (a child process per call).
                      Default: direct when CORPUS_R2_* keys or a Cloudflare
                      API token are present, wrangler otherwise. S3 keys
                      alone are enough — this command does not query Vectorize.
                      --local always uses wrangler; --via direct --local is a
                      usage error. The chosen path is printed in the header.
  --local             Use the local miniflare bucket.
  --execute           Write manifests and flush the list index.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): CorpusBackfillSourceDateDeps => ({
    io,
    r2: {
      readListIndex: async (d) => (await import("../../corpus-lib/wrangler-r2")).readListIndex(d),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      readRawHtml: async (kp, d) => {
        const { readObjectStrict } = await import("../../corpus-lib/wrangler-r2");
        return readObjectStrict(layout.rawKey(kp, HTML_EXT), d);
      },
      putManifest: async (kp, body, d) => (await import("../../corpus-lib/wrangler-put")).putManifest(kp, body, d),
      writeListIndex: async (items, d) => (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items, d),
    },
    directR2: () => {
      let built: CorpusBackfillSourceDateR2 | undefined;
      const lazy = async (): Promise<CorpusBackfillSourceDateR2> => {
        if (built === undefined) built = await buildDirectR2();
        return built;
      };
      return {
        readListIndex: async (d) => (await lazy()).readListIndex(d),
        readManifest: async (kp, d) => (await lazy()).readManifest(kp, d),
        readRawHtml: async (kp, d) => (await lazy()).readRawHtml(kp, d),
        putManifest: async (kp, body, d) => (await lazy()).putManifest(kp, body, d),
        writeListIndex: async (items, d) => (await lazy()).writeListIndex(items, d),
      };
    },
    storageVars: defaultStorageVars,
    now: () => Date.now(),
  }),
  run: runCorpusBackfillSourceDate,
};

function defaultStorageVars(): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
}

async function buildDirectR2(): Promise<CorpusBackfillSourceDateR2> {
  const { r2InventoryClientFromVars } = await import("../../lib/cf-clients");
  const { directCorpusObjectR2 } = await import("../neighbours-r2");
  const vars = defaultStorageVars();
  return directCorpusObjectR2({
    r2: (bucket) => r2InventoryClientFromVars(vars, bucket, globalThis.fetch),
  });
}
