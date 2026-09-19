import { describe, expect, it, vi } from "vitest";
import { processReading } from "../../../src/process-reading";
import { RateLimitedError } from "../../../src/modules/http-retry";
import type { Env } from "../../../src/index";
import type { Services } from "../../../src/services";
import { memoryBucket, NODE_HYPERDRIVE, nodeReadingsFor } from "../../helpers/node-readings";
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

// The state the consumer finds: intake committed a pending reading.
async function seedPending() {
  const a = args();
  const bucket = memoryBucket();
  const readings = nodeReadingsFor(founderTenant(), bucket);
  await readings.seed(
    {
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
    },
    { keyPrefix: a.keyPrefix },
  );
  return { bucket, readings };
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

function envWith(bucket: R2Bucket, controlPlane: D1Database): Env {
  return {
    READINGS_BUCKET: bucket,
    HYPERDRIVE: NODE_HYPERDRIVE,
    READER_API_TOKEN: "x",
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    FETCH_TIMEOUT_MS: "20000",
    FETCH_MAX_BYTES: "10485760",
    CORS_ALLOWED_ORIGINS: "",
    PENDING_TTL_SECONDS: "300",
    CONTROL_PLANE: controlPlane,
  } as unknown as Env;
}

function services(fetchFn: typeof fetch): Services {
  return {
    fetch: fetchFn,
    lookup: PUBLIC_LOOKUP,
    now: () => "2026-04-26T20:00:01.000Z",
    newId: () => "rd_TEST",
  };
}

describe("processReading — tenant deletion visibility fence", () => {
  it("retries when the initial tenant-status lookup throws", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { bucket, readings } = await seedPending();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await processReading(args(), envWith(bucket, statusPlane("throw")), services(fetchFn), founderTenant());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).status).toBe(503);
      expect((error as RateLimitedError).url).toBe("d1://control-plane/users.status");
      expect((error as RateLimitedError).retryAfterMs).toBeNull();
    }

    expect(consoleErr).toHaveBeenCalled();
    expect(String(consoleErr.mock.calls[0]?.[0])).toMatch(/D1 hiccup/);
    consoleErr.mockRestore();
    expect(fetchFn).not.toHaveBeenCalled();
    // Not failed: the queue retry can still do the work.
    expect((await readings.manifest("rd_TEST"))?.status).toBe("pending");
  });

  it.each([
    { name: "the tenant is confirmed deleting", row: { status: "deleting" } },
    { name: "the user row is confirmed missing", row: null },
  ])("skips spend and writes nothing when $name", async ({ row }) => {
    const fetchFn = vi.fn<typeof fetch>();
    const { bucket, readings } = await seedPending();
    const before = await readings.manifest("rd_TEST");

    await expect(
      processReading(args(), envWith(bucket, statusPlane(row)), services(fetchFn), founderTenant()),
    ).resolves.toBeUndefined();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await readings.manifest("rd_TEST")).toEqual(before);
    expect(await readings.writer.listAttempts("rd_TEST")).toEqual([]);
    expect((await bucket.list()).objects).toEqual([]);
  });
});
