import { describe, expect, it, vi } from "vitest";
import type { ListIndexItem } from "../../../src/schemas/api";
import type { AgentConfig } from "../../../scripts/extract-agent-lib/config";
import {
  markdownGate,
  MARKDOWN_SUBMIT_BUDGET_BYTES,
} from "../../../scripts/extract-agent-lib/gates";
import { parseRunArgs, runAgent, type RunDeps } from "../../../scripts/extract-agent-lib/run";
import { emptySidecar, type SidecarState } from "../../../scripts/extract-agent-lib/sidecar";
import type { StaticOutcome } from "../../../scripts/extract-agent-lib/static-tier";
import { MARKDOWN_IMPORT_MAX_BYTES } from "../../../scripts/import-markdown-lib/parse";
import { makeRow } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const GOOD_MARKDOWN = "A serious article paragraph. ".repeat(20).trim(); // ~580 chars

function blockedRow(overrides: Partial<ListIndexItem> = {}): ListIndexItem {
  return makeRow({
    status: "failed",
    error: { code: "BadStatusError", message: "bad response status 403: https://x", stage: "fetch_source" },
    ...overrides,
  });
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    api: { base: "https://reading.example", token: "tok" },
    maxPaidActions: 25,
    maxAttempts: 3,
    fetchMaxBytes: 20 * 1024 * 1024,
    minArticleChars: 350,
    statePath: "/unused/state.json",
    email: false,
    ...overrides,
  };
}

function makeDeps(
  rows: ListIndexItem[],
  overrides: Partial<RunDeps> = {},
): { deps: RunDeps; saved: SidecarState[] } {
  const saved: SidecarState[] = [];
  const deps: RunDeps = {
    config: config(),
    pageReadings: vi.fn(async () => rows),
    extract: vi.fn(
      async (): Promise<StaticOutcome> => ({
        kind: "extracted",
        markdown: GOOD_MARKDOWN,
        title: "T",
        extractor: "readability",
      }),
    ),
    submit: vi.fn(async () => ({ outcome: "new" as const, id: "rd_x" })),
    loadState: vi.fn(async () => emptySidecar()),
    saveState: vi.fn(async (state: SidecarState) => {
      saved.push(state);
    }),
    now: () => NOW,
    log: () => {},
    ...overrides,
  };
  return { deps, saved };
}

describe("markdownGate", () => {
  const cfg = { minArticleChars: 350 };
  // The gate sizes the whole submit body, so every case names the fields it
  // sends. `url` is the fixed 12-byte baseline the size cases budget around.
  const url = "https://e.test";
  const body = (markdown: string, title?: string) => ({ source_url: url, markdown, ...(title ? { title } : {}) });
  const bodyBudget = MARKDOWN_SUBMIT_BUDGET_BYTES - url.length;

  it("passes a body at exactly the submit budget (queue cap minus envelope reserve)", () => {
    expect(MARKDOWN_SUBMIT_BUDGET_BYTES).toBe(MARKDOWN_IMPORT_MAX_BYTES - 1024);
    expect(markdownGate(body("x".repeat(bodyBudget)), cfg)).toEqual({ ok: true });
  });

  it("rejects a body one byte over the submit budget", () => {
    expect(markdownGate(body("x".repeat(bodyBudget + 1)), cfg)).toEqual({ ok: false, why: "over_ceiling" });
  });

  it("rejects markdown of exactly MARKDOWN_IMPORT_MAX_BYTES bytes (envelope headroom)", () => {
    expect(markdownGate(body("x".repeat(MARKDOWN_IMPORT_MAX_BYTES)), cfg)).toEqual({
      ok: false,
      why: "over_ceiling",
    });
  });

  it("measures bytes, not chars (multibyte markdown over the budget rejects)", () => {
    // "é" is 2 UTF-8 bytes: budget-in-chars would pass, budget-in-bytes must not.
    expect(markdownGate(body("é".repeat(bodyBudget - 100)), cfg)).toEqual({ ok: false, why: "over_ceiling" });
  });

  it("rejects short markdown after trimming", () => {
    expect(markdownGate(body(`   ${"x".repeat(349)}   `), cfg)).toEqual({ ok: false, why: "too_short" });
  });

  it("counts the title against the ceiling (the submit sends it in the same queue message)", () => {
    const markdown = "x".repeat(bodyBudget - 10);
    expect(markdownGate(body(markdown, "t".repeat(10)), cfg)).toEqual({ ok: true });
    expect(markdownGate(body(markdown, "t".repeat(11)), cfg)).toEqual({ ok: false, why: "over_ceiling" });
  });

  it("counts the source url against the ceiling (it rides the same queue message)", () => {
    const markdown = "x".repeat(bodyBudget);
    expect(markdownGate({ source_url: url, markdown }, cfg)).toEqual({ ok: true });
    expect(markdownGate({ source_url: `${url}/x`, markdown }, cfg)).toEqual({ ok: false, why: "over_ceiling" });
  });

  it("measures JSON-escaped bytes (the queue caps the serialized message)", () => {
    // Each `"` costs 2 bytes once serialized into ProcessReadingArgs.
    const half = Math.floor(bodyBudget / 2);
    expect(markdownGate(body('"'.repeat(half)), cfg)).toEqual({ ok: true });
    expect(markdownGate(body('"'.repeat(half + 1)), cfg)).toEqual({ ok: false, why: "over_ceiling" });
  });

  it("measures title bytes, not chars", () => {
    const markdown = "x".repeat(bodyBudget - 10);
    // "é" is 2 UTF-8 bytes: 6 chars is 12 bytes, over the 10 bytes of headroom.
    expect(markdownGate(body(markdown, "é".repeat(6)), cfg)).toEqual({ ok: false, why: "over_ceiling" });
  });
});

