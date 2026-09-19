import { describe, expect, it, vi } from "vitest";
import {
  extractedFromMarkdown,
  processReading,
  sourceDateForReadyDraft,
  sourceDateFromPrior,
} from "../../../src/process-reading";
import type { Env } from "../../../src/index";
import type { Services } from "../../../src/services";
import type { Manifest } from "../../../src/schemas/manifest";
import { PgReadingStore } from "../../../src/modules/stores/postgres/reading-store";
import { memoryBucket, NODE_HYPERDRIVE, nodeReadingsFor } from "../../helpers/node-readings";
import { founderTenant, PUBLIC_LOOKUP } from "../../helpers/tenant-fixtures";

const PREFIX = "readings/2026/04/26T200000Z-rd_TEST";

function reader(readManifest: () => Promise<Manifest | null>) {
  return { readManifest: async () => readManifest() };
}

function pending(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_TEST",
    url: "https://example.com/x",
    url_hash: "a".repeat(64),
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-26T20:00:00.000Z",
    updated_at: "2026-04-26T20:00:00.000Z",
    ...over,
  };
}

describe("sourceDateFromPrior", () => {
  it("carries a date from the reading's row and omits it when none is stored", async () => {
    await expect(sourceDateFromPrior(reader(async () => pending({ source_date: "2024-03-15" })))).resolves.toBe("2024-03-15");
    await expect(sourceDateFromPrior(reader(async () => pending()))).resolves.toBeUndefined();
    await expect(sourceDateFromPrior(reader(async () => null))).resolves.toBeUndefined();
  });

  // A published reading stays ready through a reprocess, so its row still
  // holds the date: there is no snapshot to fall back on, or need for one.
  it("reads a published reading's date while it reprocesses", async () => {
    await expect(
      sourceDateFromPrior(reader(async () => pending({ status: "ready", connections: [], source_date: "2024-03-15" }))),
    ).resolves.toBe("2024-03-15");
  });

  it("proceeds undated on a read error", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sourceDateFromPrior(reader(async () => {
        throw new Error("database hiccup");
      })),
    ).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe("sourceDateForReadyDraft", () => {
  it.each([
    {
      name: "fresh-wins",
      extracted: { source_date: "2024-06-01" },
      stored: "2020-01-01",
      want: "2024-06-01",
    },
    {
      name: "prior-fills-gap",
      extracted: {},
      stored: "2020-01-01",
      want: "2020-01-01",
    },
    {
      name: "neither-present",
      extracted: {},
      stored: undefined,
      want: undefined,
    },
  ])("$name", async ({ extracted, stored, want }) => {
    await expect(
      sourceDateForReadyDraft(
        extracted,
        reader(async () => pending(stored === undefined ? {} : { source_date: stored })),
      ),
    ).resolves.toBe(want);
  });

  it("fresh-wins skips the prior-manifest read", async () => {
    await expect(
      sourceDateForReadyDraft(
        { source_date: "2024-06-01" },
        reader(async () => {
          throw new Error("database hiccup");
        }),
      ),
    ).resolves.toBe("2024-06-01");
  });
});

const MARKDOWN_NOW = Date.parse("2026-09-18T12:00:00.000Z");

describe("extractedFromMarkdown — source_date from front-matter", () => {
  it("sets source_date when front-matter supplies a date", async () => {
    const out = await extractedFromMarkdown(
      {
        kind: "markdown",
        markdown: "---\nsource_date: 2024-03-15\n---\n# Title\n\nbody",
      },
      MARKDOWN_NOW,
    );
    expect(out.source_date).toBe("2024-03-15");
    expect(out.markdown).toContain("source_date: 2024-03-15");
  });

  it("omits source_date when front-matter is absent", async () => {
    const out = await extractedFromMarkdown(
      { kind: "markdown", markdown: "# Title\n\nbody" },
      MARKDOWN_NOW,
    );
    expect("source_date" in out).toBe(false);
  });

  it("omits source_date when the front-matter value is implausible, without failing", async () => {
    const out = await extractedFromMarkdown(
      {
        kind: "markdown",
        markdown: "---\nsource_date: yesterday\n---\n# Title\n\nbody",
      },
      MARKDOWN_NOW,
    );
    expect(out.content_status).toBe("captured");
    expect("source_date" in out).toBe(false);
  });
});

describe("processReading — source_date is resolved before paid stages", () => {
  const identity = {
    id: "rd_TEST",
    url: "https://example.com/x",
    urlHash: "a".repeat(64),
    createdAt: "2026-04-26T20:00:00.000Z",
    keyPrefix: PREFIX,
  };

  function markdownJob() {
    return { ...identity, source: { kind: "markdown" as const, markdown: "# Title\n\nbody" } };
  }

  function envWith(bucket: R2Bucket): Env {
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
    } as unknown as Env;
  }

  // A pending row, and a bucket that reports when the extracted content lands:
  // every read of the reading after that point is one the pipeline makes
  // between extraction and its terminal write.
  async function seeded(over: Partial<Manifest>) {
    const state = { extractedWritten: false };
    const bucket = memoryBucket();
    const put = bucket.put.bind(bucket);
    bucket.put = (async (key: string, ...rest: unknown[]) => {
      if (key.endsWith("/extracted.md")) state.extractedWritten = true;
      return (put as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as typeof bucket.put;
    const readings = nodeReadingsFor(founderTenant(), bucket);
    await readings.seed(pending(over), { keyPrefix: PREFIX });
    return { bucket, readings, state };
  }

  // Counts the pipeline's reads of the reading once extraction has landed, and
  // lets a test answer one of them differently.
  function interceptReadsAfterExtract(
    state: { extractedWritten: boolean },
    answer: (nth: number, real: Awaited<ReturnType<PgReadingStore["loadReadingById"]>>) => Awaited<ReturnType<PgReadingStore["loadReadingById"]>>,
  ) {
    const real = PgReadingStore.prototype.loadReadingById;
    let reads = 0;
    const spy = vi.spyOn(PgReadingStore.prototype, "loadReadingById").mockImplementation(async function (this: PgReadingStore, id) {
      const found = await real.call(this, id);
      if (!state.extractedWritten) return found;
      reads += 1;
      return answer(reads, found);
    });
    return { spy, reads: () => reads };
  }

  it("a failed reprocess of a dated pending keeps source_date", async () => {
    const { bucket, readings } = await seeded({ source_date: "2024-03-15" });
    const services: Services = {
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      lookup: PUBLIC_LOOKUP,
      now: () => "2026-04-26T20:00:01.000Z",
      newId: () => "rd_TEST",
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(
        { ...identity, trigger: "reprocess" as const },
        envWith(bucket),
        services,
        founderTenant(),
      ),
    ).resolves.toBeUndefined();

    consoleErr.mockRestore();
    expect(await readings.manifest("rd_TEST")).toMatchObject({ status: "failed", source_date: "2024-03-15" });
  });

  it("a later failure keeps a date already resolved when the prior re-read would drop it", async () => {
    const { bucket, readings, state } = await seeded({ source_date: "2024-03-15" });
    // 1: unpaid ownership re-check after extract writes.
    // 2: sourceDateForReadyDraft — this is the date the attempt holds.
    // Later reads (markFailed) see an undated reading, so a re-read would drop
    // the field; the hoisted value must still land.
    const { spy } = interceptReadsAfterExtract(state, (nth, found) =>
      nth > 2 && found ? { ...found, manifest: { ...found.manifest, source_date: undefined } } : found,
    );
    const services: Services = {
      fetch: vi.fn<typeof fetch>(),
      lookup: PUBLIC_LOOKUP,
      now: () => "2026-04-26T20:00:01.000Z",
      newId: () => "rd_TEST",
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(
        {
          ...markdownJob(),
          attemptStartedAt: "2026-04-25T19:00:00.000Z",
        },
        envWith(bucket),
        services,
        founderTenant(),
      ),
    ).resolves.toBeUndefined();

    consoleErr.mockRestore();
    spy.mockRestore();
    expect(state.extractedWritten).toBe(true);
    expect(await readings.manifest("rd_TEST")).toMatchObject({ status: "failed", source_date: "2024-03-15" });
  });

  it("a post-extract prior read throw proceeds undated without marking failed", async () => {
    const { bucket, readings, state } = await seeded({ source_date: "2024-03-15" });
    // 1: unpaid ownership re-check after extract writes.
    // 2: sourceDateForReadyDraft → sourceDateFromPrior, hoisted before leases/paid stages.
    const { spy, reads } = interceptReadsAfterExtract(state, (nth, found) => {
      if (nth === 2) throw new Error("database hiccup");
      return found;
    });
    const fetchFn = vi.fn<typeof fetch>();
    const services: Services = {
      fetch: fetchFn,
      lookup: PUBLIC_LOOKUP,
      now: () => "2026-04-26T20:00:01.000Z",
      newId: () => "rd_TEST",
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(markdownJob(), envWith(bucket), services, founderTenant()),
    ).rejects.toThrow("defer_paid_work");

    spy.mockRestore();
    expect(state.extractedWritten).toBe(true);
    expect(reads()).toBeGreaterThan(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await readings.manifest("rd_TEST"))?.status).toBe("pending");
    expect(String(consoleErr.mock.calls[0]?.[0])).toMatch(/database hiccup/);
    consoleErr.mockRestore();
  });
});
