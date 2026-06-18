#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildFailedRows, buildPendingRows, tallyStatuses } from "./corpus-lib/audit";
import { isNewsletterHost, isTeaser, shortUrl } from "./corpus-lib/classify";
import { resolveBucket } from "./corpus-lib/config";
import { renderIndexMarkdown } from "./corpus-lib/render";
import type { AuditRow, ListItem } from "./corpus-lib/types";
import { readAttempt, readExtracted, readListIndex, readManifest, type R2Deps } from "./corpus-lib/wrangler-r2";

interface Args {
  bucket: string;
  out: string;
  remote: boolean;
  teasers: boolean;
  deep: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      bucket: { type: "string" },
      out: { type: "string" },
      local: { type: "boolean", default: false },
      teasers: { type: "boolean", default: false },
      deep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  return {
    bucket: resolveBucket(values.bucket),
    out: values.out ?? ".",
    remote: values.local !== true,
    teasers: values.teasers === true,
    deep: values.deep === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-audit -- [options]

Read-only inventory of every reading in the reading-lite corpus that is NOT
ready. Reads index/list.json from R2 (via wrangler) and writes index.json +
INDEX.md. No writes to the corpus.

  --bucket <name>   R2 bucket. Default: READING_LITE_BUCKET env, then reading-lite.
  --out <dir>       Output directory for index.json + INDEX.md. Default: cwd.
  --teasers         Also scan ready pragmaticengineer/substack readings for
                    paywall teasers (reads their content; slower).
  --deep            Resolve the true stuck stage of stranded pending readings
                    from their attempt files (slower).
  --local           Read the local miniflare cache instead of remote R2.
  --help            Show this message.

Requires a Cloudflare session (wrangler login / CLOUDFLARE_API_TOKEN).`);
}

async function detectTeasers(items: ListItem[], deps: R2Deps): Promise<AuditRow[]> {
  const ready = items.filter((i) => i.status === "ready" && isNewsletterHost(i.url));
  const rows: AuditRow[] = [];
  for (const it of ready) {
    const md = await readExtracted(it.key_prefix, deps);
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

async function deepenStrandedStages(rows: AuditRow[], deps: R2Deps): Promise<void> {
  for (const r of rows) {
    if (r.class !== "stranded") continue;
    const m = await readManifest(r.key_prefix, deps);
    const attemptId = m?.active_attempt?.id;
    if (!attemptId) continue;
    const a = await readAttempt(r.key_prefix, attemptId, deps);
    const events = a?.events ?? [];
    const last = events[events.length - 1];
    if (last?.stage) r.stuck_stage = `${last.stage}/${last.status}`;
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const deps: R2Deps = { bucket: args.bucket, remote: args.remote };
  const items = await readListIndex(deps);

  const failed = buildFailedRows(items);
  const pending = buildPendingRows(items, Date.now());
  if (args.deep) await deepenStrandedStages(pending, deps);
  const teasers = args.teasers ? await detectTeasers(items, deps) : [];
  const tally = tallyStatuses(items);

  await fs.mkdir(path.resolve(args.out), { recursive: true });
  const rows = [...failed, ...pending, ...teasers];
  await fs.writeFile(
    path.join(args.out, "index.json"),
    JSON.stringify({ generated: "corpus non-ready inventory", totals: tally, rows }, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(args.out, "INDEX.md"),
    renderIndexMarkdown(failed, pending, teasers, tally, new Date().toISOString().slice(0, 10)),
  );

  process.stdout.write(JSON.stringify({
    bucket: args.bucket,
    totals: tally,
    failed: failed.length,
    pending_stranded: pending.filter((p) => p.class === "stranded").length,
    pending_orphan_dups: pending.filter((p) => p.class === "orphan-dup").length,
    teasers: teasers.length,
    out: path.resolve(args.out),
  }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
