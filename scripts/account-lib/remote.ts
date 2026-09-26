/** Strict operator REST adapter. Bucket fixes PostgreSQL and queue pairing;
 * no environment-variable override can silently redirect an audit.
 * No Worker HTTP/admin surface and no production dependency is added.
 */
import { z } from "zod";
import { loadDotVars } from "../lib/dotvars";
import { r2InventoryClientFromVars } from "../lib/cf-clients";
import { fromSql, type ControlPlaneDb } from "../../src/control-plane/db";
import type { Sql } from "../../src/modules/db/sql";
import {
  OPERATOR_DATABASES,
  openOperatorSql,
  resolveOperatorDatabaseUrl,
} from "../pg-lib/operator-db";
export function accountRemote(
  bucket: string,
  fetchFn: typeof fetch = fetch,
  vars: Record<string, string | undefined> = {
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  },
) {
  const target = OPERATOR_DATABASES[bucket];
  if (!target) throw new Error(`unmapped account bucket: ${bucket}`);
  // Optional entries in .corpus.vars.example may be empty; skip them just
  // as the R2 credential resolver does, while preserving non-empty overrides.
  const account = vars.CORPUS_R2_ACCOUNT_ID || vars.CLOUDFLARE_ACCOUNT_ID;
  const token = vars.CORPUS_CF_API_TOKEN || vars.CLOUDFLARE_API_TOKEN;
  if (!account || !token)
    throw new Error(
      "account operations require CORPUS_R2_ACCOUNT_ID/CLOUDFLARE_ACCOUNT_ID and CORPUS_CF_API_TOKEN/CLOUDFLARE_API_TOKEN",
    );
  async function request(path: string, body?: unknown): Promise<unknown> {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok)
      throw new Error(`Cloudflare ${path.split("?")[0]} HTTP ${res.status}`);
    const envelope = z
      .object({ success: z.literal(true), result: z.unknown() })
      .parse(await res.json());
    return envelope.result;
  }
  // The control-plane handle is opened on first use and closed by `closeDb`.
  // Lazily, because this adapter is also constructed for R2-only work: resolving the connection variable eagerly would make those paths
  // fail on a machine that has no database credentials at all.
  let sql: Sql | null = null;
  const controlPlaneSql = (): Sql =>
    (sql ??= openOperatorSql(resolveOperatorDatabaseUrl({ bucket, env: vars }).url));

  return {
    db: {
      first: (text, ...params) => fromSql(controlPlaneSql()).first(text, ...params),
      all: (text, ...params) => fromSql(controlPlaneSql()).all(text, ...params),
      batch: (statements) => fromSql(controlPlaneSql()).batch(statements),
      run: (text, ...params) => fromSql(controlPlaneSql()).run(text, ...params),
      transaction: (work) => fromSql(controlPlaneSql()).transaction(work),
    } as ControlPlaneDb,
    closeDb: async () => {
      const open = sql;
      sql = null;
      if (open) await open.end().catch(() => undefined);
    },
    storage: r2InventoryClientFromVars(vars, bucket, fetchFn),
    enqueue: async (tenantId: string, force: boolean, queueId: string) => {
      // Verify identity by GET, never trust an operator-supplied id to select
      // a different environment's queue.
      const expected = `${bucket}-wipe`;
      const queue = z
        .object({ queue_name: z.string() })
        .parse(await request(`queues/${encodeURIComponent(queueId)}`));
      if (queue.queue_name !== expected)
        throw new Error(`queue must be ${expected}`);
      await request(`queues/${encodeURIComponent(queueId)}/messages`, {
        content_type: "json",
        body: { version: 1, tenantId, force },
      });
    },
  };
}
export type AccountRemote = ReturnType<typeof accountRemote>;
