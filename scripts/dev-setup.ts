#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openPostgresControlPlane, runFounderBootstrap } from "./lib/founder-bootstrap";
import { loadDotVars } from "./lib/dotvars";
import { COMPOSE_UP_POSTGRES, localDatabase, migrateLocalPostgres } from "./pg-lib/local-postgres";

export interface DevSetupDeps {
  run?: (command: string, args: string[]) => Promise<number>;
  bootstrap?: typeof runFounderBootstrap;
  envVars?: Record<string, string | undefined>;
  migratePostgres?: (databaseUrl: string) => Promise<unknown>;
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
  const envVars = deps.envVars ?? { ...loadDotVars(".dev.vars"), ...process.env };

  // PostgreSQL first (ADR 0005): start the compose service unless
  // READING_LITE_DATABASE_URL names a self-managed server, then bring the schema up to date.
  const database = localDatabase(envVars);
  if (database.managed) {
    const composeCode = await run("docker", COMPOSE_UP_POSTGRES);
    if (composeCode !== 0) {
      console.error(
        "Could not start local Postgres with `docker compose up -d --wait postgres`. " +
          "Start Docker, or set READING_LITE_DATABASE_URL to a PostgreSQL 18 server with pgvector. See docs/operations.md#local-postgres.",
      );
      return composeCode;
    }
  }
  try {
    await (deps.migratePostgres ?? migrateLocalPostgres)(database.url);
  } catch (error) {
    console.error(
      `Local Postgres migration failed: ${error instanceof Error ? error.message : String(error)}. ` +
        "See docs/operations.md#local-postgres.",
    );
    return 1;
  }

  // The founder goes to PostgreSQL, the control plane's store (ADR 0005).
  const result = await bootstrap(
    { execute: true, env: "local", confirmProduction: false, databaseUrlEnv: "DATABASE_URL" },
    {
      envVars,
      nowMs: Date.now(),
      write: () => {},
      openDb: openPostgresControlPlane,
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
