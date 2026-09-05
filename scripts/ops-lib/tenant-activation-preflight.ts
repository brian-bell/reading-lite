/** Activation guard, not a corpus audit. A single active tenant-mode version
 * with unchanged bindings establishes the redeployment baseline (including the
 * already-completed production/staging cutovers). Resource creation timestamps
 * catch deletion/recreation under the same R2/Vectorize names since that version.
 * Anything else requires a fresh manual migration acknowledgement on this run.
 * No durable certificate or legacy-corpus comparison is introduced. Deployments
 * or data changes outside this CLI can bypass this guard; it is not a lock.
 */
import { z } from "zod";
import type { DeployEnvName } from "../control-plane-env";

export interface TenantDeployTarget {
  enabled: boolean;
  worker: string;
  bucket: string;
  jurisdiction: string;
  index: string;
  databaseId: string;
}
export interface TenantActivationReadiness { ok: boolean; message: string }
type Request = (path: string, body?: unknown) => Promise<unknown>;
const text = z.string().min(1);
const timestamp = text.refine(value => Number.isFinite(Date.parse(value)), "invalid creation timestamp");
const deploymentsSchema = z.object({ deployments: z.array(z.object({
  versions: z.array(z.object({ version_id: text, percentage: z.number() })),
})) });
const versionSchema = z.object({
  metadata: z.object({ created_on: timestamp }),
  resources: z.object({ bindings: z.array(z.object({ name: text, type: text }).passthrough()) }),
});
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export async function inspectTenantActivation(
  target: TenantDeployTarget, request: Request, nowMs: number,
): Promise<TenantActivationReadiness> {
  if (!target.enabled) return { ok: true, message: "tenant mode is not requested" };
  let reason: string;
  try {
    const worker = `workers/scripts/${encodeURIComponent(target.worker)}`;
    // Cloudflare returns the actively serving deployment first, not the latest
    // uploaded version (which may never have been deployed).
    const active = deploymentsSchema.parse(await request(`${worker}/deployments`)).deployments[0];
    if (!active || active.versions.length !== 1 || active.versions[0]!.percentage !== 100) {
      throw new Error("no single fully active deployment; activation state is unverified");
    }
    const version = versionSchema.parse(await request(`${worker}/versions/${encodeURIComponent(active.versions[0]!.version_id)}`));
    const binding = (name: string, type: string) => {
      const found = version.resources.bindings.filter(b => b.name === name && b.type === type);
      if (found.length !== 1) throw new Error(`active ${name} binding is missing or ambiguous`);
      return found[0]!;
    };
    if (binding("TENANT_DATA_PLANE", "plain_text").text !== "1") {
      throw new Error("active Worker does not have TENANT_DATA_PLANE=1");
    }
    const bucket = binding("READINGS_BUCKET", "r2_bucket");
    if (bucket.bucket_name !== target.bucket || (bucket.jurisdiction ?? "") !== target.jurisdiction ||
        binding("READINGS_INDEX", "vectorize").index_name !== target.index ||
        binding("CONTROL_PLANE", "d1").id !== target.databaseId) {
      throw new Error("target R2, Vectorize, or D1 bindings differ from the active tenant-mode Worker");
    }
    const r2 = z.object({ creation_date: timestamp }).parse(await request(`r2/buckets/${encodeURIComponent(target.bucket)}`));
    const vector = z.object({ created_on: timestamp }).parse(await request(`vectorize/v2/indexes/${encodeURIComponent(target.index)}`));
    const versionTime = Date.parse(version.metadata.created_on);
    if (Date.parse(r2.creation_date) > versionTime || Date.parse(vector.created_on) > versionTime) {
      throw new Error("R2 bucket or Vectorize index was recreated after the active Worker version");
    }
    return { ok: true, message: "already enabled; active bindings match and resources predate the active version (no corpus audit)" };
  } catch (error) {
    // Zod errors can include remote input. Keep diagnostics bounded and never
    // print a bindings response, which can contain unrelated configuration.
    reason = error instanceof z.ZodError ? "invalid or incomplete Cloudflare activation metadata" :
      error instanceof Error ? error.message : "activation inspection failed";
  }
  let eligibility: string;
  try {
    const result = z.array(z.object({ success: z.literal(true), results: z.array(z.object({ id: text })) })).length(1).parse(
      await request(`d1/database/${encodeURIComponent(target.databaseId)}/query`, {
        sql: "SELECT id FROM users WHERE status = 'deleting' AND deleting_at_ms IS NOT NULL AND deleting_at_ms <= ? ORDER BY id",
        params: [nowMs - GRACE_MS],
      }),
    );
    const ids = result[0]!.results.map(row => row.id);
    eligibility = `${ids.length} deletion-eligible tenants at activation: ${ids.join(", ") || "none"}`;
  } catch {
    eligibility = "deletion eligibility unavailable; inspect the target D1 users table before acknowledging activation";
  }
  return { ok: false, message: `${reason}; ${eligibility}` };
}

