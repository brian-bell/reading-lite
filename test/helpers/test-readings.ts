// Workers-pool entry to the reading-state test facade: the pool's own bindings.
// Tests on the file's fixed tenants are cleaned before each test by
// apply-control-plane.ts; tests that want isolation within a file mint a tenant.
//
// One database session, ended after each test: a connection per statement
// floods the local Hyperdrive proxy under a parallel run, and workerd ties a
// socket to the test that opened it, so a client never outlives its test. The
// session reopens lazily.
import { env } from "cloudflare:test";
import { afterEach } from "vitest";
import type { TenantContext } from "../../src/control-plane/ids";
import { sqlSessionFor } from "../../src/modules/db/sql";
import { TestReadings } from "./readings-facade";

export { TestReadings, type SeedOptions } from "./readings-facade";

const session = sqlSessionFor(env);
afterEach(() => session.end());

export function testReadingsFor(tenant: TenantContext): TestReadings {
  return new TestReadings(tenant, env, session);
}
