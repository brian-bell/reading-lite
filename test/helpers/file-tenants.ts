// Tenant ids for the fixed test tenants, one set per test file (ADR 0005).
//
// The workers pool rolls R2, D1 and Durable Objects back after every test, but
// not PostgreSQL: every file shares one database and files run in parallel. A
// founder id shared by all of them would let one file list, claim or purge
// another's readings. Deriving the ids from the test file's path gives each
// file its own tenants without a database per worker (the pool has one
// Hyperdrive string) or serial files. test/apply-control-plane.ts clears these
// tenants' rows before each test, which matches the per-test rollback the
// other stores get.
//
// Helper modules are evaluated once per test file, so these are constants
// within a file. Outside a test run there is no path and the ids are the
// historical fixed ones.
import { expect } from "vitest";

const FIXED_FOUNDER = "550e8400-e29b-41d4-a716-446655440000";
const FIXED_OTHER = "11111111-1111-4111-8111-111111111111";

async function uuidFor(label: string, testPath: string): Promise<string> {
  // From `test/` on, so the id does not depend on where the checkout lives.
  const relative = testPath.slice(testPath.lastIndexOf("/test/") + 1);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${label}:${relative}`));
  const h = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const testPath = expect.getState().testPath;

export const FOUNDER_TENANT_ID = `usr_${testPath ? await uuidFor("founder", testPath) : FIXED_FOUNDER}`;
export const OTHER_TENANT_ID = `usr_${testPath ? await uuidFor("other", testPath) : FIXED_OTHER}`;
