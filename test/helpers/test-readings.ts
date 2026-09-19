// Workers-pool entry to the reading-state test facade: the pool's own bindings.
// Tests on the file's fixed tenants are cleaned before each test by
// apply-control-plane.ts; tests that want isolation within a file mint a tenant.
import { env } from "cloudflare:test";
import type { TenantContext } from "../../src/control-plane/ids";
import { TestReadings } from "./readings-facade";

export { TestReadings, type SeedOptions } from "./readings-facade";

export function testReadingsFor(tenant: TenantContext): TestReadings {
  return new TestReadings(tenant, env);
}
