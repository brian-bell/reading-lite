import { describe, expect, it } from "vitest";
import { corpusRecoverCommand, type CorpusRecoverDeps } from "../../../scripts/ops-lib/commands/corpus-recover";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { AuditRow } from "../../../scripts/corpus-lib/types";

// One row per routing class: stranded pending -> reprocess, 403 -> local-extract,
// dead link -> skip.
const ROWS: AuditRow[] = [
  {
    category: "pending", url: "https://a.example/x", short: "a.example/x",
    reading_id: "rd_a", key_prefix: "readings/rd_a", attempts: 1, class: "stranded",
  },
  {
    category: "failed", url: "https://b.example/y", short: "b.example/y",
    reading_id: "rd_b", key_prefix: "readings/rd_b", attempts: 1,
    code: "BadStatusError", message: "status 403", reason: "HTTP 403",
  },
  {
    category: "failed", url: "https://c.example/z", short: "c.example/z",
    reading_id: "rd_c", key_prefix: "readings/rd_c", attempts: 1,
    code: "BadStatusError", message: "status 404", reason: "dead link (HTTP 404)",
  },
];

interface Recorded {
  deps: CorpusRecoverDeps;
  out: string[];
  err: string[];
  reprocessed: string[];
  imported: { source_url: string; markdown: string }[];
  indexWrites: { path: string; body: string }[];
  batchExecutes: AuditRow[][];
  sidecarLoads: string[];
  configResolves: unknown[];
}

function makeDeps(overrides: Partial<CorpusRecoverDeps> = {}): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const reprocessed: string[] = [];
  const imported: { source_url: string; markdown: string }[] = [];
  const indexWrites: { path: string; body: string }[] = [];
  const batchExecutes: AuditRow[][] = [];
  const sidecarLoads: string[] = [];
  const configResolves: unknown[] = [];
  const deps: CorpusRecoverDeps = {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    readFile: async () => JSON.stringify({ rows: ROWS }),
    writeFile: async (path, body) => {
      indexWrites.push({ path, body });
    },
    resolveApiTarget: () => ({ base: "https://api.test", token: "tok" }),
    makeApi: () => ({
      reprocess: async (id: string) => {
        reprocessed.push(id);
        return { kind: "activated", id } as const;
      },
      importMarkdown: async (body: { source_url: string; markdown: string }) => {
        imported.push({ source_url: body.source_url, markdown: body.markdown });
        return { kind: "activated", id: "rd_new" } as const;
      },
    }),
    extract: async () => ({
      content_status: "captured", content_type: "text/html",
      markdown: "# extracted body", title: "T",
    }) as never,
    readListIndex: async () => [],
    sleep: async () => {},
    now: () => Date.parse("2026-08-22T12:00:00Z"),
    batch: {
      loadSidecar: async (p) => {
        sidecarLoads.push(p);
        return null;
      },
      clearSidecar: async () => {},
      resolveConfig: (flags) => {
        configResolves.push(flags);
        return { fake: true } as never;
      },
      execute: async (rows) => {
        batchExecutes.push(rows);
        return {
          report: [{ status: "ready" }, { status: "failed" }] as never,
          dropped: [], resumed: false, batchId: "batch_1",
        };
      },
    },
    ...overrides,
  };
  return { deps, out, err, reprocessed, imported, indexWrites, batchExecutes, sidecarLoads, configResolves };
}

