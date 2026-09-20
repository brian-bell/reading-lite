// `ops corpus audit` — inventory every non-ready reading in the corpus,
// classified by failure reason, as index.json + INDEX.md.
//
// The inventory is a query against `readings` (ADR 0005): one statement where
// this used to read index/list.json and then a manifest per stranded reading.
// Captured content still lives in R2, so --teasers reads the extracted bytes
// at the key the reading currently points at.
//
// Reading and classifying the corpus is safe in plan mode (SELECTs and R2
// reads only). The command is plan-first because its output is two durable
// local report files: plan mode prints the paths and row counts it would write
// and touches nothing; --execute writes both reports through the existing
// audit library behavior.

import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildDegradedRows,
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
import {
  DATABASE_URL_ENV_HELP,
  DATABASE_URL_ENV_OPTION,
  operatorDatabaseUrl,
  withOperatorSql,
} from "../../pg-lib/operator-db";
import { assertPgTenant, operatorCorpusFor, type OperatorCorpus } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { operatorTenantSelector } from "../../corpus-lib/tenant";

export interface CorpusAuditDeps extends BaseDeps {
  // The corpus view, opened for the duration of the run.
  corpus: <T>(databaseUrlEnv: string, tenant: ReturnType<typeof requireOperatorTenant>, run: (corpus: OperatorCorpus) => Promise<T>) => Promise<T>;
  r2: {
    readObject: (key: string, deps: R2Deps) => Promise<string | null>;
  };
  // Durable local writes — only reached on --execute.
  mkdir: (dir: string) => Promise<void>;
  writeFile: (filePath: string, body: string) => Promise<void>;
  now: () => number;
}

interface AuditArgs {
  bucket: string;
  tenant?: string;
  databaseUrlEnv: string;
  out: string;
  remote: boolean;
  teasers: boolean;
  degraded: boolean;
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
        "database-url-env": DATABASE_URL_ENV_OPTION,
        out: { type: "string" },
        local: { type: "boolean", default: false },
        teasers: { type: "boolean", default: false },
        degraded: { type: "boolean", default: false },
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
    databaseUrlEnv: values["database-url-env"]!,
    out: values.out ?? ".",
    remote: values.local !== true,
    teasers: values.teasers === true,
    degraded: values.degraded === true,
    deep: values.deep === true,
    execute: values.execute === true,
  };
}

