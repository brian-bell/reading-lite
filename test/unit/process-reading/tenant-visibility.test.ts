import { describe, expect, it, vi } from "vitest";
import { processReading } from "../../../src/process-reading";
import { RateLimitedError } from "../../../src/modules/http-retry";
import type { Env } from "../../../src/index";
import type { Services } from "../../../src/services";
import { founderTenant } from "../../helpers/tenant-fixtures";

function args() {
  return {
    id: "rd_TEST",
    url: "https://example.com/x",
    urlHash: "a".repeat(64),
    createdAt: "2026-04-26T20:00:00.000Z",
    keyPrefix: "readings/2026/04/26T200000Z-rd_TEST",
  };
}

function pendingManifestJson(): string {
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

function workingBucket() {
  const store = new Map<string, string>([
    [`${args().keyPrefix}/manifest.json`, pendingManifestJson()],
  ]);
  return {
    store,
    bucket: {
      get: vi.fn(async (key: string) => {
        const body = store.get(key);
        if (body === undefined) return null;
        return { text: async () => body, json: async () => JSON.parse(body), etag: "e1" };
      }),
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, String(value));
      }),
      head: vi.fn(async () => null),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket,
  };
}

function statusPlane(result: { status: string } | null | "throw"): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (result === "throw") throw new Error("D1 hiccup");
          if (/SELECT\s+status\s+FROM\s+users/i.test(sql)) return result;
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
}

function envWith(bucket: R2Bucket, controlPlane?: D1Database): Env {
  return {
    READINGS_BUCKET: bucket,
    READINGS_INDEX: {
      upsert: vi.fn(),
      query: vi.fn(),
    } as unknown as VectorizeIndex,
    READER_API_TOKEN: "x",
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    FETCH_TIMEOUT_MS: "20000",
    FETCH_MAX_BYTES: "10485760",
    CORS_ALLOWED_ORIGINS: "",
    PENDING_TTL_SECONDS: "300",
    ...(controlPlane ? { CONTROL_PLANE: controlPlane } : {}),
  } as unknown as Env;
}

function services(fetchFn: typeof fetch): Services {
  return {
    fetch: fetchFn,
    now: () => "2026-04-26T20:00:01.000Z",
    newId: () => "rd_TEST",
  };
}

function lastManifest(bucket: R2Bucket): { status: string } | null {
  const puts = (bucket.put as ReturnType<typeof vi.fn>).mock.calls;
  const manifestPut = puts
    .filter(([key]) => typeof key === "string" && key.endsWith("/manifest.json"))
    .at(-1);
  if (!manifestPut) return null;
  return JSON.parse(String(manifestPut[1])) as { status: string };
}

describe("processReading — tenant deletion visibility fence", () => {
  it("retries when the initial tenant-status lookup throws", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { bucket } = workingBucket();

    try {
      await processReading(args(), envWith(bucket, statusPlane("throw")), services(fetchFn), founderTenant());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).status).toBe(503);
      expect((error as RateLimitedError).url).toBe("d1://control-plane/users.status");
      expect((error as RateLimitedError).retryAfterMs).toBeNull();
    }

    expect(fetchFn).not.toHaveBeenCalled();
    expect(lastManifest(bucket)).toBeNull();
  });

  it("skips spend when the tenant is confirmed deleting", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { bucket, store } = workingBucket();

    await expect(
      processReading(
        args(),
        envWith(bucket, statusPlane({ status: "deleting" })),
        services(fetchFn),
        founderTenant(),
      ),
    ).resolves.toBeUndefined();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(lastManifest(bucket)).toBeNull();
    expect(JSON.parse(store.get(`${args().keyPrefix}/manifest.json`)!).status).toBe("pending");
  });

  it("skips spend when the user row is confirmed missing", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { bucket } = workingBucket();

    await expect(
      processReading(args(), envWith(bucket, statusPlane(null)), services(fetchFn), founderTenant()),
    ).resolves.toBeUndefined();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(lastManifest(bucket)).toBeNull();
  });
});
