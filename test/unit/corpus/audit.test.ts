import { describe, expect, it } from "vitest";
import {
  buildDegradedRows,
  buildFailedOrphanDupRows,
  buildFailedRows,
  buildPendingRows,
  tallyByIds,
  tallyStatuses,
} from "../../../scripts/corpus-lib/audit";
import type { ListItem } from "../../../scripts/corpus-lib/types";

const NOW = Date.parse("2026-06-18T00:00:00.000Z");
const item = (o: Partial<ListItem>): ListItem => ({
  id: "rd_x", url: "https://a.com/p", status: "pending",
  created_at: "2026-05-01T00:00:00.000Z", key_prefix: "readings/x", ...o,
});

describe("buildFailedRows", () => {
  it("dedupes by url, derives reason, counts attempts", () => {
    const rows = buildFailedRows([
      item({ id: "f1", url: "https://a.com/x", status: "failed", error: { code: "BadStatusError", message: "bad response status 403: u", stage: "fetch_source" } }),
      item({ id: "f1b", url: "https://a.com/x", status: "failed", created_at: "2026-06-10T00:00:00.000Z", error: { code: "BadStatusError", message: "bad response status 403: u", stage: "fetch_source" } }),
      item({ id: "f2", url: "https://b.com/y", status: "failed", error: { code: "OversizedResponseError", message: "", stage: "fetch_source" } }),
    ]);
    expect(rows).toHaveLength(2);
    const x = rows.find((r) => r.url === "https://a.com/x")!;
    expect(x.attempts).toBe(2);
    expect(x.reason).toMatch(/403/);
  });

  it("drops a failed url once a ready sibling exists (recovery drained it)", () => {
    const rows = buildFailedRows([
      item({ id: "f1", url: "https://a.com/x", status: "failed", error: { code: "BadStatusError", message: "status 403", stage: "fetch_source" } }),
      item({ id: "r1", url: "https://a.com/x", status: "ready" }),
      item({ id: "f2", url: "https://b.com/y", status: "failed", error: { code: "OversizedResponseError", message: "", stage: "fetch_source" } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://b.com/y");
  });
});

describe("buildFailedOrphanDupRows", () => {
  it("surfaces failed copies whose url already has a ready reading, deduped + counted", () => {
    const rows = buildFailedOrphanDupRows([
      item({ id: "f1", url: "https://a.com/x", status: "failed", error: { code: "BadStatusError", message: "status 403", stage: "fetch_source" } }),
      item({ id: "f1b", url: "https://a.com/x", status: "failed", created_at: "2026-06-10T00:00:00.000Z", error: { code: "BadStatusError", message: "status 403", stage: "fetch_source" } }),
      item({ id: "r1", url: "https://a.com/x", status: "ready" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://a.com/x");
    expect(rows[0].class).toBe("orphan-dup");
    expect(rows[0].category).toBe("failed");
    expect(rows[0].attempts).toBe(2);
  });

  it("ignores failed urls with no ready copy (those are real failures)", () => {
    const rows = buildFailedOrphanDupRows([
      item({ id: "f2", url: "https://b.com/y", status: "failed", error: { code: "OversizedResponseError", message: "", stage: "fetch_source" } }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("partitions cleanly against buildFailedRows for the same corpus", () => {
    const items = [
      item({ id: "f1", url: "https://a.com/x", status: "failed", error: { code: "BadStatusError", message: "status 403", stage: "fetch_source" } }),
      item({ id: "r1", url: "https://a.com/x", status: "ready" }),
      item({ id: "f2", url: "https://b.com/y", status: "failed", error: { code: "OversizedResponseError", message: "", stage: "fetch_source" } }),
    ];
    expect(buildFailedRows(items).map((r) => r.url)).toEqual(["https://b.com/y"]);
    expect(buildFailedOrphanDupRows(items).map((r) => r.url)).toEqual(["https://a.com/x"]);
  });
});

describe("buildPendingRows", () => {
  it("classifies stranded vs orphan-dup and computes age", () => {
    const rows = buildPendingRows([
      item({ id: "p1", url: "https://a.com/stranded", status: "pending", active_attempt: { stage: "queued", trigger: "submit" } }),
      item({ id: "p2", url: "https://a.com/dup", status: "pending" }),
      item({ id: "r2", url: "https://a.com/dup", status: "ready" }),
    ], NOW);
    expect(rows).toHaveLength(2);
    const s = rows.find((r) => r.url === "https://a.com/stranded")!;
    expect(s.class).toBe("stranded");
    expect(s.stuck_stage).toBe("queued");
    expect(s.age_days).toBe(48);
    expect(rows.find((r) => r.url === "https://a.com/dup")!.class).toBe("orphan-dup");
  });

  it("classifies a pending within the TTL as fresh, not stranded", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const old = new Date(NOW - 2 * 86_400_000).toISOString();
    const rows = buildPendingRows([
      item({ id: "p1", url: "https://a.com/fresh", status: "pending", created_at: fresh, active_attempt: { stage: "queued", trigger: "submit" } }),
      item({ id: "p2", url: "https://a.com/old", status: "pending", created_at: old }),
    ], NOW);
    expect(rows.find((r) => r.url === "https://a.com/fresh")!.class).toBe("fresh");
    expect(rows.find((r) => r.url === "https://a.com/old")!.class).toBe("stranded");
  });

  it("prefers updated_at over created_at for staleness", () => {
    const old = new Date(NOW - 2 * 86_400_000).toISOString();
    const recent = new Date(NOW - 60_000).toISOString();
    const rows = buildPendingRows([
      item({ id: "p1", url: "https://a.com/retrying", status: "pending", created_at: old, updated_at: recent }),
    ], NOW);
    expect(rows[0].class).toBe("fresh");
  });
});

describe("buildDegradedRows", () => {
  it("lists ready readings that recorded a YouTube enrichment miss", () => {
    const rows = buildDegradedRows([
      item({
        id: "rd_yt",
        url: "https://www.youtube.com/watch?v=abc",
        status: "ready",
        title: "Greeting World",
        enrichment_degradation: {
          source: "youtube",
          tier: "watch_page",
          code: "TooManyRedirectsError",
          message: "redirect chain exceeded 5 hops: https://www.youtube.com/watch",
        },
      }),
      item({ id: "rd_ok", url: "https://example.com/ok", status: "ready" }),
      item({
        id: "rd_failed",
        url: "https://www.youtube.com/watch?v=nope",
        status: "failed",
        enrichment_degradation: {
          source: "youtube",
          tier: "transcript",
          code: "OversizedResponseError",
          message: "oversized",
        },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "degraded",
      reading_id: "rd_yt",
      code: "TooManyRedirectsError",
      reason: "YouTube watch_page enrichment degraded — TooManyRedirectsError",
    });
  });
});

describe("tallyStatuses / tallyByIds", () => {
  it("counts by status and by id set", () => {
    const items = [item({ status: "ready" }), item({ status: "failed" }), item({ status: "pending" })];
    expect(tallyStatuses(items)).toEqual({ ready: 1, pending: 1, failed: 1, other: 0 });
    const byIds = tallyByIds([item({ id: "a", status: "ready" }), item({ id: "b", status: "pending" })], ["a", "b", "missing"]);
    expect(byIds).toEqual({ ready: 1, pending: 1, failed: 0, absent: 1 });
  });
});
