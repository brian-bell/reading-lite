// `ops corpus audit` — inventory every non-ready reading in the corpus,
// classified by failure reason, as index.json + INDEX.md.
//
// Reading and classifying the corpus is safe in plan mode (wrangler R2 reads
// only). The command is plan-first because its output is two durable local
// report files: plan mode prints the paths and row counts it would write and
// touches nothing; --execute writes both reports through the existing audit
// library behavior.

import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildFailedOrphanDupRows,
  buildFailedRows,
  buildPendingRows,
  tallyStatuses,
} from "../../corpus-lib/audit";
import { isNewsletterHost, isTeaser, shortUrl } from "../../corpus-lib/classify";
import { resolveBucket } from "../../corpus-lib/config";
import { renderIndexMarkdown } from "../../corpus-lib/render";
import type { AuditRow, ListItem } from "../../corpus-lib/types";
import * as wranglerR2 from "../../corpus-lib/wrangler-r2";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export interface CorpusAuditDeps extends BaseDeps {
  r2: {
    readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
    readExtracted: (keyPrefix: string, deps: R2Deps) => Promise<string | null>;
    readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
    readAttempt: (keyPrefix: string, attemptId: string, deps: R2Deps) => Promise<any | null>;
  };
  // Durable local writes — only reached on --execute.
  mkdir: (dir: string) => Promise<void>;
  writeFile: (filePath: string, body: string) => Promise<void>;
  now: () => number;
}

interface AuditArgs {
  bucket: string;
  tenant?: string;
  out: string;
  remote: boolean;
  teasers: boolean;
  deep: boolean;
  execute: boolean;
}

function parseAuditArgs(argv: string[]): AuditArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        tenant: { type: "string" },
        out: { type: "string" },
        local: { type: "boolean", default: false },
        teasers: { type: "boolean", default: false },
        deep: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  return {
    bucket: resolveBucket(values.bucket),
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    out: values.out ?? ".",
    remote: values.local !== true,
    teasers: values.teasers === true,
    deep: values.deep === true,
    execute: values.execute === true,
  };
}

async function detectTeasers(items: ListItem[], r2: CorpusAuditDeps["r2"], r2Deps: R2Deps): Promise<AuditRow[]> {
  const ready = items.filter((i) => i.status === "ready" && isNewsletterHost(i.url));
  const rows: AuditRow[] = [];
  for (const it of ready) {
    const md = await r2.readExtracted(it.key_prefix, r2Deps);
    if (md && isTeaser(md)) {
      rows.push({
        category: "teaser", url: it.url, short: shortUrl(it.url), reading_id: it.id,
        key_prefix: it.key_prefix, attempts: 1, title: it.title,
        reason: `Paywall teaser — ${md.length} chars extracted`,
      });
    }
  }
  return rows;
}

async function deepenStrandedStages(rows: AuditRow[], r2: CorpusAuditDeps["r2"], r2Deps: R2Deps): Promise<void> {
  for (const r of rows) {
    if (r.class !== "stranded") continue;
    const m = await r2.readManifest(r.key_prefix, r2Deps);
    const attemptId = m?.active_attempt?.id;
    if (!attemptId) continue;
    const a = await r2.readAttempt(r.key_prefix, attemptId, r2Deps);
    const events = a?.events ?? [];
    const last = events[events.length - 1];
    if (last?.stage) r.stuck_stage = `${last.stage}/${last.status}`;
  }
}

async function runCorpusAudit(argv: string[], deps: CorpusAuditDeps): Promise<number> {
  const args = parseAuditArgs(argv);
  const tenant = requireOperatorTenant(args.tenant);
  const r2Deps: R2Deps = { bucket: args.bucket, keyRoot: tenant.keyRoot, remote: args.remote };
  const items = await deps.r2.readListIndex(r2Deps);

  const failed = buildFailedRows(items);
  const failedOrphanDups = buildFailedOrphanDupRows(items);
  const pending = buildPendingRows(items, deps.now());
  if (args.deep) await deepenStrandedStages(pending, deps.r2, r2Deps);
  const teasers = args.teasers ? await detectTeasers(items, deps.r2, r2Deps) : [];
  const tally = tallyStatuses(items);

  const outDir = path.resolve(args.out);
  const jsonPath = path.join(outDir, "index.json");
  const mdPath = path.join(outDir, "INDEX.md");
  const rows = [...failed, ...failedOrphanDups, ...pending, ...teasers];
  const summary = {
    bucket: args.bucket,
    totals: tally,
    failed: failed.length,
    failed_orphan_dups: failedOrphanDups.length,
    pending_stranded: pending.filter((p) => p.class === "stranded").length,
    pending_orphan_dups: pending.filter((p) => p.class === "orphan-dup").length,
    pending_fresh: pending.filter((p) => p.class === "fresh").length,
    teasers: teasers.length,
    out: outDir,
  };

  if (!args.execute) {
    deps.io.stdout(`Plan: audit corpus in ${args.remote ? "remote" : "local"} R2 bucket ${args.bucket}`);
    deps.io.stdout(`  would write ${jsonPath} (${rows.length} rows)`);
    deps.io.stdout(`  would write ${mdPath}`);
    deps.io.stdout(JSON.stringify(summary, null, 2));
    deps.io.stdout("Rerun with --execute to write the report files.");
    return 0;
  }

  await deps.mkdir(outDir);
  await deps.writeFile(
    jsonPath,
    JSON.stringify({ generated: "corpus non-ready inventory", totals: tally, rows }, null, 2) + "\n",
  );
  await deps.writeFile(
    mdPath,
    renderIndexMarkdown(
      failed, pending, teasers, tally,
      new Date(deps.now()).toISOString().slice(0, 10),
      failedOrphanDups,
    ),
  );
  deps.io.stdout(JSON.stringify(summary, null, 2));
  return 0;
}

export const corpusAuditCommand: CommandDefinition<CorpusAuditDeps> = {
  group: "corpus",
  name: "audit",
  summary: "Inventory non-ready readings into index.json + INDEX.md",
  safety: "plan-first",
  helpText: `Reads index/list.json from R2 (via wrangler) and classifies every reading
that is not ready. Plan mode reads and classifies but writes nothing; --execute
writes index.json + INDEX.md. Never writes to the corpus.

Options:
  --bucket <name>   R2 bucket. Default: READING_LITE_BUCKET env, then reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  --out <dir>       Output directory for index.json + INDEX.md. Default: cwd.
  --teasers         Also scan ready pragmaticengineer/substack readings for
                    paywall teasers (reads their content; slower).
  --deep            Resolve the true stuck stage of stranded pending readings
                    from their attempt files (slower).
  --local           Read the local miniflare cache instead of remote R2.
  --execute         Write the report files.
  --help            Show this message.

Requires a Cloudflare session (wrangler login / CLOUDFLARE_API_TOKEN).`,
  defaultDeps: (io: CommandIo): CorpusAuditDeps => ({
    io,
    r2: {
      readListIndex: wranglerR2.readListIndex,
      readExtracted: wranglerR2.readExtracted,
      readManifest: wranglerR2.readManifest,
      readAttempt: wranglerR2.readAttempt,
    },
    mkdir: async (dir) => {
      const { promises: fs } = await import("node:fs");
      await fs.mkdir(dir, { recursive: true });
    },
    writeFile: async (filePath, body) => {
      const { promises: fs } = await import("node:fs");
      await fs.writeFile(filePath, body);
    },
    now: () => Date.now(),
  }),
  run: runCorpusAudit,
};
