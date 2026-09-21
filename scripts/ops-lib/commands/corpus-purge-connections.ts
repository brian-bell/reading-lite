// `ops corpus purge-connections` — remove dangling inbound relationship rows
// for one already-deleted reading.
//
// `reading_relationships` has a foreign key on the source only, so deleting a
// reading cascades away the rows it cites but leaves every row that cites IT
// as `target_id`. Those are the dangling inbound entries, and one statement
// removes them.
//
// This covers connections AND tensions. The manifest-era command only rewrote
// `connections[]`, but a tension naming a deleted reading dangles exactly the
// same way, and the rows live in one table keyed by `target_id`. The audit
// counts rows, so a purge that removes judged tension data says so in its
// output rather than doing it silently.
//
// Before reading-lite-gh347.4.7 this was an offline full-corpus sweep: list
// every manifest in R2, parse and validate each one, rewrite the matches under
// a compare-and-set loop with ETag witnesses and a retry budget, and refuse to
// run unless the operator asserted `--sole-writer`. All of that existed
// because the relationship lived inside a document that other writers also
// owned. It does not any more, so the scan, the CAS loop, the conflict budget
// and the sole-writer assertion are gone with it.
//
// Plan-first: a mode-less run counts what it would delete; --execute deletes.

import { parseArgs } from "node:util";
import { parseReadingId } from "../../../src/services";
import { resolveBucket } from "../../corpus-lib/config";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import {
  DATABASE_URL_ENV_FLAG_HELP,
  openOperatorSql,
  resolveOperatorDatabaseUrl,
  withOperatorSql,
  type OpenOperatorSql,
} from "../../pg-lib/operator-db";
import {
  deleteInboundRelationships,
  operatorReadings,
  requireTenantRows,
} from "../../pg-lib/operator-corpus";
import type { SqlQuery } from "../../../src/modules/db/sql";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export interface CorpusPurgeConnectionsDeps extends BaseDeps {
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
}

interface Args {
  bucket: string;
  tenant?: string;
  databaseUrlEnv?: string;
  id: string;
  local: boolean;
  execute: boolean;
}

interface Audit {
  mode: "plan" | "execute";
  tenant: string;
  tenant_audit_stamp: { tenant_id: string } | null;
  target_id: string;
  /** Inbound relationship rows naming the target. */
  relationships_matched: number;
  /** Distinct source readings carrying at least one of them. */
  sources_matched: number;
  /** Of the matched rows, how many are judged tensions rather than connections. */
  tensions_matched: number;
  relationships_would_delete: number;
  relationships_deleted: number;
  failures: number;
  failure_code: "invalid_target" | "target_present" | "storage_error" | null;
  failure_stage: FailureStage | null;
}

type FailureStage =
  | "validate_target"
  | "connect"
  | "check_target"
  | "scan_relationships"
  | "delete_relationships";

interface RunContext {
  stage: FailureStage;
}

function parsePurgeArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        tenant: { type: "string" },
        "database-url-env": { type: "string" },
        id: { type: "string" },
        local: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.id) throw new UsageError("--id is required");
  return {
    bucket: resolveBucket(values.bucket),
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    ...(values["database-url-env"] === undefined
      ? {}
      : { databaseUrlEnv: values["database-url-env"] }),
    id: values.id,
    local: values.local === true,
    execute: values.execute === true,
  };
}

function emitAudit(io: CommandIo, audit: Audit): void {
  io.stdout(JSON.stringify(audit));
}

function recordFailure(
  audit: Audit,
  code: Exclude<Audit["failure_code"], null>,
  stage: FailureStage,
): void {
  audit.failures += 1;
  audit.failure_code = code;
  audit.failure_stage = stage;
}

async function countInbound(
  sql: SqlQuery,
  tenantId: string,
  targetId: string,
): Promise<{ rows: number; sources: number; tensions: number }> {
  const [row] = await sql.query<{ rows: number; sources: number; tensions: number }>(
    `SELECT count(*)::int AS rows, count(DISTINCT source_id)::int AS sources,
            count(*) FILTER (WHERE kind = 'tension')::int AS tensions
     FROM reading_relationships WHERE tenant_id = $1 AND target_id = $2`,
    [tenantId, targetId],
  );
  return { rows: row?.rows ?? 0, sources: row?.sources ?? 0, tensions: row?.tensions ?? 0 };
}

