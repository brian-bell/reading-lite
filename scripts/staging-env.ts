#!/usr/bin/env tsx
import { spawn } from "node:child_process";

export interface StagingResources {
  env: "staging";
  worker: string;
  bucket: string;
  vectorizeIndex: string;
  queue: string;
  dlq: string;
}

export interface WranglerCommand {
  label: string;
  args: string[];
}

export const DEFAULT_STAGING_RESOURCES: StagingResources = {
  env: "staging",
  worker: "reading-lite-staging",
  bucket: "reading-lite-staging",
  vectorizeIndex: "reading-lite-staging",
  queue: "reading-lite-staging",
  dlq: "reading-lite-staging-dlq",
};

const STAGING_SECRET_NAMES = [
  "READER_API_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
];

export function validateStagingResources(resources: StagingResources): void {
  for (const [name, value] of Object.entries(resources)) {
    if (name === "env") {
      if (value !== "staging") {
        throw new Error(`refusing staging script env: ${value}`);
      }
      continue;
    }
    if (!value.includes("staging") || value === "reading-lite") {
      throw new Error(`refusing staging script resource name for ${name}: ${value}`);
    }
  }
}

export function buildStagingSetupCommands(
  resources: StagingResources,
): WranglerCommand[] {
  validateStagingResources(resources);
  return [
    {
      label: "Create staging R2 bucket",
      args: ["r2", "bucket", "create", resources.bucket],
    },
    {
      label: "Create staging Vectorize index",
      args: [
        "vectorize",
        "create",
        resources.vectorizeIndex,
        "--dimensions=1536",
        "--metric=cosine",
      ],
    },
    {
      label: "Create staging queue",
      args: ["queues", "create", resources.queue],
    },
    {
      label: "Create staging dead-letter queue",
      args: ["queues", "create", resources.dlq],
    },
  ];
}

export function buildStagingTeardownCommands(
  resources: StagingResources,
): WranglerCommand[] {
  validateStagingResources(resources);
  return [
    {
      label: "Remove staging queue consumer",
      args: ["queues", "consumer", "remove", resources.queue, resources.worker],
    },
    {
      label: "Remove staging dead-letter queue consumer",
      args: ["queues", "consumer", "remove", resources.dlq, resources.worker],
    },
    {
      label: "Delete staging Worker",
      args: ["delete", resources.worker, "--env", resources.env, "--force"],
    },
    {
      label: "Delete staging queue",
      args: ["queues", "delete", resources.queue],
    },
    {
      label: "Delete staging dead-letter queue",
      args: ["queues", "delete", resources.dlq],
    },
    {
      label: "Delete staging Vectorize index",
      args: ["vectorize", "delete", resources.vectorizeIndex, "--force"],
    },
    {
      label: "Delete staging R2 bucket",
      args: ["r2", "bucket", "delete", resources.bucket],
    },
  ];
}

export function buildSecretCommands(): string[] {
  return STAGING_SECRET_NAMES.map((name) => `wrangler secret put ${name} --env staging`);
}

export function printCommandPlan(
  title: string,
  commands: WranglerCommand[],
  execute: boolean,
): void {
  const mode = execute ? "EXECUTE" : "DRY RUN";
  process.stderr.write(`[${mode}] ${title}\n`);
  for (const command of commands) {
    process.stderr.write(`[${mode}] ${command.label}\n`);
    process.stderr.write(`[${mode}] $ wrangler ${command.args.join(" ")}\n`);
  }
}

export async function runWranglerCommands(
  commands: WranglerCommand[],
): Promise<number> {
  for (const command of commands) {
    process.stderr.write(`\n[EXECUTE] ${command.label}\n`);
    process.stderr.write(`[EXECUTE] $ wrangler ${command.args.join(" ")}\n`);
    const code = await runWrangler(command.args);
    if (code !== 0) return code;
  }
  return 0;
}

function runWrangler(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", args, {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
