// `ops corpus refresh-status` reads one tenant's hosted relationship-refresh
// cursor, checkpoint rows, and tension counts. It never writes.

import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { r2InventoryClientFromVars } from "../../lib/cf-clients";
import { loadDotVars } from "../../lib/dotvars";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import {
  databaseTargetForBucket,
  DATABASE_URL_ENV_FLAG_HELP,
  openOperatorSql,
  resolveOperatorDatabaseUrl,
} from "../../pg-lib/operator-db";
import { requireTenantRows } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import { requireOperatorTenant, TENANT_FLAG_HELP } from "../tenant-flag";
import {
  assertRefreshStatusRead,
  cursorObservation,
  formatRefreshStatus,
  parseConnectionUncertain,
  parseCorpusRow,
  parseCounts,
  parseDanglingSample,
  parseJudgedCount,
  parseRunCounts,
  parseTablePresent,
  parseTensionUncertain,
  parseVerdicts,
  redactOperatorText,
  refreshCursorKey,
  refreshStatusExit,
  secretValues,
  type CorpusHealth,
  type CursorView,
  type RefreshObservation,
  type RefreshStatusReport,
  type TensionCheckpoint,
} from "../refresh-status";

const CONNECTION_COUNTS = `SELECT count(*)::int AS total,
       count(result_json)::int AS with_result,
       (count(*) - count(result_json))::int AS no_result,
       count(*) FILTER (WHERE retry_at > now() - interval '2 days')::int AS recent_retry
FROM relationship_refresh_jobs
WHERE tenant_id = $1`;

const CONNECTION_BY_RUN = `SELECT run_at, count(*)::int AS n, count(result_json)::int AS with_result
FROM relationship_refresh_jobs
WHERE tenant_id = $1
GROUP BY run_at
ORDER BY run_at DESC
LIMIT 5`;

const CONNECTION_UNCERTAIN = `SELECT reading_id, run_at, retry_at
FROM relationship_refresh_jobs
WHERE tenant_id = $1 AND result_json IS NULL
ORDER BY run_at DESC, reading_id
LIMIT 15`;

const TENSION_TABLE = `SELECT to_regclass('public.tension_refresh_jobs') IS NOT NULL AS present`;

const TENSION_COUNTS = `SELECT count(*)::int AS total,
       count(result_json)::int AS with_result,
       (count(*) - count(result_json))::int AS no_result,
       count(*) FILTER (WHERE retry_at > now() - interval '2 days')::int AS recent_retry
FROM tension_refresh_jobs
WHERE tenant_id = $1`;

const TENSION_BY_RUN = `SELECT run_at, count(*)::int AS n, count(result_json)::int AS with_result
FROM tension_refresh_jobs
WHERE tenant_id = $1
GROUP BY run_at
ORDER BY run_at DESC
LIMIT 5`;

const TENSION_VERDICTS = `SELECT coalesce(result_json->'judgement'->>'verdict', '(no result)') AS verdict,
       count(*)::int AS n
FROM tension_refresh_jobs
WHERE tenant_id = $1
  AND run_at = (SELECT max(run_at) FROM tension_refresh_jobs WHERE tenant_id = $1)
GROUP BY 1
ORDER BY 2 DESC`;

const TENSION_UNCERTAIN = `SELECT reading_a, reading_b, run_at, retry_at
FROM tension_refresh_jobs
WHERE tenant_id = $1 AND result_json IS NULL
ORDER BY run_at DESC, reading_a
LIMIT 15`;

const CORPUS_TENSIONS = `WITH ready AS (
  SELECT id FROM readings WHERE tenant_id = $1 AND status = 'ready'
),
t AS (
  SELECT source_id, target_id FROM reading_relationships
  WHERE tenant_id = $1 AND kind = 'tension' AND source_id IN (SELECT id FROM ready)
)
SELECT count(*)::int AS tension_rows,
       count(DISTINCT source_id)::int AS readings_with_tensions,
       count(*) FILTER (WHERE target_id NOT IN (SELECT id FROM ready))::int AS dangling,
       count(*) FILTER (WHERE target_id IN (SELECT id FROM ready)
         AND NOT EXISTS (
           SELECT 1 FROM t AS mirror
           WHERE mirror.source_id = t.target_id AND mirror.target_id = t.source_id
         ))::int AS one_sided
FROM t`;

