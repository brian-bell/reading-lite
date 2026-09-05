import { parseArgs } from "node:util";
import { validateControlPlaneDeployReadiness } from "../../control-plane-env";
import { checkWipeDeployGate } from "../../lib/wipe-deploy-gate";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";

interface Deps extends BaseDeps {
  overrideSha?: string;
  check(): ReturnType<typeof checkWipeDeployGate>;
}
export const deployWipeCheckCommand: CommandDefinition<Deps> = {
  group: "deploy",
  name: "wipe-check",
  summary: "Refuse production rollout while account wipe work remains",
  safety: "read-only",
  helpText: `Usage: npm run ops -- deploy wipe-check [--release-sha <full SHA>]
Reads production D1 unfinished wipe records and both production wipe queues.
Exit 0 only when all are clear, 1 for blockers or unreadable state, 2 for usage.
Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Never mutates data.
DEPLOY_WIPE_OVERRIDE_SHA bypasses reads only when it exactly matches a valid
--release-sha (40 lowercase hex characters); logs an explicit warning.
This snapshot is a speed bump, not a lock preventing new wipes. --help shows help.`,
  defaultDeps: (io) => ({
    io,
    overrideSha: process.env.DEPLOY_WIPE_OVERRIDE_SHA,
    async check() {
      const readiness = validateControlPlaneDeployReadiness("production");
      if (!readiness.ok) throw new Error(readiness.error);
      return checkWipeDeployGate({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        token: process.env.CLOUDFLARE_API_TOKEN ?? "",
        databaseId: readiness.d1.databaseId,
        fetch: globalThis.fetch,
      });
    },
  }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({ args: argv, options: { "release-sha": { type: "string" } } }));
    } catch (error) { throw new UsageError(String(error)); }
    const sha = values["release-sha"];
    if (sha !== undefined && !/^[a-f0-9]{40}$/.test(sha)) throw new UsageError("--release-sha must be a full lowercase commit SHA");
    if (sha && deps.overrideSha === sha) {
      deps.io.stderr(`::warning::Account wipe deploy gate OVERRIDDEN for reviewed release ${sha}; production wipe state was not checked.`);
      return 0;
    }
    try {
      deps.io.stdout(`Account wipe deploy gate clear: ${JSON.stringify(await deps.check())}`);
      return 0;
    } catch (error) {
      deps.io.stderr(error instanceof Error ? error.message : String(error));
      deps.io.stderr("Deploy blocked. Let wipes drain and rerun; see docs/operations.md for the reviewed release override.");
      return 1;
    }
  },
};
