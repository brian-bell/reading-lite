// Local PostgreSQL for `npm run dev` and `npm run seed:local` (ADR 0005). The
// default is the docker-compose `postgres` service on its non-default host
// port; wrangler.toml's local Hyperdrive connection string names the same
// database. Setting READING_LITE_DATABASE_URL (shell or .dev.vars) means "I run
// my own Postgres": nothing is started, and the Worker must be pointed at it
// too via CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE.
//
// Deliberately not DATABASE_URL: many shells export one for another project,
// and dev setup migrates and seeds whatever this names.

import pg from "pg";
import { migrate, readMigrations, type MigrationFile } from "./migrate";

export const LOCAL_DATABASE_URL = "postgres://reading_lite:reading_lite@127.0.0.1:54329/reading_lite";
export const LOCAL_DATABASE_URL_ENV = "READING_LITE_DATABASE_URL";
export const COMPOSE_UP_POSTGRES = ["compose", "up", "-d", "--wait", "postgres"];

export interface LocalDatabase {
  url: string;
  // True when this is the compose service, which setup may start.
  managed: boolean;
}

export function localDatabase(envVars: Record<string, string | undefined>): LocalDatabase {
  const override = envVars[LOCAL_DATABASE_URL_ENV]?.trim();
  return override ? { url: override, managed: false } : { url: LOCAL_DATABASE_URL, managed: true };
}

// `docker compose up --wait` already waits for the health check; the short
// retry covers a self-managed server that is still starting.
export async function connectLocal(url: string, attempts = 10, delayMs = 1000): Promise<pg.Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Local Postgres is unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function migrateLocalPostgres(url: string): Promise<MigrationFile[]> {
  const client = await connectLocal(url);
  try {
    return await migrate(client, readMigrations());
  } finally {
    await client.end();
  }
}
