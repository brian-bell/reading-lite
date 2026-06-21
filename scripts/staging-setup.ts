#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_STAGING_RESOURCES,
  buildSecretCommands,
  buildStagingSetupCommands,
  printCommandPlan,
  runWranglerCommands,
} from "./staging-env";

interface Args {
  execute: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  return { execute: values.execute === true };
}

function printUsage(): void {
  process.stderr.write(`Usage: tsx scripts/staging-setup.ts [--execute] [--help]

Creates the one-time Cloudflare staging resources for reading-lite:
R2 bucket, Vectorize index, Queue, and DLQ. Dry-run by default - pass
--execute to actually create resources.

Secrets are not written by this script because wrangler secret put is
interactive. After setup, set them with:
${buildSecretCommands().map((cmd) => `  ${cmd}`).join("\n")}
`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const commands = buildStagingSetupCommands(DEFAULT_STAGING_RESOURCES);
  printCommandPlan("staging resource setup", commands, args.execute);

  if (!args.execute) {
    process.stderr.write("\n[DRY RUN] not creating resources. Pass --execute to apply.\n");
    process.stderr.write("\nSet staging secrets separately:\n");
    for (const command of buildSecretCommands()) {
      process.stderr.write(`  ${command}\n`);
    }
    return;
  }

  const code = await runWranglerCommands(commands);
  if (code !== 0) process.exit(code);

  process.stderr.write("\n[EXECUTE] staging resources created or confirmed.\n");
  process.stderr.write("\nSet staging secrets separately:\n");
  for (const command of buildSecretCommands()) {
    process.stderr.write(`  ${command}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
