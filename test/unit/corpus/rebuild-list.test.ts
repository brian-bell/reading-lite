import { describe, expect, it } from "vitest";
import { enforceSoleWriter } from "../../../scripts/corpus-lib/sole-writer";
import { planListRebuild, rebuildWriteGuard } from "../../../scripts/corpus-lib/rebuild-list";
import type { Manifest } from "../../../src/schemas/manifest";

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_a",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "ready",
    title: "Do Not Sell the Whole Ticket at Once",
    tldr: "Small commitments rather than the whole project.",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 1,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("planListRebuild", () => {
  it("projects keywords from a keyworded manifest onto the rewritten index", () => {
    const plan = planListRebuild({
      currentItems: [{ id: "rd_a" }],
      rows: [
        {
          keyPrefix: "readings/2026/01/01T000000Z-rd_a",
          manifest: manifest({ keywords: ["soft skills", "sales"] }),
        },
      ],
      complete: true,
    });
    expect(plan.rebuiltCount).toBe(1);
    expect(plan.keywordGainCount).toBe(1);
    expect(plan.items[0]).toMatchObject({
      id: "rd_a",
      keywords: ["soft skills", "sales"],
    });
  });

  it("does not count a row that already had keywords as a gain", () => {
    const plan = planListRebuild({
      currentItems: [{ id: "rd_a", keywords: ["soft skills"] }],
      rows: [
        {
          keyPrefix: "readings/2026/01/01T000000Z-rd_a",
          manifest: manifest({ keywords: ["soft skills"] }),
        },
      ],
      complete: true,
    });
    expect(plan.keywordGainCount).toBe(0);
  });
});

describe("rebuildWriteGuard", () => {
  it("refuses --execute without --sole-writer", () => {
    const guard = rebuildWriteGuard({ execute: true, soleWriter: false, complete: true });
    expect(guard.action).toBe("refuse");
    expect(guard.reason).toMatch(/--sole-writer/);
  });

  it("refuses a truncated scan even when sole-writer is acknowledged", () => {
    const guard = rebuildWriteGuard({ execute: true, soleWriter: true, complete: false });
    expect(guard.action).toBe("refuse");
    expect(guard.reason).toMatch(/truncated/i);
  });

  it("allows a dry-run without sole-writer", () => {
    expect(rebuildWriteGuard({ execute: false, soleWriter: false, complete: true })).toEqual({
      action: "dry-run",
      reason: "",
    });
  });
});

describe("corpus-rebuild-list sole-writer glue", () => {
  it("refuses an --execute run that has not acknowledged sole-writer", () => {
    const write: string[] = [];
    let exitCode: number | undefined;
    enforceSoleWriter(
      { execute: true, acknowledged: false, tool: "corpus-rebuild-list" },
      { write: (s) => write.push(s), exit: (code) => { exitCode = code; } },
    );
    expect(write.join("")).toMatch(/corpus-rebuild-list/);
    expect(write.join("")).toMatch(/--sole-writer/);
    expect(exitCode).toBe(2);
  });
});
