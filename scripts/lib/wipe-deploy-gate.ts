// Read-only production rollout speed bump. Unfinished records remain blockers
// even when stale: cron resumes them. Completed records and users.status alone
// do not indicate a running wipe. This snapshot does not lock out cron/new jobs.
//
// The record count comes from the control plane's PostgreSQL database over a
// direct connection string (ADR 0005); the queue backlogs still come from the
// Cloudflare API, which is where queues live.
import { z } from "zod";
import { sqlFromConnectionString } from "../../src/modules/db/sql";

export const UNFINISHED_WIPES_SQL =
  "SELECT count(*) AS unfinished FROM wipe_progress WHERE completed_at IS NULL";
const queueNames = ["reading-lite-wipe", "reading-lite-wipe-dlq"] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelope = z.object({
  success: z.literal(true),
  // Cloudflare can return null instead of an empty errors array on success.
  errors: z.array(z.unknown()).max(0).nullish(),
  result: z.unknown(),
  result_info: z.object({
    page: z.number().int().positive(),
    total_pages: z.number().int().nonnegative(),
  }).optional(),
});
const queueList = z.array(z.object({ queue_name: z.string(), queue_id: z.string().regex(/^[a-f0-9]{32}$/) }));

/**
 * How many wipes the control plane still owes, read over a direct connection.
 *
 * Read-only by construction: the count runs in a read-only transaction, so a
 * gate that is handed a writable credential still cannot write with it.
 */
export async function countUnfinishedWipes(databaseUrl: string): Promise<number> {
  const sql = sqlFromConnectionString(databaseUrl);
  try {
    const rows = await sql.transaction((tx) => tx.query(UNFINISHED_WIPES_SQL), { readOnly: true });
    return count.parse(z.tuple([z.object({ unfinished: z.unknown() })]).parse(rows)[0].unfinished);
  } finally {
    await sql.end();
  }
}

export async function checkWipeDeployGate(deps: {
  accountId: string;
  token: string;
  unfinishedWipes: () => Promise<number>;
  fetch: typeof fetch;
}): Promise<{ unfinished: number; queues: Record<string, number> }> {
  if (!deps.accountId || !deps.token) throw new Error("Missing Cloudflare wipe gate credentials/configuration");
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(deps.accountId)}`;
  async function request(path: string) {
    const response = await deps.fetch(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    // Do not echo API response bodies, which may include tenant data.
    if (!response.ok) throw new Error(`Wipe deploy gate ${path}: HTTP ${response.status}; verify Queues read access`);
    return envelope.parse(await response.json());
  }
  const unfinished = count.parse(await deps.unfinishedWipes());
  const found: z.infer<typeof queueList> = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Wipe deploy gate queue pagination exceeded 100 pages");
    const data = await request(`/queues?page=${page}`);
    found.push(...queueList.parse(data.result));
    if (!data.result_info) throw new Error("Wipe deploy gate missing queue pagination metadata");
    if (data.result_info.page !== page) throw new Error("Wipe deploy gate inconsistent queue pagination");
    if (page >= data.result_info.total_pages) break;
  }
  const queues: Record<string, number> = {};
  for (const name of queueNames) {
    const matches = found.filter((queue) => queue.queue_name === name);
    if (matches.length !== 1) throw new Error(`Wipe deploy gate expected exactly one queue named ${name}`);
    const metrics = await request(`/queues/${matches[0]!.queue_id}/metrics`);
    queues[name] = z.object({ backlog_count: count }).parse(metrics.result).backlog_count;
  }
  const snapshot = { unfinished, queues };
  if (unfinished > 0 || Object.values(queues).some((value) => value > 0)) {
    throw new Error(`Refusing production deploy: account wipe work remains: ${JSON.stringify(snapshot)}`);
  }
  return snapshot;
}
