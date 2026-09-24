import { parseArgs } from "node:util";
import { checkWipeDeployGate, countUnfinishedWipes } from "../../lib/wipe-deploy-gate";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";

interface Deps extends BaseDeps {
  overrideSha?: string;
  check(databaseUrlEnv: string): ReturnType<typeof checkWipeDeployGate>;
}
export const deployWipeCheckCommand: CommandDefinition<Deps> = {
  group: "deploy",
  name: "wipe-check",
  summary: "Refuse production rollout while account wipe work remains",
  safety: "read-only",
  helpText: `Usage: npm run ops -- deploy wipe-check [--release-sha <full SHA>] [--database-url-env NAME]
Reads unfinished wipe records from the production control plane and both
production wipe queues. Exit 0 only when all are clear, 1 for blockers or
unreadable state, 2 for usage. Requires CLOUDFLARE_API_TOKEN,
CLOUDFLARE_ACCOUNT_ID, and a direct PostgreSQL connection string in
DATABASE_URL (--database-url-env names another variable). Never mutates data:
the count runs in a read-only transaction.
DEPLOY_WIPE_OVERRIDE_SHA bypasses reads only when it exactly matches a valid
--release-sha (40 lowercase hex characters); logs an explicit warning.
This snapshot is a speed bump, not a lock preventing new wipes. --help shows help.`,
  defaultDeps: (io) => ({
    io,
    overrideSha: process.env.DEPLOY_WIPE_OVERRIDE_SHA,
    check(databaseUrlEnv) {
      const databaseUrl = process.env[databaseUrlEnv]?.trim();
      return checkWipeDeployGate({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        token: process.env.CLOUDFLARE_API_TOKEN ?? "",
        unfinishedWipes: () => {
          // Fail closed: no connection string means the gate cannot see the
          // wipes it exists to see, which is not the same as seeing none.
          if (!databaseUrl) {
            throw new Error(`Wipe deploy gate: missing ${databaseUrlEnv} (a direct PostgreSQL connection string for production)`);
          }
          return countUnfinishedWipes(databaseUrl);
        },
        fetch: globalThis.fetch,
      });
    },
  }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: { "release-sha": { type: "string" }, "database-url-env": { type: "string", default: "DATABASE_URL" } },
      }));
    } catch (error) { throw new UsageError(String(error)); }
    const sha = values["release-sha"];
    if (sha !== undefined && !/^[a-f0-9]{40}$/.test(sha)) throw new UsageError("--release-sha must be a full lowercase commit SHA");
    if (sha && deps.overrideSha === sha) {
      deps.io.stderr(`::warning::Account wipe deploy gate OVERRIDDEN for reviewed release ${sha}; production wipe state was not checked.`);
      return 0;
    }
    try {
      const snapshot = await deps.check(values["database-url-env"] ?? "DATABASE_URL");
      deps.io.stdout(`Account wipe deploy gate clear: ${JSON.stringify(snapshot)}`);
      return 0;
    } catch (error) {
      deps.io.stderr(error instanceof Error ? error.message : String(error));
      deps.io.stderr("Deploy blocked. Let wipes drain and rerun; see docs/operations.md for the reviewed release override.");
      return 1;
    }
  },
};
