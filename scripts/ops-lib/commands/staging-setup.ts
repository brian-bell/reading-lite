// `ops staging setup` — create the one-time Cloudflare staging resources for
// reading-lite: R2 bucket, Vectorize index, Queue, and DLQ. Idempotent and
// hard-coded to staging names. Plan-first: a mode-less run prints the wrangler
// command plan; --execute creates the resources.

import { parseArgs } from "node:util";
import {
  parseSummarizerProvider,
  type SummarizerProvider,
} from "../../../src/modules/summarizer/config";
import {
  DEFAULT_STAGING_RESOURCES,
  buildSecretCommands,
  buildStagingSetupCommands,
  type WranglerCommand,
} from "../../staging-env";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface StagingSetupDeps extends BaseDeps {
  runWranglerCommands: (commands: WranglerCommand[]) => Promise<number>;
}

function printCommandPlan(io: CommandIo, title: string, commands: WranglerCommand[], execute: boolean): void {
  const mode = execute ? "EXECUTE" : "PLAN";
  io.stderr(`[${mode}] ${title}`);
  for (const command of commands) {
    io.stderr(`[${mode}] ${command.label}`);
    io.stderr(`[${mode}] $ wrangler ${command.args.join(" ")}`);
  }
}

async function runStagingSetup(argv: string[], deps: StagingSetupDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        execute: { type: "boolean", default: false },
        provider: { type: "string", default: "openai" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  let provider: SummarizerProvider;
  try {
    provider = parseSummarizerProvider(values.provider);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const execute = values.execute === true;
  const { io } = deps;

  const commands = buildStagingSetupCommands(DEFAULT_STAGING_RESOURCES);
  printCommandPlan(io, "staging resource setup", commands, execute);

  if (!execute) {
    io.stderr("\n[PLAN] not creating resources. Pass --execute to apply.");
    io.stderr("\nSet staging secrets separately:");
    for (const command of buildSecretCommands(provider)) {
      io.stderr(`  ${command}`);
    }
    return 0;
  }

  const code = await deps.runWranglerCommands(commands);
  if (code !== 0) return code;

  io.stderr("\n[EXECUTE] staging resources created or confirmed.");
  io.stderr("\nSet staging secrets separately:");
  for (const command of buildSecretCommands(provider)) {
    io.stderr(`  ${command}`);
  }
  return 0;
}

export const stagingSetupCommand: CommandDefinition<StagingSetupDeps> = {
  group: "staging",
  name: "setup",
  summary: "Create the isolated Cloudflare staging resources (idempotent)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- staging setup [--provider openai|anthropic] [--execute]

Creates the one-time Cloudflare staging resources for reading-lite:
R2 bucket, Vectorize index, D1, and reading, digest, wipe, and refresh Queue + DLQ pairs.
Plans by default; --execute creates resources. Idempotent — "already exists"
is treated as success.

Secrets are not written by this command because wrangler secret put is
interactive; the plan prints the commands to run afterwards. OpenAI is the
default provider. Pass --provider anthropic to include the conditional
ANTHROPIC_API_KEY command. RESEND_API_KEY is optional.

Options:
  --provider <name>  openai (default) or anthropic — affects the printed
                     secret checklist only.
  --execute          Create the resources.
  --help             Show this message.`,
  defaultDeps: (io: CommandIo): StagingSetupDeps => ({
    io,
    runWranglerCommands: async (commands) => {
      const { runWranglerCommands } = await import("../../staging-env");
      return runWranglerCommands(commands);
    },
  }),
  run: runStagingSetup,
};
