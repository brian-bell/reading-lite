// Fault injection at the PostgreSQL client. Every store and the control plane
// reach the database through pg.Client#query (src/modules/db/sql.ts), so
// spying on it lets a test fail or answer exactly the statements it names,
// wherever the code under test opened its connection, and pass the rest
// through. Statements arrive with `$n` placeholders.
import pg from "pg";
import { vi, type MockInstance } from "vitest";

// "pass" runs the statement; an Error rejects it; rows answer it instead;
// `afterRunning` runs it and then rejects, as a commit whose response was lost.
export type SqlResponse = "pass" | Error | Record<string, unknown>[] | { afterRunning: Error };

// `respond` sees the 1-based count of matching statements so far and the
// statement's parameters. It may be async, to act (say, purge a reading) just
// before the statement runs.
export function interceptSql(
  pattern: RegExp,
  respond: (call: number, values: readonly unknown[]) => SqlResponse | Promise<SqlResponse>,
): MockInstance {
  const original = pg.Client.prototype.query as (...a: unknown[]) => Promise<unknown>;
  let calls = 0;
  return vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    const text = typeof first === "string" ? first : first?.text;
    if (typeof text !== "string" || !pattern.test(text)) return original.apply(this, args);
    const response = await respond(++calls, (args[1] as unknown[] | undefined) ?? []);
    if (response instanceof Error) throw response;
    if (Array.isArray(response)) return { rows: response, rowCount: response.length };
    const result = await original.apply(this, args);
    if (response !== "pass") throw response.afterRunning;
    return result;
  } as never);
}

// The tenant-status lookup the consumer and the deletion fence make.
export const TENANT_STATUS_LOOKUP = /SELECT status FROM users WHERE id = \$1/;
