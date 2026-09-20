import path from "node:path";
import { describe, expect, it } from "vitest";
import { corpusAuditCommand, type CorpusAuditDeps } from "../../../scripts/ops-lib/commands/corpus-audit";
import type { CommandIo } from "../../../scripts/ops-lib/contract";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { ListItem } from "../../../scripts/corpus-lib/types";
import type { CorpusInventory } from "../../../scripts/pg-lib/operator-corpus";
import type { ContentKeys } from "../../../src/modules/stores/postgres/reading-store";

const NOW = Date.parse("2026-08-22T12:00:00Z");
const TENANT = "usr_11111111-1111-4111-8111-111111111111";

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

interface Harness {
  deps: CorpusAuditDeps;
  out: string[];
  writes: { path: string; body: string }[];
  mkdirs: string[];
  opened: { databaseUrlEnv: string; tenant: string }[];
  objectReads: string[];
  stuckAsked: string[][];
}

function makeDeps(
  items: ListItem[] = ITEMS,
  overrides: Partial<CorpusInventory> = {},
): Harness {
  const out: string[] = [];
  const writes: { path: string; body: string }[] = [];
  const mkdirs: string[] = [];
  const opened: { databaseUrlEnv: string; tenant: string }[] = [];
  const objectReads: string[] = [];
  const stuckAsked: string[][] = [];
  const io: CommandIo = { stdout: (t) => out.push(t), stderr: (t) => out.push(t) };

  const corpus: CorpusInventory = {
    listItems: async () => items,
    contentKeys: async (): Promise<ContentKeys | null> => null,
    stuckStages: async (ids) => {
      stuckAsked.push([...ids]);
      return new Map();
    },
    ...overrides,
  };

  const deps: CorpusAuditDeps = {
    io,
    corpus: async (databaseUrlEnv, tenant, run) => {
      // The command must resolve its tenant before it opens anything: a
      // 'global' selector has no PostgreSQL corpus and must never connect.
      if (tenant.kind === "global") throw new UsageError("--tenant global has no PostgreSQL corpus");
      opened.push({ databaseUrlEnv, tenant: tenant.tenantId });
      return run(corpus as never);
    },
    r2: {
      readObject: async (key) => {
        objectReads.push(key);
        return null;
      },
    },
    mkdir: async (dir) => {
      mkdirs.push(dir);
    },
    writeFile: async (filePath, body) => {
      writes.push({ path: filePath, body });
    },
    now: () => NOW,
  };
  return { deps, out, writes, mkdirs, opened, objectReads, stuckAsked };
}