const DANGLING_JUDGED = `SELECT count(*)::int AS n
FROM readings AS rd
JOIN reading_revisions AS v
  ON (v.tenant_id, v.reading_id, v.id) = (rd.tenant_id, rd.id, rd.current_revision_id)
CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.tensions_judged, '[]'::jsonb)) AS judged
WHERE rd.tenant_id = $1
  AND rd.status = 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM readings AS partner
    WHERE partner.tenant_id = $1 AND partner.id = judged->>'id' AND partner.status = 'ready'
  )`;

const DANGLING_SAMPLE = `SELECT source_id, target_id
FROM reading_relationships
WHERE tenant_id = $1
  AND kind = 'tension'
  AND NOT EXISTS (
    SELECT 1 FROM readings AS partner
    WHERE partner.tenant_id = $1 AND partner.id = reading_relationships.target_id AND partner.status = 'ready'
  )
ORDER BY source_id
LIMIT 10`;

export interface RefreshStatusR2 {
  get(key: string): Promise<string | null>;
  listObjects(prefix?: string): Promise<Array<{ key: string; etag: string; lastModified?: string }>>;
}

export interface RefreshStatusSql {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  end(): Promise<void>;
}

export interface RefreshStatusDeps extends BaseDeps {
  env: Record<string, string | undefined>;
  loadVars: () => Record<string, string | undefined>;
  openSql: (url: string) => RefreshStatusSql;
  openR2: (vars: Record<string, string | undefined>, bucket: string) => RefreshStatusR2;
}

interface StatusArgs {
  tenant: OperatorTenant;
  bucket: string;
  databaseUrlEnv: string | undefined;
  local: boolean;
  json: boolean;
}

function parseStatusArgs(argv: string[]): Omit<StatusArgs, "tenant"> & { tenantSelector: string | undefined } {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tenant: { type: "string" },
        bucket: { type: "string", default: "reading-lite" },
        "database-url-env": { type: "string" },
        local: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    tenantSelector: values.tenant,
    bucket: values.bucket ?? "reading-lite",
    databaseUrlEnv: values["database-url-env"],
    local: values.local === true,
    json: values.json === true,
  };
}

function configurationUnavailable(error: unknown): boolean {
  return error instanceof UsageError && (error.message.includes("is not set") || error.message.includes("none of "));
}

async function readCursor(
  r2: RefreshStatusR2,
  key: string,
  secrets: readonly string[],
): Promise<RefreshStatusReport["cursor"]> {
  let body: string | null;
  try {
    body = await r2.get(key);
  } catch (error) {
    return {
      key,
      status: "failed",
      reason: redactOperatorText(error instanceof Error ? error.message : "R2 read failed", secrets),
    };
  }
  if (body == null) return cursorObservation(key, null, null);
  let object: CursorView["object"] | null = null;
  try {
    const listed = await r2.listObjects(key);
    const match = listed.find((item) => item.key === key);
    object = match
      ? { status: "ok", etag: match.etag, last_modified: match.lastModified ?? null }
      : { status: "unavailable", reason: "object metadata was not listed" };
  } catch (error) {
    object = {
      status: "unavailable",
      reason: redactOperatorText(error instanceof Error ? error.message : "R2 list failed", secrets),
    };
  }
  return cursorObservation(key, body, object);
}

async function queryOne<Row extends Record<string, unknown>>(
  sql: RefreshStatusSql,
  text: string,
  values: unknown[],
): Promise<Row> {
  assertRefreshStatusRead(text);
  const rows = await sql.query<Row>(text, values);
  const row = rows[0];
  if (!row) throw new Error("PostgreSQL returned no row for a count");
  return row;
}

