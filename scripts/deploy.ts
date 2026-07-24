#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

interface Args {
  execute: boolean;
  env: "production" | "staging";
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      env: { type: "string", default: "production" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const env = parseDeployEnv(values.env);
  if (!env) {
    process.stderr.write(`invalid --env: ${values.env}. Expected production or staging.\n`);
    process.exit(2);
  }

  return { execute: values.execute === true, env };
}

function printUsage() {
  process.stderr.write(`Usage: tsx scripts/deploy.ts [--env production|staging] [--execute] [--help]

Deploys the Cloudflare Worker (reading-lite). Dry-run by default - pass
--execute to actually upload.

  --env       worker environment to deploy (default: production)
  --execute   actually upload (otherwise wrangler --dry-run is passed)
  --help      show this message

Idempotent: re-running with the same source produces the same Worker version.

Secrets are NOT managed here. Set them once with:
  wrangler secret put READER_API_TOKEN
  wrangler secret put OPENAI_API_KEY

OPENAI_API_KEY is always required for embeddings and for the default OpenAI
summarizer. If SUMMARIZER_PROVIDER=anthropic, also set:
  wrangler secret put ANTHROPIC_API_KEY
`);
}

function parseDeployEnv(value: unknown): Args["env"] | null {
  return value === "production" || value === "staging" ? value : null;
}

function buildWranglerArgs(args: Args): string[] {
  const out = ["deploy", "--env", args.env];
  if (!args.execute) out.push("--dry-run");
  return out;
}

function runWrangler(wranglerArgs: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", wranglerArgs, {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const args = parseCliArgs();
  const wranglerArgs = buildWranglerArgs(args);
  const mode = args.execute ? "DEPLOY" : "DRY RUN";
  process.stderr.write(
    `[${mode}] worker=reading-lite env=${args.env}\n` +
      `[${mode}] $ wrangler ${wranglerArgs.join(" ")}\n\n`,
  );
  const code = await runWrangler(wranglerArgs);
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { buildWranglerArgs, parseDeployEnv };
