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
  resolveOperatorDatabaseUrl,
} from "../../pg-lib/operator-db";
import {
  isPostgresTimeout,
  neonHttpsSession,
  POSTGRES_READ_TIMED_OUT,
  type ReadOnlyBatch,
  type SqlStatement,
} from "../../pg-lib/neon-https";
import { requireTenantRows } from "../../pg-lib/operator-corpus";
import { sqlFromConnectionString, type Sql } from "../../../src/modules/db/sql";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import { requireOperatorTenant, TENANT_FLAG_HELP } from "../tenant-flag";
import {
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

export interface RefreshStatusDeps extends BaseDeps {
  env: Record<string, string | undefined>;
  loadVars: () => Record<string, string | undefined>;
  openSql: (url: string, timeoutMs?: number) => Sql;
  openHttps?: (url: string) => ReadOnlyBatch;
  openR2: (vars: Record<string, string | undefined>, bucket: string) => RefreshStatusR2;
}

type DbTransport = "postgres" | "https";

const DEFAULT_SECTION_TIMEOUT_MS = 60_000;
const MAX_SECTION_TIMEOUT_MS = 120_000;

interface StatusArgs {
  tenant: OperatorTenant;
  bucket: string;
  databaseUrlEnv: string | undefined;
  local: boolean;
  json: boolean;
  transport: DbTransport;
  sectionTimeoutMs: number;
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
        transport: { type: "string" },
        "section-timeout-ms": { type: "string" },
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
    transport: parseTransport(values.transport),
    sectionTimeoutMs: parseSectionTimeout(values["section-timeout-ms"]),
  };
}

function parseTransport(value: string | undefined): DbTransport {
  if (value === undefined || value === "postgres") return "postgres";
  if (value === "https") return "https";
  throw new UsageError("--transport must be postgres or https");
}

function parseSectionTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SECTION_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new UsageError("--section-timeout-ms must be a positive integer number of milliseconds");
  }
  const parsed = Number(value);
  if (parsed > MAX_SECTION_TIMEOUT_MS) {
    throw new UsageError(`--section-timeout-ms must be at most ${MAX_SECTION_TIMEOUT_MS}`);
  }
  return parsed;
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

