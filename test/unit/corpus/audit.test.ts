import { describe, expect, it } from "vitest";
import { buildFailedRows, buildPendingRows, tallyByIds, tallyStatuses } from "../../../scripts/corpus-lib/audit";
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
});

describe("tallyStatuses / tallyByIds", () => {
  it("counts by status and by id set", () => {
    const items = [item({ status: "ready" }), item({ status: "failed" }), item({ status: "pending" })];
    expect(tallyStatuses(items)).toEqual({ ready: 1, pending: 1, failed: 1, other: 0 });
    const byIds = tallyByIds([item({ id: "a", status: "ready" }), item({ id: "b", status: "pending" })], ["a", "b", "missing"]);
    expect(byIds).toEqual({ ready: 1, pending: 1, failed: 0, absent: 1 });
  });
});