describe("parseRunArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseRunArgs([])).toEqual({ execute: false });
    expect(parseRunArgs(["--dry-run"])).toEqual({ execute: false });
  });

  it("parses --execute, --limit, and --only", () => {
    expect(parseRunArgs(["--execute", "--limit", "5", "--only", "rd_abc"])).toEqual({
      execute: true,
      limit: 5,
      only: "rd_abc",
    });
  });

  it("rejects unknown flags and bad limits", () => {
    expect(() => parseRunArgs(["--frobnicate"])).toThrow(/frobnicate/);
    expect(() => parseRunArgs(["--limit", "zero"])).toThrow(/--limit/);
    expect(() => parseRunArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseRunArgs(["--only"])).toThrow(/--only/);
  });
});

describe("runAgent planning", () => {
  it("buckets rows by policy and sidecar verdicts", async () => {
    const eligible = blockedRow();
    const reddit = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const stale = blockedRow({ error: { code: "FetchTimeoutError", message: "stranded", stage: "queued" } });
    const dead = blockedRow({ error: { code: "BadStatusError", message: "bad response status 404: x", stage: "fetch_source" } });
    const pending = makeRow({ status: "pending" });
    const givenUp = blockedRow();
    const state = emptySidecar();
    state.readings[givenUp.id] = {
      attempts: 3,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: givenUp.updated_at,
      last_outcome: "error",
      given_up: true,
    };
    const { deps } = makeDeps([eligible, reddit, stale, dead, pending, givenUp], {
      loadState: async () => state,
    });

    const summary = await runAgent({ execute: false }, deps);

    expect(summary).toMatchObject({
      dry_run: true,
      scanned: 6,
      eligible: 1,
      manual: 1,
      out_of_scope: 1,
      never: 1,
      ineligible: 1,
      backed_off: 1,
      attempted: 0,
    });
    const planned = summary.rows.find((r) => r.id === eligible.id);
    expect(planned).toMatchObject({ outcome: "planned", route: "static" });
  });

  it("dry-run plans only what --limit would actually attempt", async () => {
    const rows = [blockedRow(), blockedRow(), blockedRow()];
    const { deps } = makeDeps(rows);

    const summary = await runAgent({ execute: false, limit: 1 }, deps);

    expect(summary).toMatchObject({ eligible: 3, deferred: 2 });
    expect(summary.rows.filter((r) => r.outcome === "planned")).toHaveLength(1);
    expect(summary.rows.filter((r) => r.outcome === "deferred")).toHaveLength(2);
  });

  it("dry-run does not defer on the paid-action cap (non-submitting rows leave the slot)", async () => {
    // Only submits consume the budget, so an execute run with maxPaidActions=1
    // whose first row gate-rejects still imports a later one. The plan must not
    // claim a skip that execute would go on to attempt.
    const rows = [blockedRow(), blockedRow(), blockedRow()];
    const { deps } = makeDeps(rows, { config: config({ maxPaidActions: 1 }) });

    const summary = await runAgent({ execute: false }, deps);

    expect(summary.rows.filter((r) => r.outcome === "planned")).toHaveLength(3);
    expect(summary).toMatchObject({ deferred: 0 });
  });

  it("dry-run performs zero extractions, submits, or sidecar writes", async () => {
    const { deps } = makeDeps([blockedRow(), blockedRow()]);

    await runAgent({ execute: false }, deps);

    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
  });
});