async function runCorpusPurgeConnections(
  argv: string[],
  deps: CorpusPurgeConnectionsDeps,
): Promise<number> {
  const args = parsePurgeArgs(argv);
  const selector = requireOperatorTenant(args.tenant);
  const audit: Audit = {
    mode: args.execute ? "execute" : "plan",
    tenant: operatorTenantSelector(selector),
    tenant_audit_stamp: selector.kind === "tenant" ? { tenant_id: selector.tenantId } : null,
    target_id: args.id,
    relationships_matched: 0,
    sources_matched: 0,
    tensions_matched: 0,
    relationships_would_delete: 0,
    relationships_deleted: 0,
    failures: 0,
    failure_code: null,
    failure_stage: null,
  };

  if (parseReadingId(args.id) !== args.id) {
    recordFailure(audit, "invalid_target", "validate_target");
    deps.io.stderr("REFUSED: --id must be a valid reading id");
    emitAudit(deps.io, audit);
    return 2;
  }

  const tenant = requireTenantRows(selector);
  const tenantId = String(tenant.tenantId);
  const { url } = resolveOperatorDatabaseUrl({
    bucket: args.bucket,
    ...(args.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: args.databaseUrlEnv }),
    local: args.local,
    env: deps.env,
  });

  const context: RunContext = { stage: "connect" };
  let code: number;
  try {
    code = await withOperatorSql(
      url,
      async (sql) => {
        const store = operatorReadings(sql, tenant);

        // The target must already be gone. Purging inbound citations of a
        // reading that still exists would silently sever live connections.
        context.stage = "check_target";
        if (await store.loadReadingById(args.id)) {
          recordFailure(audit, "target_present", "check_target");
          deps.io.stderr(`REFUSED: target ${args.id} still exists in this corpus`);
          return 1;
        }

        context.stage = "scan_relationships";
        const found = await countInbound(sql, tenantId, args.id);
        audit.relationships_matched = found.rows;
        audit.sources_matched = found.sources;
        audit.tensions_matched = found.tensions;
        audit.relationships_would_delete = found.rows;
        if (found.tensions > 0) {
          deps.io.stderr(
            `${found.tensions} of these are judged tensions, which cost provider spend to produce.`,
          );
        }

        if (!args.execute || found.rows === 0) return 0;

        context.stage = "delete_relationships";
        audit.relationships_deleted = await deleteInboundRelationships(sql, tenantId, args.id);
        return 0;
      },
      deps.openSql,
    );
  } catch {
    recordFailure(audit, "storage_error", context.stage);
    deps.io.stderr(`purge-connections database operation failed during ${context.stage}`);
    code = 1;
  }
  emitAudit(deps.io, audit);
  return code;
}

export const corpusPurgeConnectionsCommand: CommandDefinition<CorpusPurgeConnectionsDeps> = {
  group: "corpus",
  name: "purge-connections",
  summary: "Remove dangling inbound relationships to one deleted reading",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus purge-connections --tenant <selector> --id <reading-id> [options]

Deletes every relationship row in the selected tenant's corpus that names the
given deleted reading as its target — connections and judged tensions alike,
both of which dangle the same way. The audit reports the tension count
separately, since those cost provider spend to produce. The target must already be absent: a
reading's own outbound rows cascade with it, but inbound ones do not, and that
is what this cleans up. Plans by default.

Options:
  --id <reading-id>     REQUIRED: deleted bare reading id to purge citations of.
  --tenant <selector>   REQUIRED: the tenant id (usr_…) whose corpus to purge.
  --bucket <name>       Data bucket, which selects the database. Default:
                        READING_LITE_BUCKET / reading-lite.
${DATABASE_URL_ENV_FLAG_HELP}
  --local               Use this checkout's local database.
  --execute             Apply the plan.
  --help                Show this message.`,
  defaultDeps: (io: CommandIo): CorpusPurgeConnectionsDeps => ({
    io,
    openSql: openOperatorSql,
    env: process.env,
  }),
  run: runCorpusPurgeConnections,
};
