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

function envWith(bucket: R2Bucket): Env {
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
  } as unknown as Env;
}

function services(): Services {
  return {
    fetch: vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch,
    now: () => "2026-04-26T20:00:01.000Z",
    newId: () => "rd_TEST",
  };
}

describe("processReading — markFailed is defensive against R2 outages", () => {
  it("does not propagate when writeManifest in markFailed throws", async () => {
    // Extractor throws (services.fetch fails) → markFailed runs → writeManifest
    // throws on a totally broken bucket. processReading must swallow + log;
    // the request already returned 202 and there's nothing for the caller to
    // do with a thrown promise from waitUntil.
    const bucket = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {
        throw new Error("R2 outage");
      }),
      head: vi.fn(),
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
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string) => {
        if (key === "index/list.json") throw new Error("R2 partial outage");
      }),
      head: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processReading(args(), envWith(bucket), services(), founderTenant())).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
