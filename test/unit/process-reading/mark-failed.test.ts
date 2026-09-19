import { env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttemptIo } from "../../../src/attempt-io";
import { processReading } from "../../../src/process-reading";
import type { Env } from "../../../src/index";
import { PgReadingWriter } from "../../../src/modules/stores/postgres/reading-writer";
import type { Manifest } from "../../../src/schemas/manifest";
import type { Services } from "../../../src/services";
import { insertActiveUser } from "../../helpers/control-plane-db";
import { axisVector, mintTenant } from "../../helpers/pg-fixtures";
import { PUBLIC_LOOKUP } from "../../helpers/tenant-fixtures";
import { testReadingsFor, type TestReadings } from "../../helpers/test-readings";

const ID = "rd_TEST";
const KEY_PREFIX = "readings/2026/04/26T200000Z-rd_TEST";
// No attemptId on the message, so the attempt is `at_${id}`.
const ATTEMPT_ID = "at_rd_TEST";
const OWN_PREFIX = `${KEY_PREFIX}/revisions/${ATTEMPT_ID}`;

function args() {
  return {
    id: ID,
    url: "https://example.com/x",
    urlHash: "a".repeat(64),
    createdAt: "2026-04-26T20:00:00.000Z",
    keyPrefix: KEY_PREFIX,
  };
}

