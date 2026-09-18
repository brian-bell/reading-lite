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
import { founderTenant, PUBLIC_LOOKUP } from "../../helpers/tenant-fixtures";

const PREFIX = "readings/2026/04/26T200000Z-rd_TEST";

function args(over: { preserveReadyManifest?: Manifest } = {}) {
  return { keyPrefix: PREFIX, ...over };
}

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
  it("carries a date from the current pending and omits it when none is stored", async () => {
    await expect(
      sourceDateFromPrior(reader(async () => pending({ source_date: "2024-03-15" })), args()),
    ).resolves.toBe("2024-03-15");
    await expect(sourceDateFromPrior(reader(async () => pending()), args())).resolves.toBeUndefined();
    await expect(sourceDateFromPrior(reader(async () => null), args())).resolves.toBeUndefined();
  });

  it("prefers the current pending over a preserved ready snapshot", async () => {
    await expect(
      sourceDateFromPrior(
        reader(async () => pending({ source_date: "2024-03-15" })),
        args({ preserveReadyManifest: pending({ status: "ready", source_date: "2020-01-01" }) }),
      ),
    ).resolves.toBe("2024-03-15");
  });

  it("recovers a preserved date when the prior-manifest read throws", async () => {
    await expect(
      sourceDateFromPrior(reader(async () => {
        throw new Error("R2 hiccup");
      }), args({
        preserveReadyManifest: pending({ status: "ready", source_date: "2024-03-15" }),
      })),
    ).resolves.toBe("2024-03-15");
  });

  it("fails closed on a prior-manifest read error when no preserved date can recover it", async () => {
    const error = new Error("R2 hiccup");
    await expect(
      sourceDateFromPrior(reader(async () => {
        throw error;
      }), args()),
    ).rejects.toBe(error);

    await expect(
      sourceDateFromPrior(reader(async () => {
        throw error;
      }), args({ preserveReadyManifest: pending({ status: "ready" }) })),
    ).rejects.toBe(error);
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
        args(),
      ),
    ).resolves.toBe(want);
  });

  it("fresh-wins skips the prior-manifest read", async () => {
    await expect(
      sourceDateForReadyDraft(
        { source_date: "2024-06-01" },
        reader(async () => {
          throw new Error("R2 hiccup");
        }),
        args(),
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
  function job() {
    return {
      id: "rd_TEST",
      url: "https://example.com/x",
      urlHash: "a".repeat(64),
      createdAt: "2026-04-26T20:00:00.000Z",
      keyPrefix: PREFIX,
      source: { kind: "markdown" as const, markdown: "# Title\n\nbody" },
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
      ANTHROPIC_MODEL: "claude-sonnet-5",
      FETCH_TIMEOUT_MS: "20000",
      FETCH_MAX_BYTES: "10485760",
      CORS_ALLOWED_ORIGINS: "",
      PENDING_TTL_SECONDS: "300",
    } as unknown as Env;
  }

  it("a post-extract prior-manifest read throw fails closed without calling paid fetch", async () => {
    const body = JSON.stringify(pending({ source_date: "2024-03-15" }));
    let extractedWritten = false;
    let manifestGetsAfterExtract = 0;
    const bucket = {
      get: vi.fn(async (key: string) => {
        if (typeof key === "string" && key.endsWith("/manifest.json")) {
          if (extractedWritten) {
            manifestGetsAfterExtract += 1;
            // 1: unpaid ownership re-check after extract writes.
            // 2: sourceDateForReadyDraft → sourceDateFromPrior, hoisted before leases/paid stages.
            // Later gets (markFailed) must succeed so the consumer can finish.
            if (manifestGetsAfterExtract === 2) throw new Error("R2 hiccup");
          }
          return { text: async () => body, json: async () => JSON.parse(body), etag: "e1" };
        }
        return null;
      }),
      put: vi.fn(async (key: string, value: unknown) => {
        if (typeof key === "string" && key.endsWith("/extracted.md")) extractedWritten = true;
        void value;
      }),
      head: vi.fn(async () => null),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;

    const fetchFn = vi.fn<typeof fetch>();
    const services: Services = {
      fetch: fetchFn,
      lookup: PUBLIC_LOOKUP,
      now: () => "2026-04-26T20:00:01.000Z",
      newId: () => "rd_TEST",
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(job(), envWith(bucket), services, founderTenant()),
    ).resolves.toBeUndefined();

    expect(extractedWritten).toBe(true);
    expect(manifestGetsAfterExtract).toBeGreaterThan(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(String(consoleErr.mock.calls[0]?.[0])).toMatch(/R2 hiccup/);
    consoleErr.mockRestore();
  });
});
