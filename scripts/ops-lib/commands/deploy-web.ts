// `ops deploy web` — build web/ and deploy web/dist to Cloudflare Pages
// (project "reading-lite").
//
// Plan-first: a mode-less run prints the build and upload commands and, when a
// web/dist already exists, its file/byte summary — it neither builds nor
// uploads, so no new build output is left behind. --execute builds (unless
// --skip-build) and uploads.

import { parseArgs } from "node:util";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface DeployWebDeps extends BaseDeps {
  runCmd: (cmd: string, args: string[], cwd?: string) => Promise<number>;
  summarizeDist: (dir: string) => Promise<{ files: number; bytes: number }>;
}

const WEB_DIR = "web";
const DIST_DIR = "web/dist";

export function buildWranglerPagesArgs(branch: string): string[] {
  return [
    "pages",
    "deploy",
    "dist",
    `--branch=${branch}`,
    "--commit-dirty=true",
  ];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

async function runDeployWeb(argv: string[], deps: DeployWebDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        execute: { type: "boolean", default: false },
        "skip-build": { type: "boolean", default: false },
        branch: { type: "string", default: "main" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const execute = values.execute === true;
  const skipBuild = values["skip-build"] === true;
  const branch = values.branch ?? "main";
  const { io } = deps;
  const mode = execute ? "DEPLOY" : "PLAN";
  const wranglerArgs = buildWranglerPagesArgs(branch);

  io.stderr(`[${mode}] project=reading-lite branch=${branch}`);

  if (!execute) {
    // A plan must not leave a fresh web/dist behind, so the build is only
    // described, never run. Summarize an existing dist when there is one.
    io.stderr(
      skipBuild
        ? `[${mode}] (skipping build)`
        : `[${mode}] would run: (cd ${WEB_DIR} && npm run build)`,
    );
    const summary = await deps.summarizeDist(DIST_DIR).catch(() => null);
    io.stderr(
      summary
        ? `[${mode}] existing ${DIST_DIR}: ${summary.files} files, ${formatBytes(summary.bytes)}`
        : `[${mode}] no existing ${DIST_DIR}`,
    );
    io.stderr(`[${mode}] would run: (cd ${WEB_DIR} && wrangler ${wranglerArgs.join(" ")})`);
    io.stderr(`[${mode}] not building or uploading. Pass --execute to deploy.`);
    return 0;
  }

  if (!skipBuild) {
    io.stderr(`[${mode}] $ (cd ${WEB_DIR} && npm run build)\n`);
    const buildCode = await deps.runCmd("npm", ["run", "build"], WEB_DIR);
    if (buildCode !== 0) {
      io.stderr(`\n[${mode}] build failed (exit ${buildCode})`);
      return buildCode;
    }
  } else {
    io.stderr(`[${mode}] (skipping build)`);
  }

  let summary;
  try {
    summary = await deps.summarizeDist(DIST_DIR);
  } catch (e) {
    io.stderr(`\n[${mode}] cannot read ${DIST_DIR}: ${(e as Error).message}`);
    return 1;
  }
  io.stderr(`\n[${mode}] ${DIST_DIR}: ${summary.files} files, ${formatBytes(summary.bytes)}`);
  io.stderr(`[${mode}] $ (cd ${WEB_DIR} && wrangler ${wranglerArgs.join(" ")})\n`);

  return deps.runCmd("wrangler", wranglerArgs, WEB_DIR);
}

export const deployWebCommand: CommandDefinition<DeployWebDeps> = {
  group: "deploy",
  name: "web",
  summary: "Build web/ and deploy web/dist to Cloudflare Pages",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- deploy web [--branch <name>] [--execute] [--skip-build]

Plans by default: prints the build and upload commands (and the existing
web/dist summary, if any) without building or uploading, so a plan leaves no
new build output behind. --execute builds and uploads.

Options:
  --branch       Pages deploy branch (main=production, staging=preview).
  --execute      Build (unless --skip-build) and upload.
  --skip-build   Skip "npm run build" inside web/ (use existing web/dist).
  --help         Show this message.

Idempotent: re-deploying the same web/dist is safe; Pages serves
content-addressed by file hash. Pages classifies a deploy as production
when --branch matches the project's configured production branch (default
"main"); anything else is a preview.`,
  defaultDeps: (io: CommandIo): DeployWebDeps => ({
    io,
    runCmd: async (cmd, args, cwd) => {
      const { spawnCommand } = await import("../../lib/wrangler-cli");
      return new Promise((resolve, reject) => {
        const child = spawnCommand(cmd, args, { stdio: "inherit", cwd });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      });
    },
    summarizeDist: async (dir) => {
      const { readdir, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");
      let files = 0;
      let bytes = 0;
      async function walk(d: string): Promise<void> {
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
    },
  }),
  run: runDeployWeb,
};
