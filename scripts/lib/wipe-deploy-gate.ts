// Read-only production rollout speed bump. Unfinished records remain blockers
// even when stale: cron resumes them. Completed records and users.status alone
// do not indicate a running wipe. This snapshot does not lock out cron/new jobs.
import { z } from "zod";

export const UNFINISHED_WIPES_SQL =
  "SELECT count(*) AS unfinished FROM wipe_progress WHERE completed_at_ms IS NULL";
const queueNames = ["reading-lite-wipe", "reading-lite-wipe-dlq"] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelope = z.object({
  success: z.literal(true),
  errors: z.array(z.unknown()).max(0).optional(),
  result: z.unknown(),
  result_info: z.object({
    page: z.number().int().positive(),
    total_pages: z.number().int().nonnegative(),
  }).optional(),
});
const queueList = z.array(z.object({ queue_name: z.string(), queue_id: z.string().regex(/^[a-f0-9]{32}$/) }));

export async function checkWipeDeployGate(deps: {
  accountId: string;
  token: string;
  databaseId: string;
  fetch: typeof fetch;
}): Promise<{ unfinished: number; queues: Record<string, number> }> {
  if (!deps.accountId || !deps.token || !deps.databaseId) throw new Error("Missing Cloudflare wipe gate credentials/configuration");
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(deps.accountId)}`;
  async function request(path: string, sql?: string) {
    const response = await deps.fetch(`${base}${path}`, {
      method: sql ? "POST" : "GET",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      ...(sql ? { body: JSON.stringify({ sql }) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    // Do not echo API response bodies, which may include tenant data.
    if (!response.ok) throw new Error(`Wipe deploy gate ${path}: HTTP ${response.status}; verify D1/Queues read access`);
    return envelope.parse(await response.json());
  }
  const d1 = await request(`/d1/database/${encodeURIComponent(deps.databaseId)}/query`, UNFINISHED_WIPES_SQL);
  const [{ results: [{ unfinished }] }] = z.tuple([z.object({
    success: z.literal(true),
    results: z.tuple([z.object({ unfinished: count })]),
  })]).parse(d1.result);
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
