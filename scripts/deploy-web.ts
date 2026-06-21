#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Args {
  execute: boolean;
  skipBuild: boolean;
  branch: string;
}

const WEB_DIR = "web";
const DIST_DIR = "web/dist";

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      branch: { type: "string", default: "main" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    execute: values.execute === true,
    skipBuild: values["skip-build"] === true,
    branch: values.branch ?? "main",
  };
}

function printUsage() {
  process.stderr.write(`Usage: tsx scripts/deploy-web.ts [--branch <name>] [--execute] [--skip-build] [--help]

Builds web/ and deploys web/dist to Cloudflare Pages (project "reading-lite",
branch "main" by default). Dry-run by default - the
build always runs, but the upload only happens with --execute.

  --branch       Pages deploy branch (main=production, staging=preview)
  --execute      actually upload (otherwise prints the would-run command)
  --skip-build   skip "npm run build" inside web/ (use existing web/dist)
  --help         show this message

Idempotent: re-deploying the same web/dist is safe; Pages serves
content-addressed by file hash. Pages classifies a deploy as production
when --branch matches the project's configured production branch (default
"main"); anything else is a preview.
`);
}

function runCmd(cmd: string, cmdArgs: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: "inherit",
      shell: false,
      cwd,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function summarizeDist(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile()) {
        files += 1;
        const s = await stat(p);
        bytes += s.size;
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const args = parseCliArgs();
  const mode = args.execute ? "DEPLOY" : "DRY RUN";

  process.stderr.write(`[${mode}] project=reading-lite branch=${args.branch}\n`);

  if (!args.skipBuild) {
    process.stderr.write(`[${mode}] $ (cd ${WEB_DIR} && npm run build)\n\n`);
    const buildCode = await runCmd("npm", ["run", "build"], WEB_DIR);
    if (buildCode !== 0) {
      process.stderr.write(`\n[${mode}] build failed (exit ${buildCode})\n`);
      process.exit(buildCode);
    }
  } else {
    process.stderr.write(`[${mode}] (skipping build)\n`);
  }

  const summary = await summarizeDist(DIST_DIR).catch((e: unknown) => {
    process.stderr.write(`\n[${mode}] cannot read ${DIST_DIR}: ${(e as Error).message}\n`);
    process.exit(1);
  });
  process.stderr.write(
    `\n[${mode}] ${DIST_DIR}: ${summary.files} files, ${formatBytes(summary.bytes)}\n`,
  );

  const wranglerArgs = buildWranglerPagesArgs(args.branch);
  process.stderr.write(
    `[${mode}] $ (cd ${WEB_DIR} && wrangler ${wranglerArgs.join(" ")})\n\n`,
  );

  if (!args.execute) {
    process.stderr.write(`[${mode}] not uploading. Pass --execute to deploy.\n`);
    process.exit(0);
  }

  const code = await runCmd("wrangler", wranglerArgs, WEB_DIR);
  process.exit(code);
}

function buildWranglerPagesArgs(branch: string): string[] {
  return [
    "pages",
    "deploy",
    "dist",
    `--branch=${branch}`,
    "--commit-dirty=true",
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { buildWranglerPagesArgs };
