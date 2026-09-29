// `ops corpus redact-key-echoes` — find stored error text that still carries a
// provider key fragment, and redact it in place (reading-lite-gh341.14).
//
// Before reading-lite-gh341.1, a provider's error text was stored verbatim,
// and OpenAI's 401 echoes a masked piece of the key it rejected ("Incorrect
// API key provided: sk-proj-****wxyz"). gh341.1 redacts every new write. The
// rows written before it keep the fragment, and every one of them is served:
// `readings.error` and the attempt summaries through the reading API, MCP and
// the frontend, and each `reading_attempts` row's error and stage events
// through `GET /api/readings/:id/diagnostics`.
//
// A reprocess replaces only the reading's own error. It never rewrites an
// earlier attempt row, so it cannot clear the diagnostics history, and it pays
// for a summary to do what it does clear. This command applies the same
// `redactProviderKeys` the write path now applies, to the rows already stored,
// at no provider cost. Whether a failed reading should then be recovered is a
// separate question for `corpus audit` and `corpus recover`.
//
// Every string in the error-bearing JSONB columns is passed through the
// redaction, not just `message`, so a key shape anywhere in them is caught.
// PostgreSQL narrows the scan to rows whose text contains `sk-` at all; the
// redaction itself decides, so the SQL never carries a second copy of the key
// pattern. The redaction fails safe, so a fetch error naming a host such as
// sk-hynix.com is a hit too, exactly as it is on the write path.
//
// Plan mode is the read-only scan: it names each row and field that would
// change, printing only the redacted text, never the fragment itself.
// --execute rewrites them one reading per transaction, locking the reading row
// first as every writer verb does and redacting what it reads under that lock,
// then scans again and exits 1 if anything is left. It changes no status,
// ownership or content, and leaves `updated_at` alone: a scrub is not a
// reprocess, and bumping it would pull every scrubbed reading into the next
// neighbour refresh's scope.

import { parseArgs } from "node:util";
import { redactProviderKeys } from "../../../src/modules/provider-error-text";
import type { Sql, SqlQuery } from "../../../src/modules/db/sql";
import { resolveBucket } from "../../corpus-lib/config";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { DATABASE_URL_ENV_FLAG_HELP, openOperatorSql, type OpenOperatorSql } from "../../pg-lib/operator-db";
import { withOperatorCorpus } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export interface CorpusRedactKeyEchoesDeps extends BaseDeps {
  openSql: OpenOperatorSql;
  env: Record<string, string | undefined>;
}

interface Args {
  bucket: string;
  tenant?: string;
  databaseUrlEnv?: string;
  local: boolean;
  execute: boolean;
}

const READING_COLUMNS = ["error", "active_attempt", "last_attempt", "enrichment_degradation"] as const;
const ATTEMPT_COLUMNS = ["error", "events"] as const;

/** One stored row with at least one key-shaped string in it. */
export interface KeyEchoFinding {
  reading_id: string;
  /** Absent for the reading row itself. */
  attempt_id?: string;
  status: string;
  /** JSON paths that change, e.g. `last_attempt.error.message`, `events[2].error.message`. */
  fields: string[];
  /** Each changed string after redaction; the original is never printed. */
  redacted: string[];
}

interface Redacted {
  value: unknown;
  paths: string[];
  after: string[];
}

/** `value` with every string passed through `redactProviderKeys`, and where that changed it. */
export function redactStrings(value: unknown, path: string): Redacted {
  if (typeof value === "string") {
    const next = redactProviderKeys(value);
    return next === value ? { value, paths: [], after: [] } : { value: next, paths: [path], after: [next] };
  }
  if (Array.isArray(value)) {
    const out: Redacted = { value: [], paths: [], after: [] };
    value.forEach((item, i) => {
      const r = redactStrings(item, `${path}[${i}]`);
      (out.value as unknown[]).push(r.value);
      out.paths.push(...r.paths);
      out.after.push(...r.after);
    });
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Redacted = { value: {}, paths: [], after: [] };
    for (const [key, item] of Object.entries(value)) {
      const r = redactStrings(item, `${path}.${key}`);
      (out.value as Record<string, unknown>)[key] = r.value;
      out.paths.push(...r.paths);
      out.after.push(...r.after);
    }
    return out;
  }
  return { value, paths: [], after: [] };
}