export async function readTenantDeployTarget(env: DeployEnvName): Promise<TenantDeployTarget & { accountId: string }> {
  // Use Wrangler's own config normalization so inheritance, TOML syntax and
  // environment selection match the deploy command. No second TOML parser.
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({ config: "wrangler.toml", env }, { hideWarnings: true });
  const enabled = config.vars.TENANT_DATA_PLANE === "1";
  const one = <T extends { binding: string }>(items: T[], name: string): T => {
    const found = items.filter(item => item.binding === name);
    if (found.length !== 1) throw new Error(`target ${name} binding is missing or ambiguous`);
    return found[0]!;
  };
  if (!enabled) return { enabled, worker: config.name ?? "", accountId: "", bucket: "", jurisdiction: "", index: "", databaseId: "" };
  const bucket = one(z.array(z.object({ binding: text, bucket_name: text, jurisdiction: z.string().optional() })).parse(config.r2_buckets), "READINGS_BUCKET");
  return {
    enabled, worker: text.parse(config.name),
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || config.account_id || "",
    bucket: text.parse(bucket.bucket_name), jurisdiction: bucket.jurisdiction ?? "",
    index: text.parse(one(z.array(z.object({ binding: text, index_name: text })).parse(config.vectorize), "READINGS_INDEX").index_name),
    databaseId: text.parse(one(z.array(z.object({ binding: text, database_id: text })).parse(config.d1_databases), "CONTROL_PLANE").database_id),
  };
}

export function cloudflareActivationRequest(
  accountId: string, auth: Record<string, string>, jurisdiction: string, fetchFn: typeof fetch = fetch,
): Request {
  return async (path, body) => {
    const response = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...auth, "content-type": "application/json",
        ...(path.startsWith("r2/") && jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cloudflare activation inspection HTTP ${response.status}`);
    return z.object({ success: z.literal(true), result: z.unknown() }).parse(await response.json()).result;
  };
}

export async function validateTenantActivation(env: DeployEnvName): Promise<TenantActivationReadiness> {
  try {
    const target = await readTenantDeployTarget(env);
    if (!target.enabled) return { ok: true, message: "tenant mode is not requested" };
    const { accountId, auth } = await resolveActivationAuth(target.accountId);
    return await inspectTenantActivation(target, cloudflareActivationRequest(accountId, auth, target.jurisdiction), Date.now());
  } catch (error) {
    return { ok: false, message: error instanceof z.ZodError ?
      "activation target is incomplete; check CLOUDFLARE_ACCOUNT_ID and target bindings; deletion eligibility unavailable" :
      `${error instanceof Error ? error.message : "activation inspection failed"}; deletion eligibility unavailable` };
  }
}

// Capture auth JSON in memory only. Never inherit stdout/stderr: auth token
// output is secret, including when parsing or the subprocess fails.
async function wranglerJson(args: string[]): Promise<unknown> {
  const { spawnWrangler } = await import("../lib/wrangler-cli");
  return new Promise((resolve, reject) => {
    const child = spawnWrangler(args, { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000,
      env: { ...process.env, WRANGLER_LOG: "log", WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false", CI: "true" } });
    let stdout = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => reject(new Error("Wrangler authentication inspection failed")));
    child.on("close", code => {
      if (code !== 0) return reject(new Error("Wrangler authentication inspection failed; run wrangler login or set CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID"));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Wrangler authentication response was not JSON")); }
    });
  });
}

export async function resolveActivationAuth(
  configuredAccount: string, run: (args: string[]) => Promise<unknown> = wranglerJson,
  vars: Record<string, string | undefined> = process.env,
): Promise<{ accountId: string; auth: Record<string, string> }> {
  let accountId = configuredAccount;
  if (!accountId) {
    const info = z.object({ loggedIn: z.literal(true), accounts: z.array(z.object({ id: text })).length(1) }).parse(await run(["whoami", "--json"]));
    accountId = info.accounts[0]!.id;
  }
  if (vars.CLOUDFLARE_API_TOKEN) return { accountId, auth: { authorization: `Bearer ${vars.CLOUDFLARE_API_TOKEN}` } };
  const credentials = z.discriminatedUnion("type", [
    z.object({ type: z.literal("api_token"), token: text }),
    z.object({ type: z.literal("oauth"), token: text }),
    z.object({ type: z.literal("api_key"), key: text, email: text }),
  ]).parse(await run(["auth", "token", "--json"]));
  return { accountId, auth: credentials.type === "api_key" ?
    { "X-Auth-Key": credentials.key, "X-Auth-Email": credentials.email } :
    { authorization: `Bearer ${credentials.token}` } };
}
