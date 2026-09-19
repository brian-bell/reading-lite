import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processReading } from "../../../src/process-reading";
import type { Env } from "../../../src/index";
import type { Services } from "../../../src/services";
import { memoryBucket, NODE_HYPERDRIVE, nodeReadingsFor } from "../../helpers/node-readings";
import { founderTenant, PUBLIC_LOOKUP } from "../../helpers/tenant-fixtures";
import { interceptSql, TENANT_STATUS_LOOKUP } from "../../helpers/sql-faults";

// The consumer checks its tenant is active before it spends; this file's
// tenant has no users row in the shared Node database, so the lookup is answered.
beforeEach(() => {
  interceptSql(TENANT_STATUS_LOOKUP, () => [{ status: "active" }]);
});
afterEach(() => vi.restoreAllMocks());

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
    HYPERDRIVE: NODE_HYPERDRIVE,
    READER_API_TOKEN: "x",
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    FETCH_TIMEOUT_MS: "20000",
    FETCH_MAX_BYTES: "10485760",
    CORS_ALLOWED_ORIGINS: "",
    PENDING_TTL_SECONDS: "300",
    ...overrides,
  } as unknown as Env;
}

// Intake always commits the pending reading before enqueueing, and the
// consumer refuses to write anything for a reading with no row (the purge
// fence) — so the realistic queue-consumer state this test needs is a pending
// row.
async function seedPending(bucket: R2Bucket) {
  const a = args();
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
  return readings;
}

describe("processReading — config preflight", () => {
  it.each<{ name: string; overrides: Record<string, string>; message: RegExp }>([
    {
      name: "an invalid OpenAI reasoning effort",
      overrides: { SUMMARIZER_PROVIDER: "openai", OPENAI_SUMMARIZATION_REASONING_EFFORT: "extreme" },
      message: /invalid OPENAI_SUMMARIZATION_REASONING_EFFORT/,
    },
    {
      name: "an invalid Anthropic effort",
      overrides: { SUMMARIZER_PROVIDER: "anthropic", ANTHROPIC_SUMMARIZATION_REASONING_EFFORT: "none" },
      message: /invalid ANTHROPIC_SUMMARIZATION_REASONING_EFFORT/,
    },
  ])("rejects $name before fetching or embedding", async ({ overrides, message }) => {
    const fetchFn = vi.fn<typeof fetch>();
    const services: Services = {
      fetch: fetchFn,
      lookup: PUBLIC_LOOKUP,
      now: () => "2026-04-26T20:00:01.000Z",
      newId: () => "rd_TEST",
    };
    const bucket = memoryBucket();
    const readings = await seedPending(bucket);

    await processReading(args(), envWith(bucket, overrides), services, founderTenant());

    // The seam rejects before any upstream spend: no source fetch, no embed.
    expect(fetchFn).not.toHaveBeenCalled();
    const manifest = await readings.manifest("rd_TEST");
    expect(manifest?.status).toBe("failed");
    expect(manifest?.error?.message).toMatch(message);
  });
});
