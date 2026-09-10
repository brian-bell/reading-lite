import { describe, expect, it, vi } from "vitest";
import { processReading } from "../../../src/process-reading";
import type { Env } from "../../../src/index";
import type { Services } from "../../../src/services";
import { founderTenant, PUBLIC_LOOKUP } from "../../helpers/tenant-fixtures";

function args() {
  return {
    id: "rd_TEST",
    url: "https://example.com/x",
    urlHash: "a".repeat(64),
    createdAt: "2026-04-26T20:00:00.000Z",
    keyPrefix: "readings/2026/04/26T200000Z-rd_TEST",
  };
}

function envWith(bucket: R2Bucket): Env {
  return {
    READINGS_BUCKET: bucket,
    READINGS_INDEX: {
      upsert: vi.fn(),
      query: vi.fn(),
      deleteByIds: vi.fn(async () => ({ mutationId: "m" })),
    } as unknown as VectorizeIndex,
    READER_API_TOKEN: "x",
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    FETCH_TIMEOUT_MS: "20000",
    FETCH_MAX_BYTES: "10485760",
    CORS_ALLOWED_ORIGINS: "",
    PENDING_TTL_SECONDS: "300",
  } as unknown as Env;
}

function services(): Services {
  return {
    fetch: vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch,
    lookup: PUBLIC_LOOKUP,
    now: () => "2026-04-26T20:00:01.000Z",
    newId: () => "rd_TEST",
  };
}

// Activation always writes the pending manifest before enqueueing, and the
// consumer refuses to write anything for a reading with no stored trace (the
// purge guard) — so the realistic consumer state is a bucket that serves the
// pending manifest and fails only on the writes under test.
function manifestGet() {
  const a = args();
  const body = JSON.stringify({
    id: a.id,
    url: a.url,
    url_hash: a.urlHash,
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: a.createdAt,
    updated_at: a.createdAt,
  });
  return vi.fn(async (key: string) => {
    if (key !== `${a.keyPrefix}/manifest.json`) return null;
    return { text: async () => body, json: async () => JSON.parse(body), etag: "e1" };
  });
}

