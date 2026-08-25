import { describe, expect, it, vi } from "vitest";
import {
  SimilarityStore,
  similarityStoreFor,
  tenantNamespace,
  tenantVectorId,
} from "../../../src/modules/stores/similarity-store";
import { EMBEDDING_DIM } from "../../../src/schemas/api";
import { parseTenantId } from "../../../src/control-plane/ids";

const A = "usr_550e8400-e29b-41d4-a716-446655440000";
const B = "usr_6ba7b810-9dad-41d4-80b4-00c04fd430c8";
const TENANT_A = { tenantId: parseTenantId(A)! };
const TENANT_B = { tenantId: parseTenantId(B)! };
const vec = () => Array.from({ length: EMBEDDING_DIM }, () => 0.1);
const meta = { url: "https://a.com" };

// A fake index that honours `namespace` the way Vectorize does: a vector is
// only visible to a query in the same namespace.
function namespacedIndex() {
  const stored: {
    id: string;
    namespace?: string;
    values: number[];
    metadata: Record<string, unknown>;
  }[] = [];
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs)
      stored.push({
        id: v.id,
        namespace: v.namespace,
        values: v.values as number[],
        metadata: (v.metadata ?? {}) as Record<string, unknown>,
      });
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const query = vi.fn(async (_v: number[], opts: VectorizeQueryOptions) => {
    const matches = stored
      .filter((s) => s.namespace === opts.namespace)
      .map((s) => ({ id: s.id, score: 0.9, metadata: s.metadata }));
    return { count: matches.length, matches } as unknown as VectorizeMatches;
  });
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) {
      const at = stored.findIndex((s) => s.id === id);
      if (at >= 0) stored.splice(at, 1);
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  return { index: { upsert, query, deleteByIds } as unknown as VectorizeIndex, upsert, query, deleteByIds, stored };
}

describe("tenantNamespace", () => {
  it("is undefined while the tenant data plane is off, so existing vectors stay visible", () => {
    expect(tenantNamespace(TENANT_A, false)).toBeUndefined();
  });

  it("is the tenant id once the data plane is on", () => {
    expect(tenantNamespace(TENANT_A, true)).toBe(A);
  });

  it("rejects a malformed tenant id rather than writing an unscoped vector", () => {
    expect(() => tenantNamespace({ tenantId: "founder" as never }, true)).toThrow(/malformed tenant id/);
  });
});

describe("similarityStoreFor", () => {
  it("stamps the namespace on upsert when the gate is on", async () => {
    const { index, stored } = namespacedIndex();
    await similarityStoreFor(index, TENANT_A, { TENANT_DATA_PLANE: "1" }).upsert("rd_a", vec(), meta);
    expect(stored[0]!.namespace).toBe(A);
  });

  it("leaves the namespace unset when the gate is off", async () => {
    const { index, stored } = namespacedIndex();
    await similarityStoreFor(index, TENANT_A, {}).upsert("rd_a", vec(), meta);
    expect(stored[0]!.namespace).toBeUndefined();
  });

  it("cannot see another tenant's vectors", async () => {
    const { index } = namespacedIndex();
    const env = { TENANT_DATA_PLANE: "1" };
    await similarityStoreFor(index, TENANT_A, env).upsert("rd_a", vec(), meta);
    await similarityStoreFor(index, TENANT_B, env).upsert("rd_b", vec(), meta);

    const seenByA = await similarityStoreFor(index, TENANT_A, env).query(vec(), 5);
    expect(seenByA.map((m) => m.id)).toEqual(["rd_a"]);

    const seenByB = await similarityStoreFor(index, TENANT_B, env).query(vec(), 5);
    expect(seenByB.map((m) => m.id)).toEqual(["rd_b"]);
  });

  it("shares one namespace across the whole corpus when the gate is off", async () => {
    const { index } = namespacedIndex();
    await similarityStoreFor(index, TENANT_A, {}).upsert("rd_a", vec(), meta);
    await similarityStoreFor(index, TENANT_B, {}).upsert("rd_b", vec(), meta);
    const seen = await similarityStoreFor(index, TENANT_A, {}).query(vec(), 5);
    expect(seen.map((m) => m.id).sort()).toEqual(["rd_a", "rd_b"]);
  });
});

