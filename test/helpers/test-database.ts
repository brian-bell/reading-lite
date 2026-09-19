// The PostgreSQL test database, shared by the Node-pool tests (direct) and the
// workers pool (through the HYPERDRIVE local connection string). CI sets
// TEST_DATABASE_URL to its service container; locally it is the docker-compose
// `postgres` service. Never a Neon URL.
//
// Locally each checkout gets its own database, named from its path. Every run
// truncates the reading tables, so two worktrees sharing one database would
// delete each other's rows mid-run, and worktrees whose db/migrations differ
// would hit migration drift.
import { createHash } from "node:crypto";
import path from "node:path";

const CHECKOUT = path.resolve(import.meta.dirname, "..", "..");
const SUFFIX = createHash("sha256").update(CHECKOUT).digest("hex").slice(0, 8);

export const LOCAL_TEST_DATABASE_URL =
  `postgres://reading_lite:reading_lite@127.0.0.1:54329/reading_lite_test_${SUFFIX}`;

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? LOCAL_TEST_DATABASE_URL;
}

// wrangler.test.toml's localConnectionString yields to this variable. The test
// run always sets it, so the workers pool can never drift from the database
// globalSetup prepared, whatever the developer's shell exports for `npm run dev`.
export const HYPERDRIVE_LOCAL_ENV = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
