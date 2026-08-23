// `ops staging teardown` — delete the Cloudflare staging Worker and isolated
// staging resources: Queue, DLQ, Vectorize index, and R2 bucket (emptied via
// the S3-compatible API first). Hard-coded to staging resource names; the
// shared command builder refuses production-looking names. Plan-first: a
// mode-less run prints the deletion plan; --execute deletes.

import { parseArgs } from "node:util";
import {
  DEFAULT_STAGING_RESOURCES,
  buildStagingTeardownCommands,
  type WranglerCommand,
} from "../../staging-env";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface StagingTeardownDeps extends BaseDeps {
  runWranglerCommands: (commands: WranglerCommand[]) => Promise<number>;
  // Resolves and validates the CORPUS_R2_* credentials, returning the
  // bucket-empty step. Called BEFORE any destructive command so a missing
  // .corpus.vars fails the run while staging is still intact, rather than
  // after the Worker/queues/D1 are already gone.
  resolveBucketEmptier: () => Promise<{ empty: () => Promise<void> }>;
}

async function runStagingTeardown(argv: string[], deps: StagingTeardownDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const execute = values.execute === true;
  const { io } = deps;

  const commands = buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES);
  const beforeBucketDelete = commands.slice(0, -1);
  const bucketDelete = commands.at(-1);
  if (!bucketDelete) throw new Error("staging teardown command list is empty");

  const mode = execute ? "EXECUTE" : "PLAN";
  io.stderr(`[${mode}] staging resource teardown`);
  for (const command of beforeBucketDelete) {
    io.stderr(`[${mode}] ${command.label}`);
    io.stderr(`[${mode}] $ wrangler ${command.args.join(" ")}`);
  }
  io.stderr(`[${mode}] Empty staging R2 bucket`);
  io.stderr(
    `[${mode}] $ empty ${DEFAULT_STAGING_RESOURCES.bucket} via R2 S3 API ` +
      `(CORPUS_R2_ACCOUNT_ID/CORPUS_R2_ACCESS_KEY/CORPUS_R2_SECRET_KEY)`,
  );
  io.stderr(`[${mode}] ${bucketDelete.label}`);
  io.stderr(`[${mode}] $ wrangler ${bucketDelete.args.join(" ")}`);

  if (!execute) {
    io.stderr("\n[PLAN] not deleting resources. Pass --execute to apply.");
    return 0;
  }

  // Credential preflight before anything is deleted: the bucket-empty step
  // runs late, but its configuration must fail early or a missing
  // .corpus.vars would strand a half-torn-down staging environment.
  const bucketEmptier = await deps.resolveBucketEmptier();

  const beforeCode = await deps.runWranglerCommands(beforeBucketDelete);
  if (beforeCode !== 0) return beforeCode;

  await bucketEmptier.empty();

  return deps.runWranglerCommands([bucketDelete]);
}

export const stagingTeardownCommand: CommandDefinition<StagingTeardownDeps> = {
  group: "staging",
  name: "teardown",
  summary: "Delete the isolated staging Worker and resources (staging-only)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- staging teardown [--execute]

Deletes the Cloudflare staging Worker and isolated staging resources for
reading-lite: Queue, DLQ, Vectorize index, and R2 bucket. Plans by default;
--execute deletes. Idempotent — "already gone" is treated as success.

This command is intentionally hard-coded to staging resource names and refuses
production-looking names in the shared command builder. The bucket-empty step
needs the CORPUS_R2_* credentials in env or .corpus.vars.

Options:
  --execute   Delete the resources.
  --help      Show this message.`,
  defaultDeps: (io: CommandIo): StagingTeardownDeps => ({
    io,
    runWranglerCommands: async (commands) => {
      const { runWranglerCommands } = await import("../../staging-env");
      return runWranglerCommands(commands);
    },
    resolveBucketEmptier: async () => {
      const { emptyR2Bucket, resolveStagingR2Config } = await import("../../staging-env");
      const { makeR2Client } = await import("../../lib/cf-clients");
      // Throws here — before any wrangler delete has run — when the
      // CORPUS_R2_* credentials are missing or malformed.
      const r2Config = resolveStagingR2Config(DEFAULT_STAGING_RESOURCES);
      const client = makeR2Client(r2Config);
      return {
        empty: () => emptyR2Bucket(client, DEFAULT_STAGING_RESOURCES.bucket),
      };
    },
  }),
  run: runStagingTeardown,
};
