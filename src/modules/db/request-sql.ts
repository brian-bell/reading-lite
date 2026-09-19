// One PostgreSQL client per HTTP request (ADR 0005). Hyperdrive pools, so the
// client is cheap, but it must be closed: the scope hands routes a lazy `Sql`
// and ends it once the response is built. A route that never queries never
// connects.
//
// FrontendReads and MCP dispatch through these same routes, so this is the
// only place the read surface opens a connection.

import type { MiddlewareHandler } from "hono";
import { sqlFor, type Sql } from "./sql";

export type SqlVariables = { sql: Sql };

export const sqlScope: MiddlewareHandler<{
  Bindings: { HYPERDRIVE: Hyperdrive };
  Variables: SqlVariables;
}> = async (c, next) => {
  let sql: Sql | null = null;
  const open = (): Sql => (sql ??= sqlFor(c.env));
  c.set("sql", {
    query: (text, values) => open().query(text, values),
    transaction: (run, opts) => open().transaction(run, opts),
    end: async () => undefined,
  });
  try {
    await next();
  } finally {
    // Content bodies stream from R2, not from this client, so closing here
    // never cuts a response short.
    await (sql as Sql | null)?.end();
  }
};
