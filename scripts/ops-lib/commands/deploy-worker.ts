// `ops deploy worker` — deploy the Cloudflare Worker (reading-lite).
// Plan-first: a mode-less run passes wrangler --dry-run (config validation +
// in-place build check, no upload) and prints the secrets the environment must
// already hold; --execute uploads. Before the write, require established
// tenant activation or an explicit manual acknowledgement.
//
// Schema is no longer deployed from here. The control plane and readings are
// on PostgreSQL (ADR 0005), whose migrations `ops db migrate` applies; folding
// that into this command is reading-lite-gh347.4.

import { parseArgs } from "node:util";
import { assertCleanCandidate, ShaSchema } from "../../lib/release-evidence";
import { CONTROL_PLANE_REQUIRED_SECRETS } from "../../control-plane-env";
import { validateTenantActivation } from "../tenant-activation-preflight";
import { checkPostgresCutover } from "../postgres-cutover";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export type DeployEnv = "production" | "staging";

export interface DeployWorkerDeps extends BaseDeps {
  runWrangler: (args: string[]) => Promise<number>;
  validateCandidate?: (sha: string) => Promise<void>;
  validateTenantActivation: typeof validateTenantActivation;
  checkPostgresCutover: typeof checkPostgresCutover;
}

export function parseDeployEnv(value: unknown): DeployEnv | null {
  return value === "production" || value === "staging" ? value : null;
}

export function buildWranglerArgs(args: { env: DeployEnv; execute: boolean }): string[] {
  const out = ["deploy", "--env", args.env];
  if (!args.execute) out.push("--dry-run");
  return out;
}

async function runDeployWorker(argv: string[], deps: DeployWorkerDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "release-sha": { type: "string" },
        execute: { type: "boolean", default: false },
        env: { type: "string", default: "production" },
        "acknowledge-tenant-migration": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const env = parseDeployEnv(values.env);
  if (!env) throw new UsageError(`invalid --env: ${values.env}. Expected production or staging.`);
  const execute = values.execute === true;

  const releaseSha = values["release-sha"];
  if (releaseSha !== undefined && !ShaSchema.safeParse(releaseSha).success) throw new UsageError("--release-sha must be a full lowercase commit SHA");
  if (releaseSha) await (deps.validateCandidate ?? assertCleanCandidate)(releaseSha);
  const wranglerArgs = buildWranglerArgs({ env, execute });
  if (releaseSha) wranglerArgs.push("--tag", releaseSha);
  const mode = execute ? "DEPLOY" : "PLAN";
  // First, before anything remote: a storage-migration candidate must not
  // reach an environment that has not been cut over (ADR 0005).
  const cutover = deps.checkPostgresCutover(env, { execute });
  if (!cutover.ok) {
    deps.io.stderr(`[${mode}] PostgreSQL cutover guard: REFUSED. ${cutover.error}`);
    if (execute) return 2;
  }
  deps.io.stderr(
    `[${mode}] worker=reading-lite env=${env}\n` +
      `[${mode}] $ wrangler ${wranglerArgs.join(" ")}\n` +
      `[${mode}] required runtime secret: ${CONTROL_PLANE_REQUIRED_SECRETS.runtime.join(", ")}\n` +
      `[${mode}] bootstrap-only secret: ${CONTROL_PLANE_REQUIRED_SECRETS.bootstrapOnly.join(", ")}`,
  );
  deps.io.stderr("");
  if (execute) {
    const activation = await deps.validateTenantActivation(env);
    deps.io.stderr(`[DEPLOY] tenant activation preflight: ${activation.message}`);
    if (!activation.ok) {
      if (!values["acknowledge-tenant-migration"]) {
        deps.io.stderr("Refusing before upload. Verify the target tenant R2 corpus, namespaced vectors, and deletion eligibility, then re-run with --acknowledge-tenant-migration. See docs/operations.md (Tenant-mode activation guard).");
        return 2;
      }
      deps.io.stderr("[DEPLOY] OVERRIDE: operator acknowledges target tenant migration and deletion eligibility were verified manually for this deployment.");
    }
  } else {
    deps.io.stderr("[PLAN] execute will inspect the active tenant-mode version and R2/Vectorize resource creation metadata before upload; no remote readiness check has run.");
  }
  return deps.runWrangler(wranglerArgs);
}

export const deployWorkerCommand: CommandDefinition<DeployWorkerDeps> = {
  group: "deploy",
  name: "worker",
  summary: "Deploy the Cloudflare Worker (wrangler deploy)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- deploy worker [--env production|staging] [--execute]

Plans by default: runs \`wrangler deploy --dry-run\` (validates config and
build without uploading) and prints the secrets the environment must already
hold. --execute uploads. Idempotent: re-running with the same source produces
the same Worker version. Does not create the database or import the founder
token, and does not apply PostgreSQL migrations — run
\`npm run ops -- db migrate\` against the target database first
(reading-lite-gh347.4 folds that in here).

Before the upload, tenant mode must already be active with matching
R2/Vectorize bindings and resource creation metadata, or the operator must
acknowledge manual migration verification. Unverified activation prints deletion
eligibility when available and exits 2 without the override. Plan mode does not
inspect remote readiness. See docs/operations.md: Tenant-mode activation guard.

Options:
  --env <name>   Worker environment to deploy (default: production).
  --acknowledge-tenant-migration
                 Override unverified activation only after manually verifying
                 target tenant R2 data, namespaced vectors, and deletion eligibility.
  --release-sha <full SHA>
                 Tag the deployed version after verifying a clean exact checkout.
                 Required when preparing staging evidence for deploy release.
  --execute      Upload (otherwise wrangler --dry-run is passed).
  --help         Show this message.

Secrets are NOT managed here. Set them once with:
  wrangler secret put AUTH_ROOT_SECRET
  wrangler secret put OPENAI_API_KEY

AUTH_ROOT_SECRET is required at runtime for authentication. READER_API_TOKEN
is imported once by founder bootstrap and is not a runtime auth fallback.
OPENAI_API_KEY is always required; if SUMMARIZER_PROVIDER=anthropic, also set
ANTHROPIC_API_KEY.

A wrangler.toml that binds PostgreSQL (Hyperdrive) for the target environment
is refused until POSTGRES_CUTOVER_ENABLED for that environment is true in
scripts/ops-lib/postgres-cutover.ts (ADR 0005). Plan mode reports the refusal;
--execute exits 2 before the preflight or upload, and also refuses a
placeholder Hyperdrive id.`,
  defaultDeps: (io: CommandIo): DeployWorkerDeps => ({
    io,
    runWrangler: async (wranglerArgs) => {
      const { spawnWrangler } = await import("../../lib/wrangler-cli");
      return new Promise((resolve, reject) => {
        const child = spawnWrangler(wranglerArgs, { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });
    },
    validateTenantActivation,
    checkPostgresCutover,
  }),
  run: runDeployWorker,
};