describe("processReading — markFailed is defensive against R2 outages", () => {
  it("does not propagate when writeManifest in markFailed throws", async () => {
    // Extractor throws (services.fetch fails) → markFailed runs → writeManifest
    // throws on a totally broken bucket. processReading must swallow + log;
    // the request already returned 202 and there's nothing for the caller to
    // do with a thrown promise from waitUntil.
    const bucket = {
      get: manifestGet(),
      put: vi.fn(async () => {
        throw new Error("R2 outage");
      }),
      head: vi.fn(async () => null),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processReading(args(), envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("does not propagate when appendOrReplaceListIndexItem in markFailed throws", async () => {
    // writeManifest succeeds (put for manifest.json works), but the index
    // append fails. markFailed must not bubble that out either.
    const bucket = {
      get: manifestGet(),
      put: vi.fn(async (key: string) => {
        if (key === "index/list.json") throw new Error("R2 partial outage");
      }),
      head: vi.fn(async () => null),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processReading(args(), envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("does not write attempt or failed manifest when a purge tombstone appears mid-flight", async () => {
    const a = args();
    const tombstoneKey = `index/deleted/${a.id}`;
    let tombstoneHeads = 0;
    const put = vi.fn(async (_key: string, _body?: string) => undefined);
    const bucket = {
      get: manifestGet(),
      put,
      head: vi.fn(async (key: string) => {
        if (key !== tombstoneKey) return null;
        tombstoneHeads += 1;
        return tombstoneHeads > 1 ? { key } : null;
      }),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();
    consoleErr.mockRestore();

    expect(tombstoneHeads).toBeGreaterThan(1);
    expect(put.mock.calls.some(([key]) => String(key).endsWith("manifest.json"))).toBe(false);
    const attemptBodies = put.mock.calls
      .filter(([key]) => String(key).includes("/attempts/"))
      .map(([, body]) => JSON.parse(String(body)));
    expect(attemptBodies.length).toBeGreaterThan(0);
    expect(attemptBodies.every((body: { status?: string }) => body.status !== "failed")).toBe(true);
  });

  it("sweeps prefix residue and does not recreate failed objects when a purge tombstone appears mid-flight", async () => {
    const a = args();
    const tombstoneKey = `index/deleted/${a.id}`;
    const store = new Map<string, string>([
      [`${a.keyPrefix}/manifest.json`, JSON.stringify({
        id: a.id,
        url: a.url,
        url_hash: a.urlHash,
        status: "pending",
        content_type: "application/octet-stream",
        content_status: "captured",
        content_bytes: 0,
        content_sha256: "0".repeat(64),
        created_at: a.createdAt,
        updated_at: a.createdAt,
      })],
      [`${a.keyPrefix}/extracted.md`, "# leftover after purge sweep"],
    ]);
    let tombstoneHeads = 0;
    const bucket = {
      get: vi.fn(async (key: string) => {
        const body = store.get(key);
        if (body === undefined) return null;
        return { text: async () => body, json: async () => JSON.parse(body), etag: "e1" };
      }),
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, String(value));
      }),
      head: vi.fn(async (key: string) => {
        if (key !== tombstoneKey) return store.has(key) ? { key } : null;
        tombstoneHeads += 1;
        return tombstoneHeads > 1 ? { key } : null;
      }),
      delete: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      }),
      list: vi.fn(async (opts?: { prefix?: string }) => {
        const prefix = opts?.prefix ?? "";
        return {
          objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
          truncated: false,
        };
      }),
    } as unknown as R2Bucket;

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();
    consoleErr.mockRestore();

    expect(tombstoneHeads).toBeGreaterThan(1);
    expect([...store.keys()].some((key) => key.startsWith(`${a.keyPrefix}/`))).toBe(false);
    const puts = (bucket.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      puts
        .filter(([key]) => String(key).endsWith("manifest.json"))
        .every(([, body]) => JSON.parse(String(body)).status !== "failed"),
    ).toBe(true);
    expect(
      puts
        .filter(([key]) => String(key).includes("/attempts/"))
        .every(([, body]) => JSON.parse(String(body)).status !== "failed"),
    ).toBe(true);
  });
});

function pendingBody() {
  const a = args();
  return JSON.stringify({
    id: a.id,
    url: a.url,
    url_hash: a.urlHash,
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: a.createdAt,
    updated_at: a.createdAt,
  });
}

function memoryBucket(
  init: Array<[string, string]>,
  hooks: {
    head?: (key: string, store: Map<string, string>) => Promise<{ key: string } | null>;
    onPut?: (key: string, store: Map<string, string>) => void;
  } = {},
) {
  const store = new Map<string, string>(init);
  const tombstoneKey = `index/deleted/${args().id}`;
  return {
    store,
    tombstoneKey,
    bucket: {
      get: vi.fn(async (key: string) => {
        const body = store.get(key);
        if (body === undefined) return null;
        return { text: async () => body, json: async () => JSON.parse(body), etag: "e1" };
      }),
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, String(value));
        hooks.onPut?.(key, store);
      }),
      head: vi.fn(async (key: string) => {
        if (hooks.head) return hooks.head(key, store);
        return store.has(key) ? { key } : null;
      }),
      delete: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      }),
      list: vi.fn(async (opts?: { prefix?: string }) => {
        const prefix = opts?.prefix ?? "";
        return {
          objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
          truncated: false,
        };
      }),
    } as unknown as R2Bucket,
  };
}