async function detectTeasers(
  items: ListItem[],
  corpus: OperatorCorpus,
  r2: CorpusAuditDeps["r2"],
  r2Deps: R2Deps,
): Promise<AuditRow[]> {
  const ready = items.filter((i) => i.status === "ready" && isNewsletterHost(i.url));
  const rows: AuditRow[] = [];
  for (const it of ready) {
    // The extracted key comes from the reading's current revision, not from
    // its key prefix: each attempt captures under its own immutable prefix, so
    // the legacy spelling can be a superseded attempt's bytes or absent.
    const keys = await corpus.contentKeys(it.id);
    const md = keys?.extractedKey ? await r2.readObject(keys.extractedKey, r2Deps) : null;
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

async function deepenStrandedStages(rows: AuditRow[], corpus: OperatorCorpus): Promise<void> {
  const stranded = rows.filter((r) => r.class === "stranded");
  const stages = await corpus.stuckStages(stranded.map((r) => r.reading_id));
  for (const r of stranded) {
    const stage = stages.get(r.reading_id);
    if (stage) r.stuck_stage = stage;
  }
}

async function runCorpusAudit(argv: string[], deps: CorpusAuditDeps): Promise<number> {
  const args = parseAuditArgs(argv);
  const tenant = requireOperatorTenant(args.tenant);
  // Before any connection: a 'global' selector must say so, not report a
  // missing connection string.
  assertPgTenant(tenant);
  const r2Deps: R2Deps = { bucket: args.bucket, keyRoot: tenant.keyRoot, remote: args.remote };

  const inventory = await deps.corpus(args.databaseUrlEnv, tenant, async (corpus) => {
    const items = await corpus.listItems();
    const pending = buildPendingRows(items, deps.now());
    if (args.deep) await deepenStrandedStages(pending, corpus);
    return {
      items,
      pending,
      failed: buildFailedRows(items),
      failedOrphanDups: buildFailedOrphanDupRows(items),
      teasers: args.teasers ? await detectTeasers(items, corpus, deps.r2, r2Deps) : [],
    };
  });
  const { items, failed, failedOrphanDups, pending, teasers } = inventory;
  const degraded = args.degraded ? buildDegradedRows(items) : [];
  const tally = tallyStatuses(items);

  const outDir = path.resolve(args.out);
  const jsonPath = path.join(outDir, "index.json");
  const mdPath = path.join(outDir, "INDEX.md");
  const rows = [...failed, ...failedOrphanDups, ...pending, ...teasers, ...degraded];
  const summary = {
    bucket: args.bucket,
    totals: tally,
    failed: failed.length,
    failed_orphan_dups: failedOrphanDups.length,
    pending_stranded: pending.filter((p) => p.class === "stranded").length,
    pending_orphan_dups: pending.filter((p) => p.class === "orphan-dup").length,
    pending_fresh: pending.filter((p) => p.class === "fresh").length,
    teasers: teasers.length,
    degraded: degraded.length,
    out: outDir,
  };

  if (!args.execute) {
    deps.io.stdout(`Plan: audit corpus of ${operatorTenantSelector(tenant)} from ${args.databaseUrlEnv}`);
    deps.io.stdout(`  would write ${jsonPath} (${rows.length} rows)`);
    deps.io.stdout(`  would write ${mdPath}`);
    deps.io.stdout(JSON.stringify(summary, null, 2));
    deps.io.stdout("Rerun with --execute to write the report files.");
    return 0;
  }

  await deps.mkdir(outDir);
  await deps.writeFile(
    jsonPath,
    JSON.stringify(
      // `tenant` is provenance: corpus recover refuses to act on an audit taken
      // under a different selector (legacy unstamped audits read as global).
      { generated: "corpus non-ready inventory", tenant: operatorTenantSelector(tenant), totals: tally, rows },
      null,
      2,
    ) + "\n",
  );
  await deps.writeFile(
    mdPath,
    renderIndexMarkdown(
      failed, pending, teasers, tally,
      new Date(deps.now()).toISOString().slice(0, 10),
      failedOrphanDups,
      operatorTenantSelector(tenant),
      degraded,
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
  helpText: `Queries the tenant's readings and classifies every one that is not ready.
Plan mode reads and classifies but writes nothing; --execute writes
index.json + INDEX.md. Never writes to the corpus.

Options:
  --tenant <selector>  REQUIRED: tenant id (usr_…). 'global' has no PostgreSQL corpus.
  ${DATABASE_URL_ENV_HELP}
  --out <dir>       Output directory for index.json + INDEX.md. Default: cwd.
  --teasers         Also scan ready pragmaticengineer/substack readings for
                    paywall teasers (reads their content from R2; slower).
  --degraded        Also list ready YouTube readings that recorded an
                    enrichment miss (no extra reads).
  --deep            Resolve the true stuck stage of stranded pending readings
                    from their attempt events (one extra query).
  --bucket <name>   R2 bucket holding captured content, read only by --teasers.
                    Default: READING_LITE_BUCKET env, then reading-lite.
  --local           Read the local miniflare cache instead of remote R2.
  --execute         Write the report files.
  --help            Show this message.

--teasers additionally requires a Cloudflare session (wrangler login /
CLOUDFLARE_API_TOKEN); the inventory itself needs only the database.`,
  defaultDeps: (io: CommandIo): CorpusAuditDeps => ({
    io,
    corpus: (databaseUrlEnv, tenant, run) =>
      withOperatorSql(operatorDatabaseUrl(databaseUrlEnv), (sql) => run(operatorCorpusFor(sql, tenant))),
    r2: {
      readObject: wranglerR2.readObject,
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
