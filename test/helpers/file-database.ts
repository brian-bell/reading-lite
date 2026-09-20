// Workers-pool isolation for PostgreSQL (ADR 0005). The pool rolls R2, D1 and
// Durable Object storage back after every test, but PostgreSQL is outside it,
// and the control plane has global state no tenant id can partition: the
// founder's email, the legacy token's HMAC, the system_policy singleton. So
// every test file gets its own database, cloned from a migrated template:
//
//   globalSetup   migrates `<base>_tpl`, which nothing ever connects to
//                 (CREATE DATABASE … TEMPLATE refuses a source in use), and
//                 drops the clones when the run ends
//   setup file    clones it as `<base>_f_<random>` and points env.HYPERDRIVE at
//                 the clone, before any test opens a connection
//
// Tests hand `env` to worker.fetch, worker.queue and the stores themselves, so
// the redirect reaches all of them. `SELF` dispatches with the runtime's own
// bindings and still sees the base database; only operator-status uses it.
//
// Pure naming only: this file loads in both Node (globalSetup) and workerd.

export const templateDatabaseName = (base: string): string => `${base}_tpl`;

export const fileDatabasePrefix = (base: string): string => `${base}_f_`;

// PostgreSQL identifiers cap at 63 bytes; CI's base name is short and the
// local one is `reading_lite_test_<8 hex>`, so 12 random hex characters fit.
export function fileDatabaseName(base: string, random: string): string {
  return `${fileDatabasePrefix(base)}${random.replaceAll("-", "").slice(0, 12)}`;
}

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// The same server and credentials, another database.
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
}

export function databaseOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}