describe("ops corpus recover — realtime routing", () => {
  it("fails closed without --tenant", async () => {
    const r = makeDeps();
    await expect(corpusRecoverCommand.run([], r.deps)).rejects.toThrow(/--tenant is required/);
    expect(r.reprocessed).toHaveLength(0);
    expect(r.indexWrites).toHaveLength(0);
    expect(r.batchExecutes).toHaveLength(0);
  });

  it("refuses an audit taken under a different tenant", async () => {
    const r = makeDeps();
    r.deps.readFile = async () =>
      JSON.stringify({ tenant: "usr_11111111-1111-4111-8111-111111111111", rows: [] });
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--execute", "--token", "tok"], r.deps);
    expect(code).toBe(1);
    expect(r.reprocessed).toHaveLength(0);
    expect(r.err.join("\n")).toContain("was taken under tenant");
  });

  it("plan mode under a usr_ tenant redirects to --batch instead of inviting a doomed execute", async () => {
    const r = makeDeps();
    const original = await r.deps.readFile("index.json");
    r.deps.readFile = async () =>
      JSON.stringify({ ...JSON.parse(original), tenant: "usr_11111111-1111-4111-8111-111111111111" });
    const code = await corpusRecoverCommand.run(
      ["--tenant", "usr_11111111-1111-4111-8111-111111111111"],
      r.deps,
    );
    expect(code).toBe(0);
    const text = r.err.join("\n");
    // The read-only classification still prints…
    expect(text).toContain("[plan reprocess] a.example/x");
    // …but the follow-up is the one that can actually succeed: --execute on
    // this path always refuses (token unverifiable), so don't invite it.
    expect(text).not.toContain("Rerun with --execute to act.");
    expect(text).toContain("--batch");
    expect(r.reprocessed).toHaveLength(0);
    expect(r.out.join("\n")).toContain('"executed": false');
  });

  it("refuses a realtime execute under a usr_ tenant selector (token unverifiable)", async () => {
    const r = makeDeps();
    // Audit provenance matches the selector, so the refusal under test is the
    // token-verification one, not the provenance guard.
    const original = await r.deps.readFile("index.json");
    r.deps.readFile = async () =>
      JSON.stringify({ ...JSON.parse(original), tenant: "usr_11111111-1111-4111-8111-111111111111" });
    const code = await corpusRecoverCommand.run(
      ["--tenant", "usr_11111111-1111-4111-8111-111111111111", "--execute", "--token", "tok"],
      r.deps,
    );
    expect(code).toBe(1);
    expect(r.reprocessed).toHaveLength(0);
    expect(r.imported).toHaveLength(0);
    expect(r.err.join("\n")).toContain("cannot verify that the bearer token belongs to tenant");
  });

  it("refuses to resume a batch sidecar under a different tenant", async () => {
    const r = makeDeps();
    r.deps.batch.loadSidecar = async () =>
      ({ batchId: "batch_9", targets: [], provider: "openai", tenant: "usr_11111111-1111-4111-8111-111111111111" }) as never;
    const code = await corpusRecoverCommand.run(
      ["--tenant", "global", "--batch", "--execute", "--sole-writer"],
      r.deps,
    );
    expect(code).toBe(1);
    expect(r.batchExecutes).toHaveLength(0);
    expect(r.err.join("\n")).toContain("belongs to tenant 'usr_11111111-1111-4111-8111-111111111111'");
  });

  it("plan mode lists actions but makes no submissions or writes", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global"], r.deps);
    expect(code).toBe(0);
    expect(r.reprocessed).toHaveLength(0);
    expect(r.imported).toHaveLength(0);
    expect(r.indexWrites).toHaveLength(0);
    expect(r.batchExecutes).toHaveLength(0);
    const text = r.err.join("\n");
    expect(text).toContain("[plan reprocess] a.example/x");
    expect(text).toContain("[plan local-extract] b.example/y");
    expect(text).not.toContain("c.example/z —"); // skip rows are not acted on
    expect(r.out.join("\n")).toContain('"executed": false');
  });

  it("--execute routes reprocess and local-extract rows and annotates the index", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--execute"], r.deps);
    expect(code).toBe(0);
    expect(r.reprocessed).toEqual(["rd_a"]);
    expect(r.imported).toEqual([{ source_url: "https://b.example/y", markdown: "# extracted body" }]);
    expect(r.indexWrites).toHaveLength(1);
    const doc = JSON.parse(r.indexWrites[0].body);
    expect(doc.rows[0].result).toBe("reprocess: activated");
    expect(doc.rows[1].result).toContain("local-extract+import: activated");
    expect(r.out.join("\n")).toContain('"executed": true');
  });

  it("--only reprocess restricts the execute path to that action", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--only", "reprocess", "--execute"], r.deps);
    expect(code).toBe(0);
    expect(r.reprocessed).toEqual(["rd_a"]);
    expect(r.imported).toHaveLength(0);
  });

  it("returns 1 when a submission errors", async () => {
    const r = makeDeps();
    r.deps.makeApi = () => ({
      reprocess: async () => ({ kind: "http_error", status: 500, message: "boom" }),
      importMarkdown: async () => ({ kind: "http_error", status: 500, message: "boom" }),
    });
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--only", "reprocess", "--execute"], r.deps);
    expect(code).toBe(1);
    expect(r.out.join("\n")).toContain('"errors": 1');
  });

  it("counts an active-attempt conflict or initializing owner as in progress, not an error", async () => {
    const r = makeDeps();
    r.deps.makeApi = () => ({
      reprocess: async () =>
        ({ kind: "conflict", reason: "active_attempt", message: "reading already has an active attempt" }) as const,
      importMarkdown: async () => ({ kind: "initializing", id: "rd_race" }) as const,
    });
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--execute"], r.deps);
    expect(code).toBe(0);
    const summary = r.out.join("\n");
    expect(summary).toContain('"in_progress": 2');
    expect(summary).toContain('"errors": 0');
    const doc = JSON.parse(r.indexWrites[0].body);
    expect(doc.rows[0].result).toContain("in progress");
  });

  it("counts a missing-markdown conflict as an error — force reprocess bypasses the attempt check", async () => {
    const r = makeDeps();
    r.deps.makeApi = () => ({
      reprocess: async () =>
        ({ kind: "conflict", reason: "missing_markdown", message: "markdown content not available" }) as const,
      importMarkdown: async () =>
        ({ kind: "conflict", reason: "missing_markdown", message: "markdown content not available" }) as const,
    });
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--only", "reprocess", "--execute"], r.deps);
    expect(code).toBe(1);
    const summary = r.out.join("\n");
    expect(summary).toContain('"errors": 1');
    expect(summary).toContain('"in_progress": 0');
    const doc = JSON.parse(r.indexWrites[0].body);
    expect(doc.rows[0].result).toContain("markdown content not available");
  });

  it("rejects an invalid --only before reading the audit file", async () => {
    let reads = 0;
    const r = makeDeps({
      readFile: async () => {
        reads++;
        return JSON.stringify({ rows: [] });
      },
    });
    await expect(corpusRecoverCommand.run(["--tenant", "global", "--only", "everything"], r.deps)).rejects.toThrow(UsageError);
    expect(reads).toBe(0);
  });

  it("rejects an unknown flag as a usage error", async () => {
    const r = makeDeps();
    await expect(corpusRecoverCommand.run(["--tenant", "global", "--nope"], r.deps)).rejects.toThrow(UsageError);
  });

  it("requires a token on the execute path", async () => {
    const r = makeDeps({ resolveApiTarget: () => ({ base: "https://api.test", token: "" }) });
    await expect(corpusRecoverCommand.run(["--tenant", "global", "--execute"], r.deps)).rejects.toThrow(UsageError);
    expect(r.reprocessed).toHaveLength(0);
  });
});

