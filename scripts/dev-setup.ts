#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runFounderBootstrap } from "./lib/founder-bootstrap";
import { loadDotVars } from "./lib/dotvars";
import { wranglerSpawnArgs } from "./lib/wrangler-cli";

const LOCAL_D1 = "reading-lite-control-dev";

export interface DevSetupDeps {
  run?: (command: string, args: string[]) => Promise<number>;
  bootstrap?: typeof runFounderBootstrap;
}

function defaultRun(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function runDevSetup(deps: DevSetupDeps = {}): Promise<number> {
  const run = deps.run ?? defaultRun;
  const bootstrap = deps.bootstrap ?? runFounderBootstrap;

  const launched = wranglerSpawnArgs(["d1", "migrations", "apply", LOCAL_D1, "--local"]);
  const migrationCode = await run(launched.command, launched.args);
  if (migrationCode !== 0) return migrationCode;

  const result = await bootstrap(
    { execute: true, env: "local", confirmProduction: false },
    {
      envVars: { ...loadDotVars(".dev.vars"), ...process.env },
      nowMs: Date.now(),
      write: () => {},
      openDb: async () => {
        const { makeWranglerD1 } = await import("./lib/founder-bootstrap");
        return makeWranglerD1({ database: LOCAL_D1, local: true });
      },
    },
  );
  return result.exitCode;
}

async function main(): Promise<void> {
  process.exit(await runDevSetup());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