type Row = Record<string, unknown>;

/** The columns of `row` that redaction changes, with their new values. */
function redactColumns(row: Row, columns: readonly string[]): { changes: Map<string, unknown>; paths: string[]; after: string[] } {
  const changes = new Map<string, unknown>();
  const paths: string[] = [];
  const after: string[] = [];
  for (const column of columns) {
    if (row[column] == null) continue;
    const r = redactStrings(row[column], column);
    if (r.paths.length === 0) continue;
    changes.set(column, r.value);
    paths.push(...r.paths);
    after.push(...r.after);
  }
  return { changes, paths, after };
}

// A broad prefilter: any row whose JSON text mentions `sk-` at all. The
// redaction decides which of them actually match.
const mentions = (columns: readonly string[]) =>
  columns.map((column) => `strpos(COALESCE(${column}::text, ''), 'sk-') > 0`).join(" OR ");

export async function scanKeyEchoes(sql: SqlQuery, tenantId: string): Promise<KeyEchoFinding[]> {
  const findings: KeyEchoFinding[] = [];
  const readings = await sql.query(
    `SELECT id, status, ${READING_COLUMNS.join(", ")} FROM readings
     WHERE tenant_id = $1 AND (${mentions(READING_COLUMNS)}) ORDER BY id`,
    [tenantId],
  );
  for (const row of readings) {
    const { paths, after } = redactColumns(row, READING_COLUMNS);
    if (paths.length > 0) {
      findings.push({ reading_id: String(row.id), status: String(row.status), fields: paths, redacted: after });
    }
  }
  const attempts = await sql.query(
    `SELECT reading_id, id, status, ${ATTEMPT_COLUMNS.join(", ")} FROM reading_attempts
     WHERE tenant_id = $1 AND (${mentions(ATTEMPT_COLUMNS)}) ORDER BY reading_id, started_at, id`,
    [tenantId],
  );
  for (const row of attempts) {
    const { paths, after } = redactColumns(row, ATTEMPT_COLUMNS);
    if (paths.length > 0) {
      findings.push({
        reading_id: String(row.reading_id),
        attempt_id: String(row.id),
        status: String(row.status),
        fields: paths,
        redacted: after,
      });
    }
  }
  return findings;
}

function setClause(changes: Map<string, unknown>, offset: number): { clause: string; values: string[] } {
  const columns = [...changes.keys()];
  return {
    clause: columns.map((column, i) => `${column} = $${i + offset}::jsonb`).join(", "),
    values: columns.map((column) => JSON.stringify(changes.get(column))),
  };
}

/**
 * Redacts one reading's row and attempt rows in one transaction, from what it
 * reads under the reading's row lock. Returns how many rows it rewrote; a
 * reading deleted since the scan is left deleted.
 */
async function redactReading(sql: Sql, tenantId: string, readingId: string): Promise<number> {
  return sql.transaction(async (tx) => {
    const [reading] = await tx.query(
      `SELECT ${READING_COLUMNS.join(", ")} FROM readings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, readingId],
    );
    if (!reading) return 0;
    let rewritten = 0;
    const own = redactColumns(reading, READING_COLUMNS);
    if (own.changes.size > 0) {
      const { clause, values } = setClause(own.changes, 3);
      await tx.query(`UPDATE readings SET ${clause} WHERE tenant_id = $1 AND id = $2`, [tenantId, readingId, ...values]);
      rewritten++;
    }
    const attempts = await tx.query(
      `SELECT id, ${ATTEMPT_COLUMNS.join(", ")} FROM reading_attempts
       WHERE tenant_id = $1 AND reading_id = $2 AND (${mentions(ATTEMPT_COLUMNS)}) FOR UPDATE`,
      [tenantId, readingId],
    );
    for (const attempt of attempts) {
      const { changes } = redactColumns(attempt, ATTEMPT_COLUMNS);
      if (changes.size === 0) continue;
      const { clause, values } = setClause(changes, 4);
      await tx.query(
        `UPDATE reading_attempts SET ${clause} WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
        [tenantId, readingId, String(attempt.id), ...values],
      );
      rewritten++;
    }
    return rewritten;
  });
}

function parseRedactArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        tenant: { type: "string" },
        "database-url-env": { type: "string" },
        local: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  return {
    bucket: resolveBucket(values.bucket),
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    ...(values["database-url-env"] === undefined ? {} : { databaseUrlEnv: values["database-url-env"] }),
    local: values.local === true,
    execute: values.execute === true,
  };
}

function printFindings(io: CommandIo, findings: readonly KeyEchoFinding[]): void {
  for (const f of findings) {
    const where = f.attempt_id === undefined ? `${f.reading_id} (${f.status})` : `${f.reading_id} attempt ${f.attempt_id} (${f.status})`;
    f.fields.forEach((field, i) => io.stderr(`  ${where} ${field}: ${f.redacted[i]}`));
  }
}

const readingsIn = (findings: readonly KeyEchoFinding[]) => [...new Set(findings.map((f) => f.reading_id))];

async function runCorpusRedactKeyEchoes(argv: string[], deps: CorpusRedactKeyEchoesDeps): Promise<number> {
  const args = parseRedactArgs(argv);
  const selector = requireOperatorTenant(args.tenant);
  return withOperatorCorpus(
    { bucket: args.bucket, tenant: selector, local: args.local, databaseUrlEnv: args.databaseUrlEnv },
    deps.env,
    deps.openSql,
    async ({ sql, tenantId }) => {
      const found = await scanKeyEchoes(sql, tenantId);
      const summary = {
        mode: args.execute ? "execute" : "plan",
        tenant: operatorTenantSelector(selector),
        readings_matched: readingsIn(found).length,
        reading_rows_matched: found.filter((f) => f.attempt_id === undefined).length,
        attempt_rows_matched: found.filter((f) => f.attempt_id !== undefined).length,
        rows_rewritten: 0,
        rows_remaining: found.length,
      };
      printFindings(deps.io, found);
      if (!args.execute) {
        if (found.length > 0) deps.io.stderr("PLAN — nothing changed. Rerun with --execute to redact these rows.");
        deps.io.stdout(JSON.stringify(summary, null, 2));
        return 0;
      }
      for (const readingId of readingsIn(found)) {
        summary.rows_rewritten += await redactReading(sql, tenantId, readingId);
      }
      const left = await scanKeyEchoes(sql, tenantId);
      summary.rows_remaining = left.length;
      if (left.length > 0) {
        deps.io.stderr(`${left.length} row(s) still match after redaction:`);
        printFindings(deps.io, left);
      }
      deps.io.stdout(JSON.stringify(summary, null, 2));
      return left.length > 0 ? 1 : 0;
    },
  );
}

export const corpusRedactKeyEchoesCommand: CommandDefinition<CorpusRedactKeyEchoesDeps> = {
  group: "corpus",
  name: "redact-key-echoes",
  summary: "Find and redact provider key fragments in stored reading errors",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus redact-key-echoes --tenant <usr_…> [options]

Scans the tenant's readings (error, active_attempt, last_attempt,
enrichment_degradation) and reading_attempts rows (error, events) for text a
provider key redaction would change — an echoed key fragment such as
sk-proj-****wxyz, stored before errors were redacted on write. Plan mode lists
each row and field, showing only the redacted text, and changes nothing.

--execute rewrites those strings to the redacted form, one reading per
transaction under its row lock, then scans again and exits 1 if any row still
matches. No status, ownership, content or updated_at changes, and no provider
is called.

Options:
  --tenant <selector>   REQUIRED: the tenant id (usr_…) whose rows to scan.
  --bucket <name>       Data bucket, which selects the database. Default:
                        READING_LITE_BUCKET / reading-lite.
${DATABASE_URL_ENV_FLAG_HELP}
  --local               Use this checkout's local database.
  --execute             Redact the rows the plan lists.
  --help                Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRedactKeyEchoesDeps => ({
    io,
    openSql: openOperatorSql,
    env: process.env,
  }),
  run: runCorpusRedactKeyEchoes,
};
