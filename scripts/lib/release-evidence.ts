/** One operator-selected token drill. Evidence is an audit record, not an
 * authorization seal. Active version tags tie the observed deployment to a
 * clean candidate; no freshness policy or automatic CI gate is imposed. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { cloudflareActivationRequest, readTenantDeployTarget, resolveActivationAuth } from "../ops-lib/tenant-activation-preflight";

export const STAGING_ORIGIN = "https://reading-lite-staging.bbell.dev";
export const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ProvenanceSchema = z.object({
  commit: ShaSchema, config_sha256: hash, version_id: z.string().min(1), effective_config_sha256: hash,
}).strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;
export const requiredChecks = { session: 200, create: 201, baseline: 200, revoke: 200, rejected: 401, session_after: 200, cleanup_list: 200, cleanup_confirm: 200 } as const;
export const EvidenceSchema = z.object({
  schema_version: z.literal(1), check: z.literal("token-revocation"),
  run_id: z.string().min(1), origin: z.literal(STAGING_ORIGIN),
  release_sha: ShaSchema, tenant: z.string().regex(/^usr_[a-zA-Z0-9_-]+$/),
  started_at: z.iso.datetime(), finished_at: z.iso.datetime(),
  provenance: ProvenanceSchema.nullable(), provenance_unchanged: z.boolean(),
  checks: z.array(z.object({ step: z.string(), status: z.number().int().min(100).max(599).nullable(), passed: z.boolean() }).strict()),
  cleanup: z.enum(["not-created", "revoked", "unresolved"]),
  restoration: z.literal("no configuration changes; operator session retained; revoked token record retained"),
  token_id: z.string().nullable(), token_name: z.string().min(1),
  exit_code: z.union([z.literal(0), z.literal(1)]), failure_stage: z.string().nullable(),
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
export const sha256 = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");

export async function assertCleanCandidate(sha: string): Promise<void> {
  ShaSchema.parse(sha);
  const git = promisify(execFile);
  const head = await git("git", ["rev-parse", "HEAD"]);
  const status = await git("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (head.stdout.trim() !== sha || status.stdout.trim()) throw new Error("release requires a clean checkout of the exact candidate commit");
}

// Explicit allowlist: neither secret bindings nor arbitrary metadata enter the
// retained report. Hash effective auth configuration and D1 binding in memory.
export function deployedProvenance(deployments: unknown, version: unknown, commit: string, configHash: string): Provenance {
  const active = z.object({ deployments: z.array(z.object({ versions: z.array(z.object({ version_id: z.string().min(1), percentage: z.number() })) })) }).parse(deployments).deployments[0];
  if (!active || active.versions.length !== 1 || active.versions[0]!.percentage !== 100) throw new Error("staging requires one fully active version");
  const v = z.object({ id: z.string(), annotations: z.record(z.string(), z.string()), resources: z.object({ bindings: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()) }) }).parse(version);
  if (v.id !== active.versions[0]!.version_id || v.annotations["workers/tag"] !== commit) throw new Error("staging version does not carry the candidate commit tag");
  const names = ["APP_ENV", "WEB_BASE_URL", "TENANT_DATA_PLANE", "CONTROL_PLANE"];
  const selected = names.map(name => {
    const bindings = v.resources.bindings.filter(b => b.name === name);
    if (bindings.length !== 1) throw new Error("staging auth configuration is incomplete");
    const b = bindings[0]!;
    if (name === "CONTROL_PLANE") return { name, type: z.literal("d1").parse(b.type), value: z.string().min(1).parse(b.id) };
    return { name, type: z.literal("plain_text").parse(b.type), value: z.string().parse(b.text) };
  });
  if (selected[0]!.value !== "staging" || selected[1]!.value.replace(/\/$/, "") !== STAGING_ORIGIN || selected[2]!.value !== "1") throw new Error("unexpected staging auth configuration");
  return ProvenanceSchema.parse({ commit, config_sha256: configHash, version_id: v.id, effective_config_sha256: sha256(JSON.stringify(selected)) });
}

export async function captureProvenance(commit: string): Promise<Provenance> {
  await assertCleanCandidate(commit);
  const configHash = sha256(await readFile("wrangler.toml"));
  const target = await readTenantDeployTarget("staging");
  if (target.worker !== "reading-lite-staging") throw new Error("unexpected staging Worker");
  const { accountId, auth } = await resolveActivationAuth(target.accountId);
  const request = cloudflareActivationRequest(accountId, auth, "");
  const path = "workers/scripts/reading-lite-staging";
  const deployments = await request(`${path}/deployments`);
  const active = z.object({ deployments: z.array(z.object({ versions: z.array(z.object({ version_id: z.string().min(1), percentage: z.number() })).length(1) })).min(1) }).parse(deployments).deployments[0]!.versions[0]!;
  if (active.percentage !== 100) throw new Error("staging requires one fully active version");
  const version = await request(`${path}/versions/${encodeURIComponent(active.version_id)}`);
  return deployedProvenance(deployments, version, commit, configHash);
}

export function sameProvenance(a: Provenance, b: Provenance): boolean {
  return a.commit === b.commit && a.config_sha256 === b.config_sha256 && a.version_id === b.version_id && a.effective_config_sha256 === b.effective_config_sha256;
}

export function validateReleaseEvidence(value: unknown, current: Provenance, sha: string): Evidence {
  const e = EvidenceSchema.parse(value);
  if (current.commit !== sha || e.release_sha !== sha || e.exit_code !== 0 || e.failure_stage !== null || !e.provenance ||
      !sameProvenance(e.provenance, current) || !e.provenance_unchanged || e.cleanup !== "revoked" || !e.token_id ||
      Date.parse(e.finished_at) < Date.parse(e.started_at)) throw new Error("evidence failed, incomplete, or mismatched");
  for (const [step, status] of Object.entries(requiredChecks)) {
    const checks = e.checks.filter(c => c.step === step);
    if (checks.length !== 1 || checks[0]!.status !== status || !checks[0]!.passed) throw new Error("required drill observation is missing or failed");
  }
  if (e.checks.some(c => !c.passed)) throw new Error("drill contains a failed observation");
  return e;
}