function env(): Env {
  return {
    READINGS_BUCKET: testEnv.READINGS_BUCKET,
    HYPERDRIVE: testEnv.HYPERDRIVE,
    TENANT_DATA_PLANE: "1",
    GLOBAL_USAGE_GUARD: testEnv.GLOBAL_USAGE_GUARD,
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

// The source fetch fails, so every attempt here ends in markFailed.
function services(onFetch: () => Promise<void> = async () => undefined): Services {
  return {
    fetch: vi.fn(async () => {
      await onFetch();
      throw new Error("network down");
    }) as unknown as typeof fetch,
    lookup: PUBLIC_LOOKUP,
    now: () => "2026-04-26T20:00:01.000Z",
    newId: () => ID,
  };
}

function pending(over: Partial<Manifest> = {}): Manifest {
  const a = args();
  return {
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
    ...over,
  };
}

// Intake always commits the pending reading before enqueueing, so that is the
// state a consumer finds. Each test gets its own tenant, an active user.
async function seeded(manifest: Manifest | null = pending()): Promise<TestReadings> {
  const readings = testReadingsFor(mintTenant());
  await insertActiveUser(testEnv, String(readings.tenant.tenantId));
  if (manifest) await readings.seed(manifest, { keyPrefix: KEY_PREFIX });
  return readings;
}

async function objectKeys(readings: TestReadings): Promise<string[]> {
  return (await readings.content.list(KEY_PREFIX)).map((object) => object.key.slice(object.key.indexOf(KEY_PREFIX)));
}

afterEach(() => vi.restoreAllMocks());

describe("processReading — markFailed is defensive against a database outage", () => {
  it("does not propagate when the failure write throws", async () => {
    // Extractor throws (services.fetch fails) → markFailed runs → its write
    // throws. processReading must swallow + log: the queue consumer acks either
    // way and there is nothing for a caller to do with a rejected promise.
    const readings = await seeded();
    vi.spyOn(PgReadingWriter.prototype, "fail").mockRejectedValue(new Error("database outage"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(processReading(args(), env(), services(), readings.tenant)).resolves.toBeUndefined();

    expect(consoleErr.mock.calls.some(([first]) => String(first).includes("database outage"))).toBe(true);
    // The TTL annotator flips a stale pending reading; nothing else is lost.
    expect((await readings.manifest(ID))?.status).toBe("pending");
  });

  it("recreates nothing when the reading is purged mid-flight", async () => {
    const readings = await seeded();
    await readings.content.put(`${OWN_PREFIX}/raw.html`, "residue of a crashed delivery", "text/html");
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The purge lands while the attempt is fetching its source.
    await processReading(
      args(),
      env(),
      services(async () => {
        await readings.writer.purge(ID, () => false);
      }),
      readings.tenant,
    );

    expect(await readings.manifest(ID)).toBeNull();
    expect(await readings.ids()).toEqual([]);
    expect(await readings.sql.query("SELECT 1 FROM reading_attempts WHERE tenant_id = $1", [String(readings.tenant.tenantId)])).toEqual([]);
    // And what this attempt had captured is swept: nothing references it.
    expect(await objectKeys(readings)).toEqual([]);
  });
});

describe("processReading — content sweep on early return", () => {
  it("sweeps this attempt's residue when the reading was purged before the delivery", async () => {
    const readings = await seeded(null);
    await readings.content.put(`${OWN_PREFIX}/raw.html`, "residue", "text/html");
    await readings.content.put(`${OWN_PREFIX}/extracted.md`, "residue", "text/markdown");

    await processReading(args(), env(), services(), readings.tenant);

    expect(await objectKeys(readings)).toEqual([]);
    expect(await readings.ids()).toEqual([]);
  });

  it("sweeps only its own content when another attempt owns the reading", async () => {
    const foreign = { id: "at_FOREIGN", trigger: "reprocess" as const, status: "running" as const, started_at: "2026-04-26T20:00:00.500Z" };
    const readings = await seeded(pending({ active_attempt: foreign }));
    await readings.content.put(`${OWN_PREFIX}/raw.html`, "mine", "text/html");
    await readings.content.put(`${KEY_PREFIX}/revisions/at_FOREIGN/raw.html`, "theirs", "text/html");

    await processReading(args(), env(), services(), readings.tenant);

    expect(await objectKeys(readings)).toEqual([`${KEY_PREFIX}/revisions/at_FOREIGN/raw.html`]);
    expect((await readings.manifest(ID))?.active_attempt?.id).toBe("at_FOREIGN");
  });

  // The hazard the sweep must never trip: a message redelivered after its
  // attempt already published takes the same "may not write" exit, and that
  // attempt's revision prefix IS the published content.
  it("never sweeps the content of a revision this attempt already published", async () => {
    const readings = await seeded(null);
    const running = { id: ATTEMPT_ID, trigger: "submit" as const, status: "running" as const, started_at: "2026-04-26T20:00:00.000Z" };
    await readings.writer.claimUrl(pending({ active_attempt: running }), KEY_PREFIX, { summary: running, payload: args() });
    await readings.content.put(`${OWN_PREFIX}/raw.html`, "<p>published</p>", "text/html");
    await readings.content.put(`${OWN_PREFIX}/extracted.md`, "published", "text/markdown");
    const published = await readings.writer.publish(
      args(),
      pending({
        status: "ready",
        title: "Published",
        tldr: "Published",
        connections: [],
        summary_markdown: "## Summary",
        content_type: "text/html",
        last_attempt: { ...running, status: "succeeded", finished_at: "2026-04-26T20:00:01.000Z" },
      }),
      {
        keyPrefix: KEY_PREFIX,
        content: { rawKey: `${OWN_PREFIX}/raw.html`, extractedKey: `${OWN_PREFIX}/extracted.md` },
        embedding: axisVector(1),
        claimMissingUrl: true,
      },
    );
    expect(published).toEqual({ committed: true, published: true });

    // The queue redelivers the message (the consumer crashed before its ack).
    await processReading(args(), env(), services(), readings.tenant);

    expect((await readings.manifest(ID))?.status).toBe("ready");
    expect(await readings.extractedText(ID)).toBe("published");
    expect(await readings.rawText(ID)).toBe("<p>published</p>");
  });

  // The sweep is housekeeping. A transient error in it must not reach the
  // failure path, which would stamp the published attempt's last_attempt failed.
  it("leaves a published reading's attempt succeeded when the sweep throws on redelivery", async () => {
    const readings = await seeded(null);
    const running = { id: ATTEMPT_ID, trigger: "submit" as const, status: "running" as const, started_at: "2026-04-26T20:00:00.000Z" };
    await readings.writer.claimUrl(pending({ active_attempt: running }), KEY_PREFIX, { summary: running, payload: args() });
    const succeeded = { ...running, status: "succeeded" as const, finished_at: "2026-04-26T20:00:01.000Z" };
    await readings.writer.publish(
      args(),
      pending({ status: "ready", title: "Published", tldr: "Published", connections: [], summary_markdown: "## Summary", last_attempt: succeeded }),
      {
        keyPrefix: KEY_PREFIX,
        content: { rawKey: `${OWN_PREFIX}/raw.html`, extractedKey: `${OWN_PREFIX}/extracted.md` },
        embedding: axisVector(1),
        claimMissingUrl: true,
      },
    );
    vi.spyOn(AttemptIo.prototype, "discardUnreferencedContent").mockRejectedValue(new Error("R2 blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await processReading(args(), env(), services(), readings.tenant);

    expect(await readings.manifest(ID)).toMatchObject({ status: "ready", last_attempt: { id: ATTEMPT_ID, status: "succeeded" } });
  });
});
