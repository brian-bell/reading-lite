import { describe, expect, it, vi } from "vitest";
import { processReading } from "../../../src/process-reading";
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

function envWith(bucket: R2Bucket, overrides: Record<string, string>): Env {
  return {
    READINGS_BUCKET: bucket,
    READINGS_INDEX: {
      upsert: vi.fn(),
      query: vi.fn(),
    } as unknown as VectorizeIndex,
    READER_API_TOKEN: "x",
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    ANTHROPIC_MODEL: "claude-sonnet-4-6",
    FETCH_TIMEOUT_MS: "20000",
    FETCH_MAX_BYTES: "10485760",
    CORS_ALLOWED_ORIGINS: "",
    PENDING_TTL_SECONDS: "300",
    ...overrides,
  } as unknown as Env;
}

function workingBucket() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const body = store.get(key);
      if (body === undefined) return null;
      return { text: async () => body, json: async () => JSON.parse(body) };
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, String(value));
    }),
    head: vi.fn(async () => null),
    delete: vi.fn(),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
  } as unknown as R2Bucket;
}

describe("processReading — config preflight", () => {
  it("rejects an invalid OpenAI reasoning effort before fetching or embedding", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const services: Services = {
      fetch: fetchFn,
      now: () => "2026-04-26T20:00:01.000Z",
      newId: () => "rd_TEST",
    };

    const bucket = workingBucket();
    await processReading(
      args(),
      envWith(bucket, {
        SUMMARIZER_PROVIDER: "openai",
        OPENAI_SUMMARIZATION_REASONING_EFFORT: "extreme",
      }),
      services,
      founderTenant(),
    );

    // The seam rejects before any upstream spend: no source fetch, no embed.
    expect(fetchFn).not.toHaveBeenCalled();

    const puts = (bucket.put as ReturnType<typeof vi.fn>).mock.calls;
    const manifestPut = puts.filter(
      ([key]) => typeof key === "string" && key.endsWith("/manifest.json"),
    ).at(-1);
    expect(manifestPut).toBeDefined();
    const manifest = JSON.parse(String(manifestPut![1]));
    expect(manifest.status).toBe("failed");
    expect(manifest.error?.message).toMatch(
      /invalid OPENAI_SUMMARIZATION_REASONING_EFFORT/,
    );
  });
});
