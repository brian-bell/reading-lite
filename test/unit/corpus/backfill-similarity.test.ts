import { describe, expect, it } from "vitest";
import {
  planBackfill,
  snapshotFor,
  validateBackfillWrite,
  withSimilarity,
} from "../../../scripts/corpus-lib/backfill-similarity";

const AT = "2026-08-22T00:00:00.000Z";
const row = (o: Partial<{ id: string; status: string; key_prefix: string }> = {}) => ({
  id: "rd_a",
  url: "https://a.com",
  status: "ready",
  key_prefix: "readings/2026/x-rd_a",
  created_at: AT,
  ...o,
});

describe("planBackfill", () => {
  it("selects ready readings", () => {
    const plan = planBackfill([row({ id: "rd_1" }), row({ id: "rd_2" })] as never);
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_1", "rd_2"]);
  });

  it("skips non-ready readings, which own no vector", () => {
    const plan = planBackfill([row({ id: "rd_ok" }), row({ id: "rd_bad", status: "failed" })] as never);
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_ok"]);
    expect(plan.skippedNotReady).toBe(1);
  });

  it("skips readings that already carry a score, so a run is resumable", () => {
    const items = [
      row({ id: "rd_done" }),
      row({ id: "rd_todo" }),
    ] as never as Record<string, unknown>[];
    (items[0] as Record<string, unknown>).similarity = { count: 2, computed_at: AT };
    const plan = planBackfill(items as never);
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_todo"]);
    expect(plan.alreadyScored).toBe(1);
  });

  it("can be limited to named ids", () => {
    const plan = planBackfill([row({ id: "rd_1" }), row({ id: "rd_2" })] as never, { only: ["rd_2"] });
    expect(plan.targets.map((t) => t.id)).toEqual(["rd_2"]);
  });
});

describe("snapshotFor", () => {
  it("excludes the reading's own vector, which scores ~1 against itself", () => {
    const s = snapshotFor("rd_a", [{ id: "rd_a", score: 0.999 }, { id: "rd_b", score: 0.6 }], AT);
    expect(s.count).toBe(1);
    expect(s.max).toBeCloseTo(0.6, 10);
  });

  it("records an unscored empty neighbourhood rather than inventing one", () => {
    expect(snapshotFor("rd_a", [{ id: "rd_a", score: 1 }], AT)).toEqual({ count: 0, computed_at: AT });
  });

  it("caps at the shared neighbourhood size even if more were fetched", () => {
    const matches = [{ id: "rd_a", score: 1 }].concat(
      Array.from({ length: 8 }, (_, i) => ({ id: `rd_${i}`, score: 0.9 - i / 100 })),
    );
    expect(snapshotFor("rd_a", matches, AT).count).toBe(5);
  });
});

describe("withSimilarity", () => {
  const manifest = {
    id: "rd_a",
    title: "A title",
    tldr: "A tldr.",
    tags: ["x"],
    summary_markdown: "body",
    novelty_verdict: "familiar",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("sets the similarity field", () => {
    const out = withSimilarity(manifest, { count: 1, max: 0.6, mean: 0.6, computed_at: AT });
    expect(out.similarity).toEqual({ count: 1, max: 0.6, mean: 0.6, computed_at: AT });
  });

  it("changes NOTHING else -- a backfill must not re-roll the summary", () => {
    // A reprocess re-runs the summarizer and rewrites title and tags on
    // unchanged source text. This path must not: it only adds a measurement.
    const out = withSimilarity(manifest, { count: 0, computed_at: AT }) as Record<string, unknown>;
    const { similarity: _drop, ...rest } = out;
    expect(rest).toEqual(manifest);
  });

  it("leaves updated_at alone, since no content changed", () => {
    const out = withSimilarity(manifest, { count: 0, computed_at: AT });
    expect(out.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("overwrites a stale snapshot when rescoring", () => {
    const stale = { ...manifest, similarity: { count: 9, max: 0.99, computed_at: "2020-01-01T00:00:00.000Z" } };
    const out = withSimilarity(stale, { count: 1, max: 0.5, mean: 0.5, computed_at: AT });
    expect(out.similarity).toEqual({ count: 1, max: 0.5, mean: 0.5, computed_at: AT });
  });
});

describe("validateBackfillWrite", () => {
  const SNAP = { count: 1, max: 0.6, mean: 0.6, computed_at: AT };
  const valid = {
    id: "rd_a",
    url: "https://a.com/p",
    url_hash: "a".repeat(64),
    status: "ready",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  };

  it("accepts a manifest that parses once the score is merged in", () => {
    const out = validateBackfillWrite(valid, SNAP);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.manifest.similarity).toEqual(SNAP);
  });

  it("rejects unrelated schema drift instead of entrenching it", () => {
    const out = validateBackfillWrite({ ...valid, status: "not-a-status" }, SNAP);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/status/);
  });

  it("repairs a malformed existing similarity rather than failing forever", () => {
    // Validating the manifest as read would reject this on every run while
    // refusing the very fix that would make it valid: the write replaces the
    // offending field.
    const out = validateBackfillWrite({ ...valid, similarity: { count: "lots" } }, SNAP);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.manifest.similarity).toEqual(SNAP);
  });

  it("rejects a non-object", () => {
    expect(validateBackfillWrite(null, SNAP).ok).toBe(false);
    expect(validateBackfillWrite("nope", SNAP).ok).toBe(false);
  });

  it("preserves unknown stored fields, which ManifestSchema would strip", () => {
    const withExtra = { ...valid, some_future_field: { keep: "me" } };
    const out = validateBackfillWrite(withExtra, SNAP);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.manifest.some_future_field).toEqual({ keep: "me" });
  });
});
