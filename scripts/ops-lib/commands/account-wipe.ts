import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import { accountRemote } from "../../account-lib/remote";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
export interface AccountWipeDeps extends BaseDeps {
  connect(bucket: string): {
    db: ControlPlaneDb;
    /** Closes the control-plane connection. The CLI sets an exit code rather
     *  than calling process.exit, so an open socket would hang the command. */
    closeDb?: () => Promise<void>;
    enqueue(tenant: string, force: boolean, queueId: string): Promise<void>;
  };
}
export const accountWipeCommand: CommandDefinition<AccountWipeDeps> = {
  group: "account",
  name: "wipe",
  summary: "Plan or enqueue a wipe for an already-deleting tenant",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- account wipe --tenant <usr_…> [--bucket reading-lite-staging] [--force]
  --execute --confirm <same tenant> --queue-id <id>  Enqueue the reviewed plan.
Defaults to bucket reading-lite. --force skips only the seven-day start grace.
Requires users.status=deleting; never fences an active user, edits wipe_progress,
or bypasses the consumer's ownership/completion gates. Queue name is verified
against the bucket. Enqueue acceptance is not wipe or teardown completion.
  --help  Show help.`,
  defaultDeps: (io) => ({ io, connect: accountRemote }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          tenant: { type: "string" },
          bucket: { type: "string", default: "reading-lite" },
          force: { type: "boolean" },
          execute: { type: "boolean" },
          confirm: { type: "string" },
          "queue-id": { type: "string" },
        },
      }));
    } catch (e) {
      throw new UsageError(String(e));
    }
    const tenant = parseTenantId(values.tenant ?? "");
    if (!tenant) throw new UsageError("--tenant must be a usr_… id");
    if (values.execute && (values.confirm !== tenant || !values["queue-id"]))
      throw new UsageError(
        "--execute requires --confirm <same tenant> and --queue-id",
      );
    const remote = deps.connect(values.bucket!);
    try {
      return await wipe();
    } finally {
      await remote.closeDb?.();
    }

    async function check() {
      const user = await remote.db.first<{ status: string }>(
        "SELECT status FROM users WHERE id = ?",
        tenant,
      );
      if (user?.status !== "deleting")
        throw new Error("wipe requires an existing tenant already deleting");
    }
    async function wipe(): Promise<number> {
      await check();
      deps.io.stdout(
        JSON.stringify({
          mode: values!.execute ? "EXECUTE" : "PLAN",
          bucket: values!.bucket,
          queue: `${values!.bucket}-wipe`,
          tenant,
          force: !!values!.force,
        }),
      );
      if (!values!.execute) return 0;
      await check();
      await remote.enqueue(String(tenant), !!values!.force, values!["queue-id"]!);
      deps.io.stdout(
        "Enqueued; observe wipe_progress and scan after completion. Teardown runs on cron.",
      );
      return 0;
    }
  },
};