function postgresBatch(sql: Sql): ReadOnlyBatch {
  return {
    readOnly(statements) {
      return sql.transaction(async (tx) => {
        const rows: unknown[][] = [];
        for (const statement of statements) rows.push(await tx.query(statement.text, statement.values));
        return rows;
      }, { readOnly: true });
    },
  };
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(POSTGRES_READ_TIMED_OUT)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readBatch(
  source: ReadOnlyBatch,
  statements: readonly SqlStatement[],
  timeoutMs: number,
): Promise<unknown[][]> {
  try {
    return await withDeadline(source.readOnly(statements, timeoutMs), timeoutMs);
  } catch (error) {
    if (isPostgresTimeout(error)) throw new Error(POSTGRES_READ_TIMED_OUT);
    throw error;
  }
}

function oneRow(rows: unknown[]): unknown {
  const row = rows[0];
  if (row === undefined) throw new Error("PostgreSQL returned no row for a count");
  return row;
}

function failed<T>(error: unknown, secrets: readonly string[]): RefreshObservation<T> {
  const message = error instanceof Error ? error.message : "PostgreSQL read failed";
  const reason = message === "PostgreSQL returned an unexpected row"
    ? message
    : redactOperatorText(message, secrets);
  return { status: "failed", reason };
}

async function readConnection(
  source: ReadOnlyBatch,
  tenantId: string,
  secrets: readonly string[],
  timeoutMs: number,
): Promise<RefreshStatusReport["checkpoints"]["connection"]> {
  try {
    const [counts, byRun, uncertain] = await readBatch(source, [
      { text: CONNECTION_COUNTS, values: [tenantId] },
      { text: CONNECTION_BY_RUN, values: [tenantId] },
      { text: CONNECTION_UNCERTAIN, values: [tenantId] },
    ], timeoutMs);
    return {
      status: "ok",
      value: {
        counts: parseCounts(oneRow(counts ?? [])),
        by_run_at: parseRunCounts(byRun),
        uncertain: parseConnectionUncertain(uncertain),
      },
    };
  } catch (error) {
    return failed(shapeError(error), secrets);
  }
}

async function readTension(
  source: ReadOnlyBatch,
  tenantId: string,
  secrets: readonly string[],
  timeoutMs: number,
): Promise<RefreshObservation<TensionCheckpoint>> {
  try {
    const [presentRows] = await readBatch(source, [{ text: TENSION_TABLE, values: [] }], timeoutMs);
    if (!parseTablePresent(oneRow(presentRows ?? []))) {
      return { status: "missing", reason: "tension_refresh_jobs is not installed" };
    }
    const [counts, byRun, verdicts, uncertain] = await readBatch(source, [
      { text: TENSION_COUNTS, values: [tenantId] },
      { text: TENSION_BY_RUN, values: [tenantId] },
      { text: TENSION_VERDICTS, values: [tenantId] },
      { text: TENSION_UNCERTAIN, values: [tenantId] },
    ], timeoutMs);
    return {
      status: "ok",
      value: {
        counts: parseCounts(oneRow(counts ?? [])),
        by_run_at: parseRunCounts(byRun),
        verdicts: parseVerdicts(verdicts),
        uncertain: parseTensionUncertain(uncertain),
      },
    };
  } catch (error) {
    return failed(shapeError(error), secrets);
  }
}

async function readCorpus(
  source: ReadOnlyBatch,
  tenantId: string,
  secrets: readonly string[],
  timeoutMs: number,
): Promise<RefreshObservation<CorpusHealth>> {
  try {
    const [totals, danglingJudged, sample] = await readBatch(source, [
      { text: CORPUS_TENSIONS, values: [tenantId] },
      { text: DANGLING_JUDGED, values: [tenantId] },
      { text: DANGLING_SAMPLE, values: [tenantId] },
    ], timeoutMs);
    return {
      status: "ok",
      value: {
        ...parseCorpusRow(oneRow(totals ?? [])),
        dangling_judged_records: parseJudgedCount(oneRow(danglingJudged ?? [])),
        dangling_sample: parseDanglingSample(sample),
      },
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
  source: ReadOnlyBatch,
  tenantId: string,
  secrets: readonly string[],
  timeoutMs: number,
): Promise<Pick<RefreshStatusReport, "checkpoints" | "corpus">> {
  const connection = await readConnection(source, tenantId, secrets, timeoutMs);
  const tension = await readTension(source, tenantId, secrets, timeoutMs);
  const corpus = await readCorpus(source, tenantId, secrets, timeoutMs);
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
                      key. Never uses a deployed connection string. Cannot be
                      combined with --transport https.
  --transport <name>  postgres (default) or https. postgres opens a direct
                      PostgreSQL connection. https sends each read-only batch
                      with the Neon serverless driver over HTTPS. The flag does
                      not change which database the bucket selects.
  --section-timeout-ms <ms>
                      Limit each database batch. Default ${DEFAULT_SECTION_TIMEOUT_MS}.
                      Maximum ${MAX_SECTION_TIMEOUT_MS}. A timed-out section is
                      failed. The cursor and any finished section are still printed.
${DATABASE_URL_ENV_FLAG_HELP}

R2: CORPUS_R2_ACCOUNT_ID with CORPUS_R2_ACCESS_KEY and CORPUS_R2_SECRET_KEY, or
CLOUDFLARE_API_TOKEN / CORPUS_CF_API_TOKEN. Names only. Values are never printed.

Exit 0 when every section is ok, missing, or invalid. A missing cursor, an
invalid cursor, and a missing tension table are exit 0, and they are not a
healthy result. Healthy means every section is ok and cursor metadata is ok.
Exit 1 when a section is unavailable or failed, including when the cursor
body parsed and only its metadata is unavailable. Exit 2 for usage errors.

PostgreSQL statements run in a read-only transaction. The direct driver sends
BEGIN READ ONLY. The https transport sets the Neon driver's readOnly option on
one HTTPS request per batch. Neither transport retries, and neither inspects
the statement text. The database rejects writes. A statement prefix is not
that guarantee. https has no session, so the tension table check is its own
request.`,
  defaultDeps: (io) => ({
    io,
    env: process.env,
    loadVars: () => ({ ...loadDotVars(".corpus.vars"), ...process.env }),
    openSql: (url, timeoutMs) => sqlFromConnectionString(url, timeoutMs === undefined ? undefined : {
      connectionTimeoutMillis: timeoutMs,
      queryTimeoutMillis: timeoutMs,
    }),
    openHttps: neonHttpsSession,
    openR2: (vars, bucket) => r2InventoryClientFromVars(vars, bucket),
  }),
  async run(argv, deps) {
    const parsed = parseStatusArgs(argv);
    const selected = requireOperatorTenant(parsed.tenantSelector);
    const tenant = requireTenantRows(selected);
    databaseTargetForBucket(parsed.bucket);
    if (parsed.local && parsed.transport === "https") {
      throw new UsageError(
        "--transport https reads Neon over HTTPS. --local uses this checkout's PostgreSQL, so drop one of them.",
      );
    }
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
      let sql: Sql | undefined;
      try {
        let source: ReadOnlyBatch;
        if (parsed.transport === "https") {
          source = (deps.openHttps ?? neonHttpsSession)(database.url);
        } else {
          sql = deps.openSql(database.url, parsed.sectionTimeoutMs);
          source = postgresBatch(sql);
        }
        postgres = await readDatabase(source, tenant.tenantId, secrets, parsed.sectionTimeoutMs);
      } catch (error) {
        const reason = redactOperatorText(error instanceof Error ? error.message : "PostgreSQL read failed", secrets);
        const section = { status: "failed" as const, reason };
        postgres = { checkpoints: { connection: section, tension: section }, corpus: section };
      } finally {
        if (sql) await withDeadline(sql.end().catch(() => undefined), parsed.sectionTimeoutMs).catch(() => undefined);
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