describe("processReading — tombstone prefix sweep on early return", () => {
  it("removes a zombie list row and vector left by a crashed post-sweep publish (#357 P1)", async () => {
    // The crash-recovery gap: a prior delivery published AFTER the purge's
    // final sweep, then died before its post-publish tombstone recheck. The
    // purge already deleted the by-id pointer and returned 200, so a re-issued
    // DELETE answers not_found — this redelivery is the only writer left that
    // can remove the recreated list row, vector, and by-url pointer. A prefix
    // sweep alone leaves the reading listed and searchable forever.
    const a = args();
    const zombieRow = {
      id: a.id,
      key_prefix: a.keyPrefix,
      url: a.url,
      status: "ready",
      created_at: a.createdAt,
    };
    const { store, bucket } = memoryBucket([
      ["index/list.json", JSON.stringify({ version: 1, items: [zombieRow] })],
      [`index/by-url/${a.urlHash}`, JSON.stringify({ id: a.id, key_prefix: a.keyPrefix })],
      [`${a.keyPrefix}/extracted.md`, "# residue from the crashed delivery"],
      [`index/deleted/${a.id}`, ""],
    ]);
    const env = envWith(bucket);
    const deleteByIds = (env.READINGS_INDEX as unknown as { deleteByIds: ReturnType<typeof vi.fn> })
      .deleteByIds;

    await expect(processReading(a, env, services(), founderTenant())).resolves.toBeUndefined();

    expect(deleteByIds).toHaveBeenCalledWith([a.id]);
    const items = JSON.parse(store.get("index/list.json") ?? '{"items":[]}').items as Array<{
      id: string;
    }>;
    expect(items.some((item) => item.id === a.id)).toBe(false);
    expect(store.has(`index/by-url/${a.urlHash}`)).toBe(false);
    expect([...store.keys()].some((key) => key.startsWith(`${a.keyPrefix}/`))).toBe(false);
  });

  it("leaves a by-url pointer already claimed by a different reading alone", async () => {
    const a = args();
    const { store, bucket } = memoryBucket([
      // A later submit of the same URL already owns the slot with a new id.
      [`index/by-url/${a.urlHash}`, JSON.stringify({ id: "rd_NEWOWNER1", key_prefix: "readings/2026/09/10T000000Z-rd_NEWOWNER1" })],
      [`index/deleted/${a.id}`, ""],
    ]);

    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();

    expect(JSON.parse(store.get(`index/by-url/${a.urlHash}`)!).id).toBe("rd_NEWOWNER1");
  });

  it("propagates a failed vector-delete submission for retry and does not stamp delete_submitted (#357 P1b)", async () => {
    // A delete_submitted row for a delete that was never submitted is
    // invisible to the wipe's re-submit pass (it selects `live` rows only),
    // so a swallowed rejection would leave the vector permanently searchable.
    // The stamp must follow a successful submission — purgeReading's own rule
    // — and the failure must fail the delivery so the queue retries.
    const a = args();
    const { store, bucket } = memoryBucket([
      [`${a.keyPrefix}/extracted.md`, "# residue"],
      [`index/deleted/${a.id}`, ""],
    ]);
    const env = envWith(bucket);
    const deleteByIds = vi.fn(async () => {
      throw new Error("vectorize unavailable");
    });
    (env.READINGS_INDEX as unknown as { deleteByIds: unknown }).deleteByIds = deleteByIds;
    const ledgerRuns: string[] = [];
    (env as { CONTROL_PLANE?: unknown }).CONTROL_PLANE = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => {
            ledgerRuns.push(sql);
            return { meta: { changes: 1 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async () => [],
    };

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processReading(a, env, services(), founderTenant())).rejects.toThrow(
      "vectorize unavailable",
    );
    consoleErr.mockRestore();

    expect(deleteByIds).toHaveBeenCalled();
    expect(ledgerRuns.some((sql) => sql.includes("vector_ledger"))).toBe(false);
    // The R2 half of the recovery still ran before the rethrow: a delivery
    // that cannot reach Vectorize should not also strand reapable residue.
    expect([...store.keys()].some((key) => key.startsWith(`${a.keyPrefix}/`))).toBe(false);
  });

  it("stamps delete_submitted after a successful vector-delete submission", async () => {
    const a = args();
    const { bucket } = memoryBucket([[`index/deleted/${a.id}`, ""]]);
    const env = envWith(bucket);
    const ledgerRuns: string[] = [];
    (env as { CONTROL_PLANE?: unknown }).CONTROL_PLANE = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => {
            ledgerRuns.push(sql);
            return { meta: { changes: 1 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async () => [],
    };

    await expect(processReading(a, env, services(), founderTenant())).resolves.toBeUndefined();

    expect(ledgerRuns.some((sql) => sql.includes("'delete_submitted'"))).toBe(true);
  });

  it("sweeps prior residue when readingWasPurged sees a confirmed tombstone", async () => {
    const a = args();
    const { store, bucket } = memoryBucket([
      [`${a.keyPrefix}/extracted.md`, "# leftover from a crashed delivery"],
      [
        `${a.keyPrefix}/attempts/at_old.json`,
        JSON.stringify({
          id: "at_old",
          trigger: "submit",
          status: "running",
          started_at: a.createdAt,
          reading_id: a.id,
          url: a.url,
          url_hash: a.urlHash,
          key_prefix: a.keyPrefix,
          events: [],
        }),
      ],
      [`index/deleted/${a.id}`, ""],
    ]);

    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();

    expect([...store.keys()].some((key) => key.startsWith(`${a.keyPrefix}/`))).toBe(false);
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.some(([key]) => String(key).includes("/attempts/"))).toBe(false);
  });

  it("sweeps after a confirmed tombstone even if a later HEAD would throw", async () => {
    const a = args();
    const tombstoneKey = `index/deleted/${a.id}`;
    let tombstoneHeads = 0;
    const { store, bucket } = memoryBucket(
      [
        [`${a.keyPrefix}/extracted.md`, "# leftover from a crashed delivery"],
        [
          `${a.keyPrefix}/attempts/at_old.json`,
          JSON.stringify({
            id: "at_old",
            trigger: "submit",
            status: "running",
            started_at: a.createdAt,
            reading_id: a.id,
            url: a.url,
            url_hash: a.urlHash,
            key_prefix: a.keyPrefix,
            events: [],
          }),
        ],
      ],
      {
        head: async (key, store) => {
          if (key !== tombstoneKey) return store.has(key) ? { key } : null;
          tombstoneHeads += 1;
          if (tombstoneHeads === 1) return { key };
          throw new Error("R2 hiccup");
        },
      },
    );

    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();

    expect(tombstoneHeads).toBe(1);
    expect([...store.keys()].some((key) => key.startsWith(`${a.keyPrefix}/`))).toBe(false);
  });

  it("sweeps this delivery's attempt residue when canWrite is false after writeAttemptSafe", async () => {
    const a = args();
    const tombstoneKey = `index/deleted/${a.id}`;
    let tombstoneHeads = 0;
    const { store, bucket } = memoryBucket([[`${a.keyPrefix}/manifest.json`, pendingBody()]], {
      head: async (key, store) => {
        if (key !== tombstoneKey) return store.has(key) ? { key } : null;
        tombstoneHeads += 1;
        return tombstoneHeads > 1 ? { key } : null;
      },
      onPut: (key, store) => {
        if (key.includes("/attempts/")) store.delete(`${a.keyPrefix}/manifest.json`);
      },
    });

    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();

    expect(tombstoneHeads).toBeGreaterThan(1);
    expect([...store.keys()].some((key) => key.startsWith(`${a.keyPrefix}/`))).toBe(false);
  });

  it("does not sweep when canWrite is false without a tombstone (foreign attempt)", async () => {
    const a = args();
    const { store, bucket } = memoryBucket([
      [
        `${a.keyPrefix}/manifest.json`,
        JSON.stringify({
          ...JSON.parse(pendingBody()),
          active_attempt: {
            id: "at_OTHER",
            trigger: "submit",
            status: "running",
            started_at: a.createdAt,
          },
        }),
      ],
      [`${a.keyPrefix}/extracted.md`, "# owned by the other attempt"],
    ]);

    await expect(processReading(a, envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();

    expect(store.get(`${a.keyPrefix}/extracted.md`)).toBe("# owned by the other attempt");
    expect(store.has(`${a.keyPrefix}/manifest.json`)).toBe(true);
  });
});
