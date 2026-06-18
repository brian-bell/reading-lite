#!/usr/bin/env -S npx tsx
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { extractFromUrl } from "../src/modules/extractor/index";
import { resolveApiTarget, resolveBucket } from "./corpus-lib/config";
import { importMarkdown, reprocessReading, type ApiDeps } from "./corpus-lib/api";
import { planByAction, recoveryAction } from "./corpus-lib/policy";
import { shouldPauseAfter } from "./corpus-lib/throttle";
import { tallyByIds } from "./corpus-lib/audit";
import { readListIndex } from "./corpus-lib/wrangler-r2";
import type { AuditRow, RecoveryAction } from "./corpus-lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browserFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? {});
  headers.set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.set("accept-language", "en-US,en;q=0.9");
  return fetch(input as RequestInfo, { ...init, headers, redirect: "follow" });
};

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
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
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
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  return {
    index: values.index ?? "./index.json",
    execute: values.execute === true,
    only: values.only as RecoveryAction | undefined,
    limit: values.limit ? Number(values.limit) : Infinity,
    bucket: resolveBucket(values.bucket),
    url: values.url,
    token: values.token,
    monitor: values.monitor === true,
    wave: parsePositive(values.wave, "wave", Infinity),
    wavePauseMs: parsePositive(values["wave-pause"], "wave-pause", 60) * 1000,
  };
}

// Operator-supplied numbers: a malformed value must not silently disable
// pacing mid-recovery. Warn and fall back to the default instead.
function parsePositive(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`  ! --${name} "${raw}" is not a positive number; using default ${fallback}\n`);
    return fallback;
  }
  return n;
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-recover -- [options]

Acts on a corpus-audit index.json: reprocesses recoverable readings and
re-extracts fetch-blocked ones locally. Dry-run (plan only) by default.

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
  --help            Show this message.

Policy (per audit row): stranded/transient/5xx/summarize -> reprocess;
fetch-blocked 403/429 + oversized -> local-extract + markdown import;
dead links / paywalls / non-articles / teasers -> skip.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const doc = JSON.parse(await fs.readFile(args.index, "utf8")) as { rows: AuditRow[] };
  const rows = doc.rows ?? [];
  const plan = planByAction(rows);

  process.stderr.write(
    `Plan from ${args.index}:\n` +
      `  reprocess:     ${plan.reprocess.length}\n` +
      `  local-extract: ${plan["local-extract"].length}\n` +
      `  skip:          ${plan.skip.length}\n` +
      `  none:          ${plan.none.length}\n\n`,
  );

  const actions: RecoveryAction[] = args.only ? [args.only] : ["reprocess", "local-extract"];
  if (!args.execute) {
    let remaining = args.limit;
    for (const a of actions) {
      for (const r of plan[a]) {
        if (remaining <= 0) break;
        remaining--;
        process.stderr.write(`  [dry-run ${a}] ${r.short} — ${recoveryAction(r).why}\n`);
      }
    }
    printSummary({ executed: false, reprocessed: 0, extracted: 0, errors: 0, touched: [] });
    return;
  }

  const api: ApiDeps = { ...resolveApiTarget({ url: args.url, token: args.token }), fetch: globalThis.fetch };
  if (!api.token) {
    console.error("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)");
    process.exit(2);
  }

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
      process.stderr.write(`  ...${submitted} submitted; pausing ${Math.round(args.wavePauseMs / 1000)}s to let the queue drain\n`);
      await sleep(args.wavePauseMs);
    }
  };

  if (actions.includes("reprocess")) {
    for (const r of plan.reprocess) {
      if (remaining <= 0) break;
      remaining--;
      await paceBeforeSubmit();
      const res = await reprocessReading(r.reading_id, api);
      if (res.outcome === "error") { errors++; (r as any).result = `reprocess error: ${res.error}`; }
      else { reprocessed++; submitted++; touched.push(r.reading_id); (r as any).result = `reprocess: ${res.outcome}`; }
      process.stderr.write(`  reprocess ${r.short} -> ${res.outcome}${res.error ? " " + res.error : ""}\n`);
    }
  }

  if (actions.includes("local-extract")) {
    for (const r of plan["local-extract"]) {
      if (remaining <= 0) break;
      remaining--;
      try {
        const ex = await extractFromUrl(r.url, { fetch: browserFetch, timeoutMs: 30_000, maxBytes: 30_000_000 });
        if (ex.content_status !== "captured" || !ex.markdown?.trim()) {
          errors++; (r as any).result = `local-extract failed: ${ex.content_status} (${ex.content_type})`;
          process.stderr.write(`  local-extract ${r.short} -> no markdown (${ex.content_status})\n`);
          continue;
        }
        await paceBeforeSubmit();
        const res = await importMarkdown({ source_url: r.url, markdown: ex.markdown, ...(ex.title ? { title: ex.title } : {}) }, api);
        if (res.outcome === "error") { errors++; (r as any).result = `import error: ${res.error}`; }
        else { extracted++; submitted++; if (res.id) touched.push(res.id); (r as any).result = `local-extract+import: ${res.outcome} ${res.id ?? ""}`; }
        process.stderr.write(`  local-extract ${r.short} -> import ${res.outcome}${res.id ? " " + res.id : ""}\n`);
      } catch (e) {
        errors++; (r as any).result = `local-extract threw: ${e instanceof Error ? e.message : String(e)}`;
        process.stderr.write(`  local-extract ${r.short} -> ERROR ${(e as Error).message}\n`);
      }
    }
  }

  await fs.writeFile(args.index, JSON.stringify(doc, null, 2) + "\n");

  if (args.monitor && touched.length > 0) {
    process.stderr.write(`\nMonitoring ${touched.length} readings...\n`);
    for (let i = 0; i < 60; i++) {
      const items = await readListIndex({ bucket: args.bucket, remote: true });
      const t = tallyByIds(items, touched);
      const ts = new Date().toISOString().slice(11, 19);
      process.stderr.write(`  ${ts} ready=${t.ready} pending=${t.pending} failed=${t.failed} absent=${t.absent}\n`);
      if (t.pending === 0) break;
      await sleep(15_000);
    }
  }

  printSummary({ executed: true, reprocessed, extracted, errors, touched });
  if (errors > 0) process.exit(1);
}

function printSummary(s: { executed: boolean; reprocessed: number; extracted: number; errors: number; touched: string[] }): void {
  process.stdout.write(JSON.stringify({
    executed: s.executed, reprocessed: s.reprocessed, extracted: s.extracted, errors: s.errors, touched: s.touched.length,
  }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
