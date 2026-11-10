import { neon } from "@neondatabase/serverless";
import pg from "pg";
import { parseInt8 } from "../../src/modules/db/sql";

const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_TIMESTAMPTZ = 1184;
const parseTimestamptz = pg.types.getTypeParser(OID_TIMESTAMPTZ) as (value: string) => Date;

// Same parsers as `sqlFromConnectionString`. Neon HTTP returns raw text and
// otherwise parses timestamptz as a Date, which the status row schemas reject.
const neonHttpsTypes: pg.CustomTypesConfig = {
  getTypeParser(oid: number, format?: string) {
    if (format !== "binary") {
      if (oid === OID_INT8) return parseInt8;
      if (oid === OID_DATE) return (value: string) => value;
      if (oid === OID_TIMESTAMPTZ) return (value: string) => parseTimestamptz(value).toISOString();
    }
    return pg.types.getTypeParser(oid, format as "text");
  },
};

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export interface ReadOnlyBatch {
  readOnly(statements: readonly SqlStatement[], timeoutMs: number): Promise<unknown[][]>;
}

export const POSTGRES_READ_TIMED_OUT = "PostgreSQL read timed out";

export function isPostgresTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError"
    || error.name === "AbortError"
    || /timed out|timeout/i.test(error.message);
}

export function neonHttpsSession(url: string): ReadOnlyBatch {
  const sql = neon(url);
  return {
    async readOnly(statements, timeoutMs) {
      if (statements.length === 0) throw new Error("PostgreSQL read failed");
      try {
        const results = await sql.transaction(
          statements.map((statement) => sql.query(statement.text, statement.values, { types: neonHttpsTypes })),
          { readOnly: true, fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } },
        );
        if (!Array.isArray(results) || results.length !== statements.length) {
          throw new Error("PostgreSQL returned an unexpected row");
        }
        return results.map(normalizeRows);
      } catch (error) {
        if (isPostgresTimeout(error)) throw new Error(POSTGRES_READ_TIMED_OUT);
        throw redactConnectionError(error, url);
      }
    },
  };
}

function normalizeRows(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) throw new Error("PostgreSQL returned an unexpected row");
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  });
}

function redactConnectionError(error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : "PostgreSQL read failed";
  const password = connectionPassword(url);
  const withoutUrl = message.split(url).join("[redacted]");
  const withoutPassword = password === "" ? withoutUrl : withoutUrl.split(password).join("[redacted]");
  return new Error(withoutPassword.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]"));
}

function connectionPassword(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null) return "";
  const raw = parsed.password;
  const password = /^(?:%[0-9A-Fa-f]{2}|[^%])*$/.test(raw) ? decodeURIComponent(raw) : raw;
  return password.length >= 8 ? password : "";
}