describe("ops corpus audit", () => {
  it("plan mode reads and classifies but writes no report files", async () => {
    const { deps, out, writes, mkdirs } = makeDeps();
    const code = await corpusAuditCommand.run(["--tenant", TENANT, "--out", "reports"], deps);
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
    const code = await corpusAuditCommand.run(["--tenant", TENANT, "--out", "reports", "--execute"], deps);
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
    expect(writes[1].body).toContain(`npm run ops -- corpus drop --tenant ${TENANT} <url> --execute`);
    // Provenance stamp: corpus recover refuses an audit from another tenant.
    expect(json).toMatchObject({ tenant: TENANT });
    expect(writes[1].body).not.toMatch(/`corpus-drop/);
  });

  it("opens the corpus for the selected tenant, from the named database variable", async () => {
    const { deps, opened } = makeDeps();
    await corpusAuditCommand.run(
      ["--tenant", TENANT, "--database-url-env", "NEON_REHEARSAL_DATABASE_URL"],
      deps,
    );
    expect(opened).toEqual([{ databaseUrlEnv: "NEON_REHEARSAL_DATABASE_URL", tenant: TENANT }]);
  });

  it("defaults the database variable to DATABASE_URL", async () => {
    const { deps, opened } = makeDeps();
    await corpusAuditCommand.run(["--tenant", TENANT], deps);
    expect(opened).toEqual([{ databaseUrlEnv: "DATABASE_URL", tenant: TENANT }]);
  });

  it("refuses --tenant global, which addresses no PostgreSQL corpus", async () => {
    const { deps, writes } = makeDeps();
    await expect(corpusAuditCommand.run(["--tenant", "global"], deps)).rejects.toThrow(UsageError);
    expect(writes).toHaveLength(0);
  });

  it("reads only the selected tenant's corpus, never a foreign one", async () => {
    const other = "usr_22222222-2222-4222-8222-222222222222";
    const byTenant: Record<string, ListItem[]> = {
      [TENANT]: [{ ...ITEMS[1], id: "rd_a_only" }],
      [other]: [{ ...ITEMS[1], id: "rd_b_foreign" }],
    };
    const { deps, writes, opened } = makeDeps();
    deps.corpus = async (databaseUrlEnv, tenant, run) => {
      if (tenant.kind === "global") throw new UsageError("global");
      opened.push({ databaseUrlEnv, tenant: tenant.tenantId });
      return run({
        listItems: async () => byTenant[tenant.tenantId] ?? [],
        contentKeys: async () => null,
        stuckStages: async () => new Map(),
      } as never);
    };

    const code = await corpusAuditCommand.run(["--tenant", TENANT, "--out", "reports", "--execute"], deps);

    expect(code).toBe(0);
    const report = JSON.parse(writes[0]!.body);
    expect(report).toMatchObject({ tenant: TENANT });
    expect(report.rows.map((row: { reading_id: string }) => row.reading_id)).toEqual(["rd_a_only"]);
    expect(report.rows.map((row: { reading_id: string }) => row.reading_id)).not.toContain("rd_b_foreign");
  });

  it("--deep asks for the stranded readings' stuck stages in one query", async () => {
    const asked: string[][] = [];
    const { deps, writes } = makeDeps(ITEMS, {
      stuckStages: async (ids) => {
        asked.push([...ids]);
        return new Map([["rd_pending", "summarize/running"]]);
      },
    });
    await corpusAuditCommand.run(["--tenant", TENANT, "--out", "reports", "--deep", "--execute"], deps);
    expect(asked).toEqual([["rd_pending"]]);
    const row = JSON.parse(writes[0]!.body).rows.find((r: { reading_id: string }) => r.reading_id === "rd_pending");
    expect(row.stuck_stage).toBe("summarize/running");
  });

  it("--deep costs no query when nothing is stranded", async () => {
    const ready: ListItem[] = [ITEMS[0]];
    const { deps, stuckAsked } = makeDeps(ready);
    await corpusAuditCommand.run(["--tenant", TENANT, "--deep"], deps);
    expect(stuckAsked).toEqual([[]]);
  });

  it("--teasers reads the extracted bytes at the key the reading points at now", async () => {
    const items: ListItem[] = [
      {
        id: "rd_teaser",
        url: "https://blog.pragmaticengineer.com/a",
        status: "ready",
        created_at: "2026-08-01T00:00:00Z",
        key_prefix: "readings/rd_teaser",
      },
    ];
    const { deps, objectReads } = makeDeps(items, {
      contentKeys: async () => ({
        rawKey: "readings/rd_teaser/revisions/at_1/raw.html",
        extractedKey: "readings/rd_teaser/revisions/at_1/extracted.md",
        contentType: "text/html",
      }),
    });
    await corpusAuditCommand.run(["--tenant", TENANT, "--teasers"], deps);
    // The revision key, not the legacy key_prefix spelling.
    expect(objectReads).toEqual(["readings/rd_teaser/revisions/at_1/extracted.md"]);
  });

  it("--degraded includes ready YouTube enrichment misses without extra reads", async () => {
    const items: ListItem[] = [
      ...ITEMS,
      {
        id: "rd_yt",
        url: "https://www.youtube.com/watch?v=abc",
        status: "ready",
        created_at: "2026-08-03T00:00:00Z",
        key_prefix: "readings/rd_yt",
        enrichment_degradation: {
          source: "youtube",
          tier: "watch_page",
          code: "TooManyRedirectsError",
          message: "redirect chain exceeded 5 hops: https://www.youtube.com/watch",
        },
      },
    ];
    const { deps, writes, objectReads } = makeDeps(items);
    const code = await corpusAuditCommand.run(
      ["--tenant", TENANT, "--out", "reports", "--degraded", "--execute"],
      deps,
    );
    expect(code).toBe(0);
    const json = JSON.parse(writes[0]!.body);
    expect(json.rows.some((r: { category: string }) => r.category === "degraded")).toBe(true);
    expect(writes[1]!.body).toContain("Ready — enrichment degraded");
    expect(writes[1]!.body).toContain("rd_yt");
    expect(objectReads).toHaveLength(0);
  });

  it("rejects an unknown option before opening a connection", async () => {
    const { deps, opened } = makeDeps();
    await expect(corpusAuditCommand.run(["--tenant", TENANT, "--nope"], deps)).rejects.toThrowError(
      expect.objectContaining({ name: "Error", message: expect.stringContaining("--nope") }),
    );
    expect(opened).toHaveLength(0);
  });

  it("is registered as plan-first", () => {
    expect(corpusAuditCommand.safety).toBe("plan-first");
  });
});
