#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

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

function printUsage() {
  process.stderr.write(`Usage: tsx scripts/deploy.ts [--execute] [--help]

Deploys the Cloudflare Worker (reading-lite). Dry-run by default — pass
--execute to actually upload.

  --execute   actually upload (otherwise wrangler --dry-run is passed)
  --help      show this message

Idempotent: re-running with the same source produces the same Worker version.

Secrets are NOT managed here. Set them once with:
  wrangler secret put READER_API_TOKEN
  wrangler secret put ANTHROPIC_API_KEY
  wrangler secret put OPENAI_API_KEY
`);
}

function buildWranglerArgs(args: Args): string[] {
  const out = ["deploy", "--env", "production"];
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
    `[${mode}] worker=reading-lite\n` +
      `[${mode}] $ wrangler ${wranglerArgs.join(" ")}\n\n`,
  );
  const code = await runWrangler(wranglerArgs);
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