async function queryAll<Row extends Record<string, unknown>>(
  sql: RefreshStatusSql,
  text: string,
  values: unknown[],
): Promise<Row[]> {
  assertRefreshStatusRead(text);
  return sql.query<Row>(text, values);
}

function failed<T>(error: unknown, secrets: readonly string[]): RefreshObservation<T> {
  const message = error instanceof Error ? error.message : "PostgreSQL read failed";
  const reason = message === "PostgreSQL returned an unexpected row"
    ? message
    : redactOperatorText(message, secrets);
  return { status: "failed", reason };
}

async function readConnection(
  sql: RefreshStatusSql,
  tenantId: string,
  secrets: readonly string[],
): Promise<RefreshStatusReport["checkpoints"]["connection"]> {
  try {
    const counts = parseCounts(await queryOne(sql, CONNECTION_COUNTS, [tenantId]));
    const byRun = parseRunCounts(await queryAll(sql, CONNECTION_BY_RUN, [tenantId]));
    const uncertain = parseConnectionUncertain(await queryAll(sql, CONNECTION_UNCERTAIN, [tenantId]));
    return { status: "ok", value: { counts, by_run_at: byRun, uncertain } };
  } catch (error) {
    return failed(shapeError(error), secrets);
  }
}

async function readTension(
  sql: RefreshStatusSql,
  tenantId: string,
  secrets: readonly string[],
): Promise<RefreshObservation<TensionCheckpoint>> {
  try {
    const present = parseTablePresent(await queryOne(sql, TENSION_TABLE, []));
    if (!present) return { status: "missing", reason: "tension_refresh_jobs is not installed" };
    const counts = parseCounts(await queryOne(sql, TENSION_COUNTS, [tenantId]));
    const byRun = parseRunCounts(await queryAll(sql, TENSION_BY_RUN, [tenantId]));
    const verdicts = parseVerdicts(await queryAll(sql, TENSION_VERDICTS, [tenantId]));
    const uncertain = parseTensionUncertain(await queryAll(sql, TENSION_UNCERTAIN, [tenantId]));
    return { status: "ok", value: { counts, by_run_at: byRun, verdicts, uncertain } };
  } catch (error) {
    return failed(shapeError(error), secrets);
  }
}

async function readCorpus(
  sql: RefreshStatusSql,
  tenantId: string,
  secrets: readonly string[],
): Promise<RefreshObservation<CorpusHealth>> {
  try {
    const totals = parseCorpusRow(await queryOne(sql, CORPUS_TENSIONS, [tenantId]));
    const danglingJudged = parseJudgedCount(await queryOne(sql, DANGLING_JUDGED, [tenantId]));
    const sample = parseDanglingSample(await queryAll(sql, DANGLING_SAMPLE, [tenantId]));
    return {
      status: "ok",
      value: { ...totals, dangling_judged_records: danglingJudged, dangling_sample: sample },
    };
  } catch (error) {
    return failed(shapeError(error), secrets);
  }
}

function shapeError(error: unknown): Error {
  if (error instanceof ZodError) return new Error("PostgreSQL returned an unexpected row");
  return error instanceof Error ? error : new Error("PostgreSQL read failed");
}

async function readDatabase(
  sql: RefreshStatusSql,
  tenantId: string,
  secrets: readonly string[],
): Promise<Pick<RefreshStatusReport, "checkpoints" | "corpus">> {
  const connection = await readConnection(sql, tenantId, secrets);
  const tension = await readTension(sql, tenantId, secrets);
  const corpus = await readCorpus(sql, tenantId, secrets);
  return { checkpoints: { connection, tension }, corpus };
}

function databaseUnavailable(reason: string): Pick<RefreshStatusReport, "checkpoints" | "corpus"> {
  const section = { status: "unavailable" as const, reason };
  return { checkpoints: { connection: section, tension: section }, corpus: section };
}

