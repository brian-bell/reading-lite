// `ops corpus audit` — inventory every non-ready reading in the corpus,
// classified by failure reason, as index.json + INDEX.md.
//
// The inventory comes from the tenant's `readings` rows (ADR 0005). Before
// reading-lite-gh347.4.7 it walked `index/list.json` and per-reading
// manifests, which nothing has written since the storage migration's slice 1b
// — so it reported a clean inventory of a corpus it could not see.
//
// Reading and classifying is safe in plan mode (SELECTs only). The command is
// plan-first because its output is two durable local report files: plan mode
// prints the paths and row counts it would write and touches nothing;
// --execute writes both reports.

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
  DATABASE_URL_ENV_FLAG_HELP,
  openOperatorSql,
  resolveOperatorDatabaseUrl,
  withOperatorSql,
  type OpenOperatorSql,
} from "../../pg-lib/operator-db";
import {
  latestAttemptStage,
  listItems,
  operatorReadings,
  requireTenantRows,
} from "../../pg-lib/operator-corpus";
import type { PgReadingStore } from "../../../src/modules/stores/postgres/reading-store";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";
import { operatorTenantSelector } from "../../corpus-lib/tenant";

export interface CorpusAuditDeps extends BaseDeps {
  // Content still lives in R2; only the inventory moved.
  r2: {
    readObject: (key: string, deps: R2Deps) => Promise<string | null>;
  };
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
  // Durable local writes — only reached on --execute.
  mkdir: (dir: string) => Promise<void>;
  writeFile: (filePath: string, body: string) => Promise<void>;
  now: () => number;
}

interface AuditArgs {
  bucket: string;
  tenant?: string;
  databaseUrlEnv?: string;
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
        "database-url-env": { type: "string" },
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
    ...(values["database-url-env"] === undefined
      ? {}
      : { databaseUrlEnv: values["database-url-env"] }),
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
  store: PgReadingStore,
  deps: CorpusAuditDeps,
  r2Deps: R2Deps,
): Promise<AuditRow[]> {
  const ready = items.filter((i) => i.status === "ready" && isNewsletterHost(i.url));
  const rows: AuditRow[] = [];
  for (const it of ready) {
    // The reading says where its extracted text is; the layout no longer does.
    const keys = await store.contentKeys(it.id);
    if (keys?.extractedKey == null) continue;
    const md = await deps.r2.readObject(keys.extractedKey, r2Deps);
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

async function deepenStrandedStages(
  rows: AuditRow[],
  tenantId: string,
  sql: Parameters<typeof latestAttemptStage>[0],
): Promise<void> {
  for (const r of rows) {
    if (r.class !== "stranded") continue;
    const stage = await latestAttemptStage(sql, tenantId, r.reading_id);
    if (stage) r.stuck_stage = stage;
  }
}

async function runCorpusAudit(argv: string[], deps: CorpusAuditDeps): Promise<number> {
  const args = parseAuditArgs(argv);
  const selector = requireOperatorTenant(args.tenant);
  const tenant = requireTenantRows(selector);
  const tenantId = String(tenant.tenantId);
  const r2Deps: R2Deps = { bucket: args.bucket, keyRoot: selector.keyRoot, remote: args.remote };
  const { url } = resolveOperatorDatabaseUrl({
    bucket: args.bucket,
    ...(args.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: args.databaseUrlEnv }),
    local: !args.remote,
    env: deps.env,
  });

  return withOperatorSql(
    url,
    async (sql) => {
      const store = operatorReadings(sql, tenant);
      const items = (await listItems(store)) as ListItem[];

      const failed = buildFailedRows(items);
      const failedOrphanDups = buildFailedOrphanDupRows(items);
      const pending = buildPendingRows(items, deps.now());
      if (args.deep) await deepenStrandedStages(pending, tenantId, sql);
      const teasers = args.teasers ? await detectTeasers(items, store, deps, r2Deps) : [];
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
        deps.io.stdout(`Plan: audit ${items.length} readings for tenant ${tenantId}`);
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
          // `tenant` is provenance: corpus recover refuses to act on an audit
          // taken under a different selector.
          { generated: "corpus non-ready inventory", tenant: operatorTenantSelector(selector), totals: tally, rows },
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
          operatorTenantSelector(selector),
          degraded,
        ),
      );
      deps.io.stdout(JSON.stringify(summary, null, 2));
      return 0;
    },
    deps.openSql,
  );
}

export const corpusAuditCommand: CommandDefinition<CorpusAuditDeps> = {
  group: "corpus",
  name: "audit",
  summary: "Inventory non-ready readings into index.json + INDEX.md",
  safety: "plan-first",
  helpText: `Reads the tenant's readings from PostgreSQL and classifies every reading that
is not ready. Plan mode reads and classifies but writes nothing; --execute
writes index.json + INDEX.md. Never writes to the corpus.

Options:
  --bucket <name>   Data bucket, which selects the database. Default:
                    READING_LITE_BUCKET env, then reading-lite.
  --tenant <selector>  REQUIRED: the tenant id (usr_…) whose corpus to audit.
${DATABASE_URL_ENV_FLAG_HELP}
  --out <dir>       Output directory for index.json + INDEX.md. Default: cwd.
  --teasers         Also scan ready pragmaticengineer/substack readings for
                    paywall teasers (reads their content from R2; slower).
  --degraded        Also list ready YouTube readings that recorded an
                    enrichment miss (no extra reads).
  --deep            Resolve the true stuck stage of stranded pending readings
                    from their attempt rows.
  --local           Read this checkout's local database and R2 cache.
  --execute         Write the report files.
  --help            Show this message.

--teasers additionally requires a Cloudflare session (wrangler login /
CLOUDFLARE_API_TOKEN) to read content from R2.`,
  defaultDeps: (io: CommandIo): CorpusAuditDeps => ({
    io,
    r2: { readObject: wranglerR2.readObject },
    openSql: openOperatorSql,
    env: process.env,
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