describe("runAgent execution", () => {
  it("imports an eligible row and records the sidecar outcome", async () => {
    const row = blockedRow();
    const { deps, saved } = makeDeps([row]);

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.extract).toHaveBeenCalledWith(row.url);
    expect(deps.submit).toHaveBeenCalledWith({ source_url: row.url, markdown: GOOD_MARKDOWN, title: "T" });
    expect(summary).toMatchObject({ dry_run: false, attempted: 1, imported: 1, errors: 0 });
    expect(saved.at(-1)?.readings[row.id]).toMatchObject({ last_outcome: "imported", attempts: 0 });
  });

  it("treats a 200/existing submit as imported (worker got there first)", async () => {
    const row = blockedRow();
    const { deps } = makeDeps([row], { submit: vi.fn(async () => ({ outcome: "existing" as const, id: row.id })) });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary.imported).toBe(1);
  });

  it("respects the paid-action cap and reports the overflow as deferred", async () => {
    const rows = Array.from({ length: 11 }, () => blockedRow());
    const { deps } = makeDeps(rows, { config: config({ maxPaidActions: 10 }) });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).toHaveBeenCalledTimes(10);
    expect(summary).toMatchObject({ imported: 10, deferred: 1 });
    expect(summary.rows.filter((r) => r.outcome === "deferred")).toHaveLength(1);
  });

  it("--limit caps attempts below the budget cap", async () => {
    const rows = [blockedRow(), blockedRow(), blockedRow()];
    const { deps } = makeDeps(rows);

    const summary = await runAgent({ execute: true, limit: 1 }, deps);

    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ attempted: 1, imported: 1, deferred: 2 });
  });

  it("--only narrows the run to one reading by id or url", async () => {
    const [a, b] = [blockedRow(), blockedRow()];
    const { deps } = makeDeps([a, b]);

    const byId = await runAgent({ execute: true, only: b.id }, deps);
    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(deps.extract).toHaveBeenCalledWith(b.url);
    expect(byId.attempted).toBe(1);

    const { deps: deps2 } = makeDeps([a, b]);
    await runAgent({ execute: true, only: a.url }, deps2);
    expect(deps2.extract).toHaveBeenCalledWith(a.url);
  });

  it("gate-rejects markdown over the ceiling without consuming a submit", async () => {
    const big = blockedRow();
    const fine = blockedRow();
    const { deps, saved } = makeDeps([big, fine], {
      config: config({ maxPaidActions: 1 }),
      extract: vi.fn(async (url: string): Promise<StaticOutcome> => ({
        kind: "extracted",
        markdown: url === big.url ? "x".repeat(MARKDOWN_IMPORT_MAX_BYTES) : GOOD_MARKDOWN,
        title: "T",
        extractor: "readability",
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    // The over-ceiling row burned no budget, so the second row still submits.
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ source_url: fine.url }));
    expect(summary).toMatchObject({ gate_rejected: 1, imported: 1 });
    expect(saved.at(-1)?.readings[big.id]).toMatchObject({ last_outcome: "gate_rejected", attempts: 1 });
  });

  it("gate-rejects a body under the ceiling whose title pushes the queue payload over it", async () => {
    const row = blockedRow();
    const { deps } = makeDeps([row], {
      extract: vi.fn(async (): Promise<StaticOutcome> => ({
        kind: "extracted",
        markdown: "x".repeat(MARKDOWN_SUBMIT_BUDGET_BYTES - 100),
        title: "T".repeat(200),
        extractor: "readability",
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ gate_rejected: 1, imported: 0 });
  });

  it("refunds the paid-action slot when the import no-ops on an existing owner", async () => {
    // A ready/pending owner returns 200/existing: the Worker enqueued nothing,
    // so the agent initiated no paid work and the slot must go back. Otherwise
    // a burst of these races exhausts the cap and defers recoverable rows.
    const rows = [blockedRow(), blockedRow(), blockedRow()];
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "existing", id: "rd_x" })
      .mockResolvedValueOnce({ outcome: "existing", id: "rd_y" })
      .mockResolvedValueOnce({ outcome: "new", id: "rd_z" });
    const { deps } = makeDeps(rows, { config: config({ maxPaidActions: 1 }), submit });

    const summary = await runAgent({ execute: true }, deps);

    expect(submit).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ imported: 3, deferred: 0 });
  });

  it("still stops at the cap once real paid work is enqueued", async () => {
    const rows = [blockedRow(), blockedRow(), blockedRow()];
    const submit = vi.fn().mockResolvedValue({ outcome: "new", id: "rd_z" });
    const { deps } = makeDeps(rows, { config: config({ maxPaidActions: 2 }), submit });

    const summary = await runAgent({ execute: true }, deps);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ imported: 2, deferred: 1 });
  });

  it("gate-rejects short markdown", async () => {
    const row = blockedRow();
    const { deps } = makeDeps([row], {
      extract: vi.fn(async (): Promise<StaticOutcome> => ({
        kind: "extracted",
        markdown: "thin",
        title: "T",
        extractor: "readability",
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary.gate_rejected).toBe(1);
  });

  it("records challenge and dead outcomes in the sidecar without submitting", async () => {
    const challenged = blockedRow();
    const gone = blockedRow();
    const { deps, saved } = makeDeps([challenged, gone], {
      extract: vi.fn(async (url: string): Promise<StaticOutcome> =>
        url === challenged.url ? { kind: "challenge", detail: "403" } : { kind: "dead", detail: "404" },
      ),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ challenge: 1, dead: 1, imported: 0 });
    expect(saved.at(-1)?.readings[challenged.id]).toMatchObject({ last_outcome: "challenge", attempts: 1 });
    expect(saved.at(-1)?.readings[gone.id]).toMatchObject({ last_outcome: "error", attempts: 1 });
  });

  it("records a submit error as a sidecar attempt and keeps going", async () => {
    const bad = blockedRow();
    const good = blockedRow();
    const { deps, saved } = makeDeps([bad, good], {
      submit: vi
        .fn()
        .mockResolvedValueOnce({ outcome: "error", error: "500 boom" })
        .mockResolvedValueOnce({ outcome: "new", id: good.id }),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary).toMatchObject({ errors: 1, imported: 1 });
    expect(saved.at(-1)?.readings[bad.id]).toMatchObject({ last_outcome: "error", attempts: 1 });
  });

  it("survives a thrown extraction and continues to the next row", async () => {
    const boom = blockedRow();
    const good = blockedRow();
    const { deps, saved } = makeDeps([boom, good], {
      extract: vi.fn(async (url: string): Promise<StaticOutcome> => {
        if (url === boom.url) throw new Error("chromium ate it");
        return { kind: "extracted", markdown: GOOD_MARKDOWN, title: "T", extractor: "readability" };
      }),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary).toMatchObject({ errors: 1, imported: 1 });
    expect(saved.at(-1)?.readings[boom.id]).toMatchObject({ last_outcome: "error" });
  });

  it("routes reddit/youtube rows to the manual queue without extracting", async () => {
    const reddit = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const { deps } = makeDeps([reddit]);

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary.manual).toBe(1);
    expect(summary.rows[0]).toMatchObject({ route: "reddit", outcome: "manual" });
  });
});