export const corpusRefreshStatusCommand: CommandDefinition<RefreshStatusDeps> = {
  group: "corpus",
  name: "refresh-status",
  safety: "read-only",
  summary: "Show one tenant's hosted relationship-refresh progress",
  helpText: `Usage: npm run ops -- corpus refresh-status --tenant <usr_…> [--json]

Reads the refresh cursor, both checkpoint tables, and corpus tension counts.
Prints ids and counts. Does not print the cursor token, summary text, or secrets.
A missing object, a missing table, and a failed read are statuses. A count of zero is status ok.

Options:
  ${TENANT_FLAG_HELP}
  --bucket <name>     reading-lite (default) or reading-lite-staging. The bucket
                      selects the database. --tenant global is rejected.
  --json              Print one JSON document instead of text.
  --local             Read this checkout's PostgreSQL and the unprefixed cursor
                      key. Never uses a deployed connection string.
${DATABASE_URL_ENV_FLAG_HELP}

R2: CORPUS_R2_ACCOUNT_ID with CORPUS_R2_ACCESS_KEY and CORPUS_R2_SECRET_KEY, or
CLOUDFLARE_API_TOKEN / CORPUS_CF_API_TOKEN. Names only. Values are never printed.

Exit 0 when every section is ok, missing, or invalid. Exit 1 when a section is
unavailable or failed. Exit 2 for usage errors.`,
  defaultDeps: (io) => ({
    io,
    env: process.env,
    loadVars: () => ({ ...loadDotVars(".corpus.vars"), ...process.env }),
    openSql: openOperatorSql,
    openR2: (vars, bucket) => r2InventoryClientFromVars(vars, bucket),
  }),
  async run(argv, deps) {
    const parsed = parseStatusArgs(argv);
    const selected = requireOperatorTenant(parsed.tenantSelector);
    const tenant = requireTenantRows(selected);
    databaseTargetForBucket(parsed.bucket);
    const key = refreshCursorKey(selected, parsed.local);
    const vars = deps.loadVars();
    const secrets = secretValues({ ...vars, ...deps.env });
    let database: { url: string } | RefreshObservation<never>;
    try {
      database = resolveOperatorDatabaseUrl({
        bucket: parsed.bucket,
        databaseUrlEnv: parsed.databaseUrlEnv,
        local: parsed.local,
        env: deps.env,
      });
      secrets.push(database.url);
    } catch (error) {
      if (!configurationUnavailable(error)) throw error;
      database = {
        status: "unavailable",
        reason: redactOperatorText(error instanceof Error ? error.message : "database is not configured", secrets),
      };
    }

    let cursor: RefreshStatusReport["cursor"];
    try {
      const r2 = deps.openR2(vars, parsed.bucket);
      cursor = await readCursor(r2, key, secrets);
    } catch (error) {
      cursor = {
        key,
        status: "unavailable",
        reason: redactOperatorText(error instanceof Error ? error.message : "R2 is not configured", secrets),
      };
    }

    let postgres: Pick<RefreshStatusReport, "checkpoints" | "corpus">;
    if ("url" in database) {
      let sql: RefreshStatusSql | undefined;
      try {
        sql = deps.openSql(database.url);
        postgres = await readDatabase(sql, tenant.tenantId, secrets);
      } catch (error) {
        const reason = redactOperatorText(error instanceof Error ? error.message : "PostgreSQL read failed", secrets);
        const section = { status: "failed" as const, reason };
        postgres = { checkpoints: { connection: section, tension: section }, corpus: section };
      } finally {
        await sql?.end().catch(() => undefined);
      }
    } else {
      postgres = databaseUnavailable(database.reason);
    }

    const report: RefreshStatusReport = {
      tenant_id: tenant.tenantId,
      bucket: parsed.bucket,
      local: parsed.local,
      cursor,
      ...postgres,
    };
    deps.io.stdout(parsed.json ? JSON.stringify(report, null, 2) : formatRefreshStatus(report));
    return refreshStatusExit(report);
  },
};
