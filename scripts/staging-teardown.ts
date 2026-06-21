#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_STAGING_RESOURCES,
  buildStagingTeardownCommands,
  emptyR2Bucket,
  printCommandPlan,
  resolveStagingR2Config,
  runWranglerCommands,
} from "./staging-env";
import { makeR2Client } from "./lib/cf-clients";

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
  process.stderr.write(`Usage: tsx scripts/staging-teardown.ts [--execute] [--help]

Deletes the Cloudflare staging Worker and isolated staging resources for
reading-lite: Queue, DLQ, Vectorize index, and R2 bucket. Dry-run by default -
pass --execute to actually delete resources.

This script is intentionally hard-coded to staging resource names and refuses
production-looking names in the shared command builder.
`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const commands = buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES);
  const beforeBucketDelete = commands.slice(0, -1);
  const bucketDelete = commands.at(-1);
  if (!bucketDelete) throw new Error("staging teardown command list is empty");
  printTeardownPlan(beforeBucketDelete, bucketDelete, args.execute);

  if (!args.execute) {
    process.stderr.write("\n[DRY RUN] not deleting resources. Pass --execute to apply.\n");
    return;
  }

  const r2Config = resolveStagingR2Config(DEFAULT_STAGING_RESOURCES);
  const beforeCode = await runWranglerCommands(beforeBucketDelete);
  if (beforeCode !== 0) process.exit(beforeCode);

  await emptyR2Bucket(makeR2Client(r2Config), DEFAULT_STAGING_RESOURCES.bucket);

  const bucketCode = await runWranglerCommands([bucketDelete]);
  process.exit(bucketCode);
}

function printTeardownPlan(
  beforeBucketDelete: ReturnType<typeof buildStagingTeardownCommands>,
  bucketDelete: ReturnType<typeof buildStagingTeardownCommands>[number],
  execute: boolean,
): void {
  printCommandPlan("staging resource teardown", beforeBucketDelete, execute);
  const mode = execute ? "EXECUTE" : "DRY RUN";
  process.stderr.write(`[${mode}] Empty staging R2 bucket\n`);
  process.stderr.write(
    `[${mode}] $ empty ${DEFAULT_STAGING_RESOURCES.bucket} via R2 S3 API ` +
      `(CORPUS_R2_ACCOUNT_ID/CORPUS_R2_ACCESS_KEY/CORPUS_R2_SECRET_KEY)\n`,
  );
  process.stderr.write(`[${mode}] ${bucketDelete.label}\n`);
  process.stderr.write(`[${mode}] $ wrangler ${bucketDelete.args.join(" ")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
