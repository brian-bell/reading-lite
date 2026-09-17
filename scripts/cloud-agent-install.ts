#!/usr/bin/env tsx
import { chmodSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runFounderBootstrap } from "./lib/founder-bootstrap";

export interface CloudAgentInstallDeps {
  cwd?: string;
  envVars?: Record<string, string | undefined>;
  writeFile?: (filePath: string, content: string) => void;
  chmod?: (filePath: string, mode: number) => void;
  log?: (line: string) => void;
  run?: (command: string, args: string[]) => Promise<number>;
  founderBootstrap?: typeof runFounderBootstrap;
}

const DEFAULT_FOUNDER_EMAIL = "bellbm@gmail.com";
export const BEADS_VERSION = "1.3.0";

export function resolveFounderEmail(env: Record<string, string | undefined>): string {
  return env.FOUNDER_EMAIL?.trim() || DEFAULT_FOUNDER_EMAIL;
}

export function renderStgVars(env: Record<string, string | undefined>): string | null {
  const authRoot = env.AUTH_ROOT_SECRET?.trim();
  const readerToken = env.READER_API_TOKEN?.trim();
  if (!authRoot || !readerToken) return null;

  const founderEmail = resolveFounderEmail(env);
  return [
    `AUTH_ROOT_SECRET=${authRoot}`,
    `FOUNDER_EMAIL=${founderEmail}`,
    `READER_API_TOKEN=${readerToken}`,
    "",
  ].join("\n");
}

// Beads is the work tracker. Its database clones from refs/dolt/data on the
// git remote. A failure here must not block the rest of the install.
async function setUpBeads(
  run: (command: string, args: string[]) => Promise<number>,
  log: (line: string) => void,
): Promise<void> {
  const exitCode = async (command: string, args: string[]) => {
    try {
      return await run(command, args);
    } catch {
      return 127;
    }
  };
  if ((await exitCode("bd", ["version"])) !== 0) {
    if ((await exitCode("npm", ["install", "-g", `@beads/bd@${BEADS_VERSION}`])) !== 0) {
      log(`[cloud-agent-install] warning: beads install failed; install @beads/bd@${BEADS_VERSION} to use bd`);
      return;
    }
  }
  if ((await exitCode("bd", ["bootstrap", "--yes"])) !== 0) {
    log("[cloud-agent-install] warning: beads bootstrap failed; run `bd bootstrap` with git access to the remote");
    return;
  }
  log("[cloud-agent-install] beads database ready");
}

function defaultRun(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function runCloudAgentInstall(deps: CloudAgentInstallDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const envVars = deps.envVars ?? process.env;
  const writeFile = deps.writeFile ?? writeFileSync;
  const chmod = deps.chmod ?? chmodSync;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const run = deps.run ?? defaultRun;
  const founderBootstrap = deps.founderBootstrap ?? runFounderBootstrap;

  await setUpBeads(run, log);

  const stgVarsPath = path.join(cwd, ".stg.vars");
  const stgVars = renderStgVars(envVars);
  if (stgVars) {
    writeFile(stgVarsPath, stgVars);
    chmod(stgVarsPath, 0o600);
    log("[cloud-agent-install] wrote .stg.vars from environment secrets");
  } else {
    log(
      "[cloud-agent-install] skipping .stg.vars (set AUTH_ROOT_SECRET and READER_API_TOKEN in environment secrets)",
    );
  }

  if (envVars.CLOUDFLARE_API_TOKEN?.trim()) {
    if (!envVars.CLOUDFLARE_ACCOUNT_ID?.trim()) {
      log("[cloud-agent-install] warning: CLOUDFLARE_ACCOUNT_ID unset; some wrangler commands may need it");
    }
    const whoamiCode = await run("npx", ["wrangler", "whoami"]);
    if (whoamiCode !== 0) {
      log("[cloud-agent-install] warning: wrangler whoami failed; check CLOUDFLARE_API_TOKEN");
      return whoamiCode;
    }
    log("[cloud-agent-install] wrangler auth ok (CLOUDFLARE_API_TOKEN)");
  } else if (envVars.CLOUDFLARE_OAUTH_TOKEN?.trim()) {
    log("[cloud-agent-install] warning: prefer CLOUDFLARE_API_TOKEN over CLOUDFLARE_OAUTH_TOKEN for non-interactive agents");
  } else {
    log(
      "[cloud-agent-install] warning: no CLOUDFLARE_API_TOKEN; wrangler needs login or a token for staging operations",
    );
  }

  if (envVars.CLOUD_AGENT_FOUNDER_BOOTSTRAP === "1" && stgVars) {
    log("[cloud-agent-install] running idempotent founder-bootstrap for staging");
    const result = await founderBootstrap(
      { execute: true, env: "staging", confirmProduction: false },
      {
        envVars: {
          ...envVars,
          FOUNDER_EMAIL: resolveFounderEmail(envVars),
        },
        nowMs: Date.now(),
        write: (line) => log(`[founder-bootstrap] ${line.trimEnd()}`),
        openDb: async () => {
          const { makeWranglerD1 } = await import("./lib/founder-bootstrap");
          return makeWranglerD1({ database: "reading-lite-control-staging", local: false, wranglerEnv: "staging" });
        },
      },
    );
    if (result.exitCode !== 0) return result.exitCode;
  }

  return 0;
}

async function main(): Promise<void> {
  process.exit(await runCloudAgentInstall());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
