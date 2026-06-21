#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { loadDotVars } from "./lib/dotvars";
import type { R2Client, R2Config } from "./lib/cf-clients";

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
  idempotentOk?: RegExp[];
}

export interface WranglerRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type WranglerRunner = (args: string[]) => Promise<WranglerRunResult>;

export interface RunWranglerDeps {
  runner?: WranglerRunner;
  log?: (line: string) => void;
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

const ALREADY_EXISTS = [
  /already exists/i,
  /exists, and you own it/i,
  /name already exists/i,
];

const MISSING_RESOURCE = [
  /does not exist/i,
  /not found/i,
  /NoSuchBucket/i,
];

const MISSING_CONSUMER = [
  ...MISSING_RESOURCE,
  /not a consumer/i,
  /no consumer/i,
  /not configured/i,
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
      idempotentOk: ALREADY_EXISTS,
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
      idempotentOk: ALREADY_EXISTS,
    },
    {
      label: "Create staging queue",
      args: ["queues", "create", resources.queue],
      idempotentOk: ALREADY_EXISTS,
    },
    {
      label: "Create staging dead-letter queue",
      args: ["queues", "create", resources.dlq],
      idempotentOk: ALREADY_EXISTS,
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
      idempotentOk: MISSING_CONSUMER,
    },
    {
      label: "Remove staging dead-letter queue consumer",
      args: ["queues", "consumer", "remove", resources.dlq, resources.worker],
      idempotentOk: MISSING_CONSUMER,
    },
    {
      label: "Delete staging Worker",
      args: ["delete", resources.worker, "--env", resources.env, "--force"],
      idempotentOk: MISSING_RESOURCE,
    },
    {
      label: "Delete staging queue",
      args: ["queues", "delete", resources.queue],
      idempotentOk: MISSING_RESOURCE,
    },
    {
      label: "Delete staging dead-letter queue",
      args: ["queues", "delete", resources.dlq],
      idempotentOk: MISSING_RESOURCE,
    },
    {
      label: "Delete staging Vectorize index",
      args: ["vectorize", "delete", resources.vectorizeIndex, "--force"],
      idempotentOk: MISSING_RESOURCE,
    },
    {
      label: "Delete staging R2 bucket",
      args: ["r2", "bucket", "delete", resources.bucket],
      idempotentOk: MISSING_RESOURCE,
    },
  ];
}

export function buildSecretCommands(): string[] {
  return STAGING_SECRET_NAMES.map((name) => `wrangler secret put ${name} --env staging`);
}

export function resolveStagingR2Config(
  resources: StagingResources,
  vars?: Record<string, string | undefined>,
): R2Config {
  validateStagingResources(resources);
  const resolvedVars =
    vars ??
    {
      ...loadDotVars(".corpus.vars"),
      ...process.env,
    };
  const missing: string[] = [];
  const need = (key: string): string => {
    const value = resolvedVars[key];
    if (!value) missing.push(key);
    return value ?? "";
  };
  const config = {
    accountId: need("CORPUS_R2_ACCOUNT_ID"),
    accessKeyId: need("CORPUS_R2_ACCESS_KEY"),
    secretAccessKey: need("CORPUS_R2_SECRET_KEY"),
    bucket: resources.bucket,
  };
  if (missing.length > 0) {
    throw new Error(
      `missing staging teardown R2 config: ${missing.join(", ")} ` +
        `(set in env or .corpus.vars)`,
    );
  }
  return config;
}

export async function emptyR2Bucket(
  client: Pick<R2Client, "listKeys" | "delete">,
  bucket: string,
  log: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Promise<number> {
  if (!bucket.includes("staging") || bucket === "reading-lite") {
    throw new Error(`refusing to empty non-staging bucket: ${bucket}`);
  }
  let keys: string[];
  try {
    keys = await client.listKeys();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NoSuchBucket|not found|does not exist|404/i.test(message)) {
      log(`[EXECUTE] R2 bucket ${bucket} is already absent`);
      return 0;
    }
    throw error;
  }
  log(`[EXECUTE] empty R2 bucket ${bucket}: deleting ${keys.length} objects`);
  for (const key of keys) {
    await client.delete(key);
    log(`[EXECUTE] deleted R2 object ${bucket}/${key}`);
  }
  return keys.length;
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
  deps: RunWranglerDeps = {},
): Promise<number> {
  const runner = deps.runner ?? runWrangler;
  const log = deps.log ?? ((line: string) => process.stderr.write(line + "\n"));
  for (const command of commands) {
    log("");
    log(`[EXECUTE] ${command.label}`);
    log(`[EXECUTE] $ wrangler ${command.args.join(" ")}`);
    const result = await runner(command.args);
    if (result.code === 0) continue;

    const output = `${result.stdout}\n${result.stderr}`;
    if (command.idempotentOk?.some((pattern) => pattern.test(output))) {
      log(`[EXECUTE] already satisfied: ${command.label}`);
      continue;
    }
    return result.code;
  }
  return 0;
}

function runWrangler(args: string[]): Promise<WranglerRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}