describe("tenantVectorId", () => {
  it("is the bare reading id without a namespace (pre-tenant layout)", () => {
    expect(tenantVectorId(undefined, "rd_a")).toBe("rd_a");
  });

  it("prefixes the namespace inside a tenant namespace (ADR 0002)", () => {
    expect(tenantVectorId(A, "rd_a")).toBe(`${A}:rd_a`);
  });
});

// ADR 0002: inside a tenant namespace the stored VECTOR id is
// `{tenantId}:{readingId}` — the same contract the founder migration writes —
// so the namespace-blind deleteByIds cannot address another tenant's vector.
// Callers never see the prefix: the store composes it on the way in and strips
// it from query matches on the way out.
describe("SimilarityStore vector ids inside a namespace", () => {
  const env = { TENANT_DATA_PLANE: "1" };

  it("upserts under the tenant-prefixed id", async () => {
    const { index, stored } = namespacedIndex();
    await similarityStoreFor(index, TENANT_A, env).upsert("rd_a", vec(), meta);
    expect(stored[0]!.id).toBe(`${A}:rd_a`);
  });

  it("deletes by the tenant-prefixed id, so it can only reach its own tenant's vector", async () => {
    const { index, deleteByIds } = namespacedIndex();
    await similarityStoreFor(index, TENANT_A, env).delete("rd_a");
    expect(deleteByIds).toHaveBeenCalledWith([`${A}:rd_a`]);
  });

  it("strips its own prefix from query matches, so callers keep seeing bare reading ids", async () => {
    const { index } = namespacedIndex();
    const store = similarityStoreFor(index, TENANT_A, env);
    await store.upsert("rd_a", vec(), meta);
    const seen = await store.query(vec(), 5);
    expect(seen.map((m) => m.id)).toEqual(["rd_a"]);
  });

  it("round-trips upsert then delete: the vector it wrote is the vector it removes", async () => {
    const { index, stored } = namespacedIndex();
    const store = similarityStoreFor(index, TENANT_A, env);
    await store.upsert("rd_a", vec(), meta);
    await store.delete("rd_a");
    expect(stored).toEqual([]);
  });

  it("stamps tenant_id metadata on namespaced upserts (ADR 0002 audit layer)", async () => {
    // Migration reconciliation rejects a prefixed vector without this stamp
    // once its legacy source is gone (founder-migration.ts), so a realtime
    // reprocess must write the same stamp the migration does.
    const { index, stored } = namespacedIndex();
    await similarityStoreFor(index, TENANT_A, env).upsert("rd_a", vec(), meta);
    expect(stored[0]!.metadata).toEqual({ ...meta, tenant_id: A });
  });

  it("does not leak the tenant_id stamp into query matches", async () => {
    const { index } = namespacedIndex();
    const store = similarityStoreFor(index, TENANT_A, env);
    await store.upsert("rd_a", vec(), meta);
    const seen = await store.query(vec(), 5);
    expect(seen[0]).toEqual({ id: "rd_a", score: 0.9, url: meta.url });
  });

  it("uses bare ids everywhere while the gate is off", async () => {
    const { index, stored, deleteByIds } = namespacedIndex();
    const store = similarityStoreFor(index, TENANT_A, {});
    await store.upsert("rd_a", vec(), meta);
    expect(stored[0]!.id).toBe("rd_a");
    expect(stored[0]!.metadata).toEqual(meta);
    await store.delete("rd_a");
    expect(deleteByIds).toHaveBeenCalledWith(["rd_a"]);
  });
});

describe("SimilarityStore without a namespace", () => {
  it("stays backwards compatible for callers that pass no scope", async () => {
    const { index, stored, query } = namespacedIndex();
    const store = new SimilarityStore(index);
    await store.upsert("rd_a", vec(), meta);
    await store.query(vec(), 5);
    expect(stored[0]!.namespace).toBeUndefined();
    expect(query.mock.calls[0]![1].namespace).toBeUndefined();
  });
});