describe("ops corpus recover — batch routing", () => {
  it("plan mode reads the sidecar but resolves no config and submits nothing", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--batch"], r.deps);
    expect(code).toBe(0);
    expect(r.sidecarLoads).toHaveLength(1);
    expect(r.configResolves).toHaveLength(0);
    expect(r.batchExecutes).toHaveLength(0);
    const text = r.err.join("\n");
    expect(text).toContain("[plan batch] a.example/x");
    expect(text).toContain("would submit 2 reading(s)");
  });

  it("plan mode announces a resume when a sidecar exists", async () => {
    const r = makeDeps();
    r.deps.batch.loadSidecar = async () => ({ batchId: "batch_9", targets: [{}, {}], provider: "openai" }) as never;
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--batch"], r.deps);
    expect(code).toBe(0);
    expect(r.err.join("\n")).toContain("would RESUME in-flight batch batch_9 (2 readings)");
    expect(r.batchExecutes).toHaveLength(0);
  });

  it("--batch --execute refuses without --sole-writer", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--batch", "--execute"], r.deps);
    expect(code).toBe(2);
    expect(r.err.join("\n")).toContain("REFUSED");
    expect(r.configResolves).toHaveLength(0);
    expect(r.batchExecutes).toHaveLength(0);
  });

  it("--batch --execute --sole-writer routes reprocess + local-extract rows through the batch seam", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--batch", "--execute", "--sole-writer"], r.deps);
    // The stubbed report contains one failed row, so the command reports failure.
    expect(code).toBe(1);
    expect(r.batchExecutes).toHaveLength(1);
    expect(r.batchExecutes[0].map((row) => row.reading_id)).toEqual(["rd_a", "rd_b"]);
    expect(r.out.join("\n")).toContain('"mode": "batch"');
  });

  it("pins the sidecar provider when resuming an executed batch", async () => {
    const r = makeDeps();
    r.deps.batch.loadSidecar = async () =>
      ({ batchId: "batch_9", targets: [], provider: "anthropic" }) as never;
    r.deps.batch.execute = async () => ({ report: [], dropped: [], resumed: true, batchId: "batch_9" });
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--batch", "--execute", "--sole-writer"], r.deps);
    expect(code).toBe(0);
    expect(r.configResolves).toEqual([
      {
        resumeProvider: "anthropic",
        tenant: { kind: "global", keyRoot: "", namespace: undefined },
      },
    ]);
  });

  it("--limit caps how many rows enter the batch", async () => {
    const r = makeDeps();
    const code = await corpusRecoverCommand.run(["--tenant", "global", "--batch", "--execute", "--sole-writer", "--limit", "1"], r.deps);
    expect(code).toBe(1);
    expect(r.batchExecutes[0].map((row) => row.reading_id)).toEqual(["rd_a"]);
  });
});
