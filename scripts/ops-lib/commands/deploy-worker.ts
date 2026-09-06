// `ops deploy worker` — deploy the Cloudflare Worker (reading-lite).
// Plan-first: a mode-less run prints the remote D1 migrate command and passes
// wrangler --dry-run (config validation + in-place build check, no upload)
// plus the control-plane readiness preflight; --execute applies pending remote
// D1 migrations then uploads. Before either write, require established tenant
// activation or an explicit manual acknowledgement, and a non-placeholder D1.

import { parseArgs } from "node:util";
import { assertCleanCandidate, ShaSchema } from "../../lib/release-evidence";
import { validateControlPlaneDeployReadiness } from "../../control-plane-env";
import { validateTenantActivation } from "../tenant-activation-preflight";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export type DeployEnv = "production" | "staging";

export interface DeployWorkerDeps extends BaseDeps {
  runWrangler: (args: string[]) => Promise<number>;
  validateCandidate?: (sha: string) => Promise<void>;
  validateReadiness: typeof validateControlPlaneDeployReadiness;
  validateTenantActivation: typeof validateTenantActivation;
}

export function parseDeployEnv(value: unknown): DeployEnv | null {
  return value === "production" || value === "staging" ? value : null;
}

export function buildWranglerArgs(args: { env: DeployEnv; execute: boolean }): string[] {
  const out = ["deploy", "--env", args.env];
  if (!args.execute) out.push("--dry-run");
  return out;
}

export function buildMigrationArgs(args: { env: DeployEnv; databaseName: string }): string[] {
  return ["d1", "migrations", "apply", args.databaseName, "--env", args.env, "--remote"];
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
  const readiness = deps.validateReadiness(env);
  const migrationArgs = readiness.ok
    ? buildMigrationArgs({ env, databaseName: readiness.d1.databaseName })
    : null;
  deps.io.stderr(
    `[${mode}] worker=reading-lite env=${env}\n` +
      (migrationArgs ? `[${mode}] $ wrangler ${migrationArgs.join(" ")}\n` : "") +
      `[${mode}] $ wrangler ${wranglerArgs.join(" ")}\n` +
      `[${mode}] required runtime secret: ${readiness.requiredSecrets.runtime.join(", ")}\n` +
      `[${mode}] bootstrap-only secret: ${readiness.requiredSecrets.bootstrapOnly.join(", ")}`,
  );
  if (!readiness.ok) {
    deps.io.stderr(`[${mode}] control-plane preflight: ${readiness.error}`);
    if (execute) return 2;
  }
  deps.io.stderr("");
  if (execute) {
    const activation = await deps.validateTenantActivation(env);
    deps.io.stderr(`[DEPLOY] tenant activation preflight: ${activation.message}`);
    if (!activation.ok) {
      if (!values["acknowledge-tenant-migration"]) {
        deps.io.stderr("Refusing before migrations or upload. Verify the target tenant R2 corpus, namespaced vectors, and deletion eligibility, then re-run with --acknowledge-tenant-migration. See docs/operations.md (Tenant-mode activation guard).");
        return 2;
      }
      deps.io.stderr("[DEPLOY] OVERRIDE: operator acknowledges target tenant migration and deletion eligibility were verified manually for this deployment.");
    }
  } else {
    deps.io.stderr("[PLAN] execute will inspect the active tenant-mode version and R2/Vectorize resource creation metadata before migrations or upload; no remote readiness check has run.");
  }
  if (execute && migrationArgs) {
    const migrateCode = await deps.runWrangler(migrationArgs);
    if (migrateCode !== 0) return migrateCode;
  }
  return deps.runWrangler(wranglerArgs);
}

export const deployWorkerCommand: CommandDefinition<DeployWorkerDeps> = {
  group: "deploy",
  name: "worker",
  summary: "Deploy the Cloudflare Worker (wrangler deploy)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- deploy worker [--env production|staging] [--execute]

Plans by default: prints the remote D1 migrate command, runs
\`wrangler deploy --dry-run\` (validates config and build without uploading),
and prints the control-plane preflight. --execute applies pending remote D1
migrations, then uploads. Idempotent: re-running with the same source and
schema produces the same Worker version; already-applied migrations are a
no-op. Does not create the database or import the founder token.

Before either remote write, tenant mode must already be active with matching
R2/Vectorize/D1 bindings and resource creation metadata, or the operator must
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
  --execute      Apply remote D1 migrations and upload (otherwise wrangler
                 --dry-run is passed and migrations are not applied).
  --help         Show this message.

Secrets are NOT managed here. Set them once with:
  wrangler secret put AUTH_ROOT_SECRET
  wrangler secret put OPENAI_API_KEY

AUTH_ROOT_SECRET is required at runtime for D1-backed auth. READER_API_TOKEN
is imported once by founder bootstrap and is not a runtime auth fallback.
OPENAI_API_KEY is always required; if SUMMARIZER_PROVIDER=anthropic, also set
ANTHROPIC_API_KEY.

--execute refuses placeholder CONTROL_PLANE D1 database IDs in wrangler.toml.
Replace staging/production database_id after \`wrangler d1 create\`. Plan mode
warns instead of failing.`,
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
    validateReadiness: validateControlPlaneDeployReadiness,
    validateTenantActivation,
  }),
  run: runDeployWorker,
};
