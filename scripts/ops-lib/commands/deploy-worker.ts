// `ops deploy worker` — deploy the Cloudflare Worker (reading-lite).
// Plan-first: a mode-less run passes wrangler --dry-run (config validation +
// in-place build check, no upload) and prints the command plus the
// control-plane readiness preflight; --execute uploads. The preflight refuses
// an execute against placeholder CONTROL_PLANE D1 database ids; plan mode
// warns instead of failing.

import { parseArgs } from "node:util";
import { validateControlPlaneDeployReadiness } from "../../control-plane-env";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export type DeployEnv = "production" | "staging";

export interface DeployWorkerDeps extends BaseDeps {
  runWrangler: (args: string[]) => Promise<number>;
  validateReadiness: typeof validateControlPlaneDeployReadiness;
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
        execute: { type: "boolean", default: false },
        env: { type: "string", default: "production" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const env = parseDeployEnv(values.env);
  if (!env) throw new UsageError(`invalid --env: ${values.env}. Expected production or staging.`);
  const execute = values.execute === true;

  const wranglerArgs = buildWranglerArgs({ env, execute });
  const mode = execute ? "DEPLOY" : "PLAN";
  const readiness = deps.validateReadiness(env);
  deps.io.stderr(
    `[${mode}] worker=reading-lite env=${env}\n` +
      `[${mode}] $ wrangler ${wranglerArgs.join(" ")}\n` +
      `[${mode}] required runtime secret: ${readiness.requiredSecrets.runtime.join(", ")}\n` +
      `[${mode}] bootstrap-only secret: ${readiness.requiredSecrets.bootstrapOnly.join(", ")}`,
  );
  if (!readiness.ok) {
    deps.io.stderr(`[${mode}] control-plane preflight: ${readiness.error}`);
    if (execute) return 2;
  }
  deps.io.stderr("");
  return deps.runWrangler(wranglerArgs);
}

export const deployWorkerCommand: CommandDefinition<DeployWorkerDeps> = {
  group: "deploy",
  name: "worker",
  summary: "Deploy the Cloudflare Worker (wrangler deploy)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- deploy worker [--env production|staging] [--execute]

Plans by default: runs \`wrangler deploy --dry-run\` (validates config and
build without uploading) and prints the control-plane preflight. --execute
uploads. Idempotent: re-running with the same source produces the same Worker
version.

Options:
  --env <name>   Worker environment to deploy (default: production).
  --execute      Actually upload (otherwise wrangler --dry-run is passed).
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
      const { spawn } = await import("node:child_process");
      return new Promise((resolve, reject) => {
        const child = spawn("wrangler", wranglerArgs, { stdio: "inherit", shell: false });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });
    },
    validateReadiness: validateControlPlaneDeployReadiness,
  }),
  run: runDeployWorker,
};
