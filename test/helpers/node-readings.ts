// Node-pool entry to the reading-state test facade. The Node pool has no
// bindings, but it can reach the test database directly, so a unit test can run
// the real pipeline against real rows: PostgreSQL through a Hyperdrive-shaped
// object over the direct connection string, R2 through an in-memory bucket.
//
// Nothing rolls these rows back between tests. Seed what a test needs (a seed
// replaces the reading), and mint a tenant when tests in one file would
// otherwise share ids.
import { afterAll } from "vitest";
import type { TenantContext } from "../../src/control-plane/ids";
import { sqlSessionFor } from "../../src/modules/db/sql";
import { TestReadings } from "./readings-facade";
import { testDatabaseUrl } from "./test-database";

export const NODE_HYPERDRIVE = { connectionString: testDatabaseUrl() } as Hyperdrive;

// The R2 surface the content store and the pipeline use, over a Map.
export function memoryBucket(): R2Bucket {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const encode = (value: unknown): Uint8Array =>
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
  return {
    async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, {
        body: encode(value),
        contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
    async get(key: string) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        size: found.body.byteLength,
        httpMetadata: { contentType: found.contentType },
        body: new Blob([found.body]).stream(),
        text: async () => new TextDecoder().decode(found.body),
        arrayBuffer: async () => found.body.buffer,
      };
    },
    async head(key: string) {
      return objects.has(key) ? { size: objects.get(key)!.body.byteLength } : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list(opts: { prefix?: string } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(opts.prefix ?? "")).sort();
      return { objects: keys.map((key) => ({ key, size: objects.get(key)!.body.byteLength })), truncated: false };
    },
  } as unknown as R2Bucket;
}

// One session per test file, ended after it.
const session = sqlSessionFor({ HYPERDRIVE: NODE_HYPERDRIVE });
afterAll(() => session.end());

export function nodeReadingsFor(tenant: TenantContext, bucket: R2Bucket = memoryBucket()): TestReadings {
  return new TestReadings(tenant, { HYPERDRIVE: NODE_HYPERDRIVE, READINGS_BUCKET: bucket }, session);
}
