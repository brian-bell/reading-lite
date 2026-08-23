import path from "node:path";
import { describe, expect, it } from "vitest";
import { corpusAuditCommand, type CorpusAuditDeps } from "../../../scripts/ops-lib/commands/corpus-audit";
import type { CommandIo } from "../../../scripts/ops-lib/contract";
import type { ListItem } from "../../../scripts/corpus-lib/types";

const NOW = Date.parse("2026-08-22T12:00:00Z");

const ITEMS: ListItem[] = [
  {
    id: "rd_ready", url: "https://example.com/ok", status: "ready",
    created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_ready",
  },
  {
    id: "rd_failed", url: "https://example.com/broken", status: "failed",
    created_at: "2026-08-02T00:00:00Z", key_prefix: "readings/rd_failed",
    error: { code: "fetch_failed", stage: "fetch", message: "403" },
  },
  {
    id: "rd_pending", url: "https://example.com/slow", status: "pending",
    created_at: "2026-08-10T00:00:00Z", updated_at: "2026-08-10T00:00:00Z",
    key_prefix: "readings/rd_pending",
    active_attempt: { stage: "summarize", trigger: "submit", status: "running" },
  },
];

function makeDeps(items: ListItem[] = ITEMS): {
  deps: CorpusAuditDeps;
  out: string[];
  writes: { path: string; body: string }[];
  mkdirs: string[];
  listReads: { bucket: string; remote?: boolean }[];
} {
  const out: string[] = [];
  const writes: { path: string; body: string }[] = [];
  const mkdirs: string[] = [];
  const listReads: { bucket: string; remote?: boolean }[] = [];
  const io: CommandIo = { stdout: (t) => out.push(t), stderr: (t) => out.push(t) };
  const deps: CorpusAuditDeps = {
    io,
    r2: {
      readListIndex: async (d) => {
        listReads.push({ bucket: d.bucket, remote: d.remote });
        return items;
      },
      readExtracted: async () => null,
      readManifest: async () => null,
      readAttempt: async () => null,
    },
    mkdir: async (dir) => {
      mkdirs.push(dir);
    },
    writeFile: async (filePath, body) => {
      writes.push({ path: filePath, body });
    },
    now: () => NOW,
  };
  return { deps, out, writes, mkdirs, listReads };
}

describe("ops corpus audit", () => {
  it("fails closed without --tenant", async () => {
    const { deps, writes, listReads } = makeDeps();
    await expect(corpusAuditCommand.run(["--out", "reports"], deps)).rejects.toThrow(
      /--tenant is required/,
    );
    expect(listReads).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("plan mode reads and classifies but writes no report files", async () => {
    const { deps, out, writes, mkdirs } = makeDeps();
    const code = await corpusAuditCommand.run(["--tenant", "global", "--out", "reports"], deps);
    expect(code).toBe(0);
    expect(writes).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
    const text = out.join("\n");
    expect(text).toContain("would write");
    expect(text).toContain(path.resolve("reports", "index.json"));
    expect(text).toContain(path.resolve("reports", "INDEX.md"));
    expect(text).toContain("--execute");
    // The plan still reports accurate classification counts.
    expect(text).toContain('"failed": 1');
    expect(text).toContain('"pending_stranded": 1');
  });

  it("--execute writes index.json and INDEX.md through the audit library", async () => {
    const { deps, writes, mkdirs } = makeDeps();
    const code = await corpusAuditCommand.run(["--tenant", "global", "--out", "reports", "--execute"], deps);
    expect(code).toBe(0);
    expect(mkdirs).toEqual([path.resolve("reports")]);
    expect(writes.map((w) => w.path)).toEqual([
      path.resolve("reports", "index.json"),
      path.resolve("reports", "INDEX.md"),
    ]);
    const json = JSON.parse(writes[0].body);
    expect(json.totals).toEqual({ ready: 1, pending: 1, failed: 1, other: 0 });
    expect(json.rows.map((r: { reading_id: string }) => r.reading_id)).toEqual(
      expect.arrayContaining(["rd_failed", "rd_pending"]),
    );
    expect(writes[1].body).toContain("rd_failed");
    // The report's remediation guidance must name the unified command — the
    // standalone corpus-drop interface no longer exists.
    expect(writes[1].body).toContain("npm run ops -- corpus drop --tenant global <url> --execute");
    expect(writes[1].body).not.toMatch(/`corpus-drop/);
  });

  it("targets the requested bucket and honors --local", async () => {
    const { deps, listReads } = makeDeps();
    await corpusAuditCommand.run(["--tenant", "global", "--bucket", "reading-lite-staging", "--local"], deps);
    expect(listReads).toEqual([{ bucket: "reading-lite-staging", remote: false }]);
  });

  it("rejects an unknown option before reading anything", async () => {
    const { deps, listReads } = makeDeps();
    await expect(corpusAuditCommand.run(["--tenant", "global", "--nope"], deps)).rejects.toThrowError(
      expect.objectContaining({ name: "Error", message: expect.stringContaining("--nope") }),
    );
    expect(listReads).toHaveLength(0);
  });

  it("is registered as plan-first under the corpus group", () => {
    expect(corpusAuditCommand.group).toBe("corpus");
    expect(corpusAuditCommand.name).toBe("audit");
    expect(corpusAuditCommand.safety).toBe("plan-first");
  });
});
