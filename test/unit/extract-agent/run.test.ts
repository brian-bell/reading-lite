import { describe, expect, it, vi } from "vitest";
import type { ListIndexItem } from "../../../src/schemas/api";
import {
  markdownGate,
  MARKDOWN_SUBMIT_BUDGET_BYTES,
} from "../../../scripts/extract-agent-lib/gates";
import { HeadlessUnavailableError } from "../../../scripts/extract-agent-lib/headless-tier";
import type { RedditOutcome } from "../../../scripts/extract-agent-lib/reddit";
import { parseRunArgs, runAgent, type RunDeps } from "../../../scripts/extract-agent-lib/run";
import {
  emptySidecar,
  recordAttempt,
  type SidecarState,
} from "../../../scripts/extract-agent-lib/sidecar";
import type { ExtractOutcome } from "../../../scripts/extract-agent-lib/outcome";
import { MARKDOWN_IMPORT_MAX_BYTES } from "../../../scripts/import-markdown-lib/parse";
import { makeConfig, makeRow } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const GOOD_MARKDOWN = "A serious article paragraph. ".repeat(20).trim(); // ~580 chars
const RENDERED_MARKDOWN = "A rendered article paragraph. ".repeat(20).trim();

function blockedRow(overrides: Partial<ListIndexItem> = {}): ListIndexItem {
  return makeRow({
    status: "failed",
    error: { code: "BadStatusError", message: "bad response status 403: https://x", stage: "fetch_source" },
    ...overrides,
  });
}

function makeDeps(
  rows: ListIndexItem[],
  overrides: Partial<RunDeps> = {},
): { deps: RunDeps; saved: SidecarState[] } {
  const saved: SidecarState[] = [];
  const deps: RunDeps = {
    config: makeConfig(),
    pageReadings: vi.fn(async () => rows),
    extract: vi.fn(
      async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: GOOD_MARKDOWN,
        title: "T",
        tier: "static", salvaged: false,
      }),
    ),
    reddit: vi.fn(
      async (): Promise<RedditOutcome> => ({
        kind: "extracted",
        body: { source_url: "https://www.reddit.com/r/x/comments/abc/t/", markdown: GOOD_MARKDOWN, title: "Reddit" },
      }),
    ),
    submit: vi.fn(async () => ({ outcome: "new" as const, id: "rd_x" })),
    render: vi.fn(
      async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: RENDERED_MARKDOWN,
        title: "Rendered",
        tier: "headless",
        salvaged: false,
      }),
    ),
    warn: () => {},
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

  it("parses --execute, --limit, --only, and --verbose", () => {
    expect(parseRunArgs(["--execute", "--limit", "5", "--only", "rd_abc", "--verbose"])).toEqual({
      execute: true,
      limit: 5,
      only: "rd_abc",
      verbose: true,
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
  it("plans a Reddit row without fetching, rendering, submitting, or persisting", async () => {
    const reddit = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const { deps } = makeDeps([reddit]);

    const summary = await runAgent({ execute: false }, deps);

    expect(summary).toMatchObject({ eligible: 1, manual: 0, attempted: 0 });
    expect(summary.rows[0]).toMatchObject({ decision: "attempt", route: "reddit", outcome: "planned" });
    expect(deps.reddit).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
  });

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
      eligible: 2,
      manual: 0,
      out_of_scope: 1,
      never: 1,
      ineligible: 1,
      backed_off: 1,
      attempted: 0,
    });
    const planned = summary.rows.find((r) => r.id === eligible.id);
    expect(planned).toMatchObject({ outcome: "planned", route: "static" });
    expect(summary.rows.find((r) => r.id === reddit.id)).toMatchObject({ outcome: "planned", route: "reddit" });
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
    const { deps } = makeDeps(rows, { config: makeConfig({ maxPaidActions: 1 }) });

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
  it("imports the exact body produced by the Reddit route without static extraction or rendering", async () => {
    const row = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const body = { source_url: row.url, markdown: GOOD_MARKDOWN, title: "Reddit title" };
    const { deps, saved } = makeDeps([row], {
      reddit: vi.fn(async (): Promise<RedditOutcome> => ({ kind: "extracted", body })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.reddit).toHaveBeenCalledOnce();
    expect(deps.reddit).toHaveBeenCalledWith(row.url);
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.submit).toHaveBeenCalledWith(body);
    expect(summary).toMatchObject({ attempted: 1, imported: 1, rendered: 0 });
    expect(saved.at(-1)?.readings[row.id]).toMatchObject({ last_outcome: "imported", attempts: 0 });
  });

  it("records a Reddit challenge as durable manual work without consuming render or paid-action capacity", async () => {
    const reddit = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const staticRow = blockedRow();
    const { deps, saved } = makeDeps([reddit, staticRow], {
      config: makeConfig({ maxPaidActions: 1, maxRenders: 1 }),
      reddit: vi.fn(async (): Promise<RedditOutcome> => ({
        kind: "manual",
        detail: "anonymous access challenged; use the reddit-import skill",
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.extract).toHaveBeenCalledOnce();
    expect(deps.extract).toHaveBeenCalledWith(staticRow.url);
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ attempted: 2, manual: 1, imported: 1, rendered: 0 });
    expect(saved.at(-1)?.readings[reddit.id]).toEqual({
      attempts: 1,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: reddit.updated_at,
      last_outcome: "manual",
      given_up: true,
    });
  });

  it("keeps unchanged terminal Reddit work visible as manual and retries after manifest movement", async () => {
    const row = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const state = recordAttempt(emptySidecar(), row, "manual", { now: () => NOW, maxAttempts: 3 });
    const { deps } = makeDeps([row], { loadState: vi.fn(async () => state) });

    const unchanged = await runAgent({ execute: true }, deps);

    expect(deps.reddit).not.toHaveBeenCalled();
    expect(unchanged).toMatchObject({ manual: 1, backed_off: 0, attempted: 0 });
    expect(unchanged.rows[0]).toMatchObject({
      decision: "manual",
      route: "reddit",
      outcome: "manual",
      why: expect.stringMatching(/reddit-import skill/i),
    });

    const moved = { ...row, updated_at: "2026-07-03T00:00:00.000Z" };
    const { deps: movedDeps } = makeDeps([moved], { loadState: vi.fn(async () => state) });
    const retried = await runAgent({ execute: true }, movedDeps);

    expect(movedDeps.reddit).toHaveBeenCalledWith(moved.url);
    expect(retried).toMatchObject({ attempted: 1, imported: 1, manual: 0 });
  });

  it("applies the shared inherited-title gate to Reddit bodies without submitting", async () => {
    const row = blockedRow({
      url: "https://www.reddit.com/r/x/comments/abc/t/",
      title: "T".repeat(200),
    });
    const body = {
      source_url: row.url,
      markdown: "x".repeat(MARKDOWN_SUBMIT_BUDGET_BYTES - 100),
    };
    const { deps, saved } = makeDeps([row], {
      reddit: vi.fn(async (): Promise<RedditOutcome> => ({ kind: "extracted", body })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ gate_rejected: 1, imported: 0 });
    expect(saved.at(-1)?.readings[row.id]).toMatchObject({ last_outcome: "gate_rejected", attempts: 1 });
  });

  it("refunds a Reddit existing-owner race so a later static row can use the paid slot", async () => {
    const reddit = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const staticRow = blockedRow();
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "existing", id: reddit.id })
      .mockResolvedValueOnce({ outcome: "new", id: staticRow.id });
    const { deps } = makeDeps([reddit, staticRow], {
      config: makeConfig({ maxPaidActions: 1 }),
      submit,
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ attempted: 2, imported: 2, deferred: 0 });
  });

  it("records a Reddit submit error with the ordinary retry backoff", async () => {
    const row = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/t/" });
    const { deps, saved } = makeDeps([row], {
      submit: vi.fn(async () => ({ outcome: "error" as const, error: "500 boom" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary).toMatchObject({ errors: 1, imported: 0 });
    expect(saved.at(-1)?.readings[row.id]).toMatchObject({
      attempts: 1,
      last_outcome: "error",
      next_eligible_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      given_up: false,
    });
  });

  it("applies --limit across static and Reddit routes in input order", async () => {
    const first = blockedRow({ url: "https://www.reddit.com/r/x/comments/abc/first/" });
    const second = blockedRow();
    const third = blockedRow({ url: "https://www.reddit.com/r/x/comments/def/third/" });
    const order: string[] = [];
    const { deps } = makeDeps([first, second, third], {
      reddit: vi.fn(async (url: string): Promise<RedditOutcome> => {
        order.push(url);
        return {
          kind: "extracted",
          body: { source_url: url, markdown: GOOD_MARKDOWN, title: "Reddit" },
        };
      }),
      extract: vi.fn(async (url: string): Promise<ExtractOutcome> => {
        order.push(url);
        return {
          kind: "extracted",
          markdown: GOOD_MARKDOWN,
          title: "Static",
          tier: "static",
          salvaged: false,
        };
      }),
    });

    const summary = await runAgent({ execute: true, limit: 2 }, deps);

    expect(order).toEqual([first.url, second.url]);
    expect(summary).toMatchObject({ attempted: 2, imported: 2, deferred: 1 });
    expect(summary.rows.find((entry) => entry.id === third.id)?.outcome).toBe("deferred");
  });

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
    const { deps } = makeDeps(rows, { config: makeConfig({ maxPaidActions: 10 }) });

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
      config: makeConfig({ maxPaidActions: 1 }),
      extract: vi.fn(async (url: string): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: url === big.url ? "x".repeat(MARKDOWN_IMPORT_MAX_BYTES) : GOOD_MARKDOWN,
        title: "T",
        tier: "static", salvaged: false,
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
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: "x".repeat(MARKDOWN_SUBMIT_BUDGET_BYTES - 100),
        title: "T".repeat(200),
        tier: "static", salvaged: false,
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ gate_rejected: 1, imported: 0 });
  });

  it("counts the title inherited from the row when static extraction returns none", async () => {
    // The import endpoint substitutes `title ?? manifest.title` into the queue
    // message, so a row that already carries a title still pays for it even
    // when the static tier returns none (text/JSON sources, repaired legacy
    // manifests). Sizing only outcome.title lets near-cap markdown through the
    // gate and fail at queue.send, after the eager writes.
    const row = blockedRow({ title: "T".repeat(200) });
    const { deps } = makeDeps([row], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: "x".repeat(MARKDOWN_SUBMIT_BUDGET_BYTES - 100),
        tier: "static", salvaged: false,
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ gate_rejected: 1, imported: 0 });
  });

  it("sizes the inherited title without forwarding it (the request schema is stricter)", async () => {
    // The import request schema trims (`z.string().trim().min(1)`) while the
    // stored manifest/list schemas do not, so forwarding a stored title would
    // turn a whitespace-only one into a 400 and burn a recovery attempt. The
    // Worker's own `title ?? manifest.title` fallback keeps producing the value;
    // the agent only has to size it.
    const row = blockedRow({ title: "   " });
    const { deps } = makeDeps([row], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: GOOD_MARKDOWN,
        tier: "static", salvaged: false,
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).toHaveBeenCalledWith({
      source_url: row.url,
      markdown: GOOD_MARKDOWN,
      title: undefined,
    });
    expect(summary).toMatchObject({ imported: 1 });
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
    const { deps } = makeDeps(rows, { config: makeConfig({ maxPaidActions: 1 }), submit });

    const summary = await runAgent({ execute: true }, deps);

    expect(submit).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ imported: 3, deferred: 0 });
  });

  it("still stops at the cap once real paid work is enqueued", async () => {
    const rows = [blockedRow(), blockedRow(), blockedRow()];
    const submit = vi.fn().mockResolvedValue({ outcome: "new", id: "rd_z" });
    const { deps } = makeDeps(rows, { config: makeConfig({ maxPaidActions: 2 }), submit });

    const summary = await runAgent({ execute: true }, deps);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ imported: 2, deferred: 1 });
  });

  it("gate-rejects short markdown", async () => {
    const row = blockedRow();
    const { deps } = makeDeps([row], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: "thin",
        title: "T",
        tier: "static", salvaged: false,
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary.gate_rejected).toBe(1);
  });

  it("records challenge and dead outcomes in the sidecar without submitting", async () => {
    // Tier-1 bookkeeping on its own: no render configured, which is also how a
    // box without a browser runs.
    const challenged = blockedRow();
    const gone = blockedRow();
    const { deps, saved } = makeDeps([challenged, gone], {
      render: undefined,
      extract: vi.fn(async (url: string): Promise<ExtractOutcome> =>
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
      extract: vi.fn(async (url: string): Promise<ExtractOutcome> => {
        if (url === boom.url) throw new Error("chromium ate it");
        return { kind: "extracted", markdown: GOOD_MARKDOWN, title: "T", tier: "static", salvaged: false };
      }),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary).toMatchObject({ errors: 1, imported: 1 });
    expect(saved.at(-1)?.readings[boom.id]).toMatchObject({ last_outcome: "error" });
  });

  it("renders and imports a row the static tier could only get a challenge for", async () => {
    const row = blockedRow();
    const render = vi.fn(async (): Promise<ExtractOutcome> => ({
      kind: "extracted",
      markdown: GOOD_MARKDOWN,
      title: "Rendered",
      tier: "headless",
      salvaged: false,
    }));
    const { deps, saved } = makeDeps([row], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
      render,
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(render).toHaveBeenCalledWith(row.url);
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ markdown: GOOD_MARKDOWN, title: "Rendered" }));
    expect(summary).toMatchObject({ rendered: 1, imported: 1, challenge: 0, rendered_failed: 0 });
    expect(summary.rows[0]).toMatchObject({ outcome: "imported", tier: "headless" });
    expect(saved.at(-1)?.readings[row.id]).toMatchObject({ last_outcome: "imported" });
  });

  it("renders a row whose static extraction found no article", async () => {
    const { deps } = makeDeps([blockedRow()], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "no_article", detail: "js shell" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ rendered: 1, imported: 1, no_article: 0 });
  });

  it("renders a salvage-only static extraction and prefers the rendered article", async () => {
    // Salvaged markdown is Readability's crash fallback — boilerplate and all.
    // A rendered DOM is why we bothered rendering, so it wins.
    const { deps } = makeDeps([blockedRow()], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: `${GOOD_MARKDOWN} soup`,
        tier: "static",
        salvaged: true,
      })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ markdown: RENDERED_MARKDOWN }));
    expect(summary).toMatchObject({ rendered: 1, imported: 1 });
  });

  it("does not render when the static tier already produced a real article", async () => {
    const { deps } = makeDeps([blockedRow()]);

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ markdown: GOOD_MARKDOWN }));
    expect(summary).toMatchObject({ rendered: 0, imported: 1 });
  });

  it("does not render a dead link or a hard error", async () => {
    const gone = blockedRow();
    const broken = blockedRow();
    const { deps } = makeDeps([gone, broken], {
      extract: vi.fn(async (url: string): Promise<ExtractOutcome> =>
        url === gone.url
          ? { kind: "dead", detail: "404" }
          : { kind: "error", code: "OversizedResponseError", detail: "too big" },
      ),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.render).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ dead: 1, errors: 1, rendered: 0 });
  });

  it("keeps the tier-1 outcome when the render finds nothing either", async () => {
    const row = blockedRow();
    const { deps, saved } = makeDeps([row], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403 cloudflare" })),
      render: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "no_article", detail: "still a shell" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ challenge: 1, rendered: 1, rendered_failed: 1 });
    expect(saved.at(-1)?.readings[row.id]).toMatchObject({ last_outcome: "challenge" });
    expect(summary.rows[0]?.detail).toContain("403 cloudflare");
    expect(summary.rows[0]?.detail).toContain("still a shell");
  });

  it("falls back to a salvaged tier-1 article when the render fails", async () => {
    // A broken render must not lose an article the static tier did produce.
    const salvaged = `${GOOD_MARKDOWN} soup`;
    const { deps } = makeDeps([blockedRow()], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: salvaged,
        tier: "static",
        salvaged: true,
      })),
      render: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "error", code: "TimeoutError", detail: "gave up" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ markdown: salvaged }));
    expect(summary).toMatchObject({ imported: 1, rendered: 1, rendered_failed: 1 });
  });

  it("survives a thrown render and keeps the tier-1 outcome", async () => {
    const { deps } = makeDeps([blockedRow(), blockedRow()], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
      render: vi.fn(async () => {
        throw new Error("chromium ate it");
      }),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.render).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ challenge: 2, rendered: 2, rendered_failed: 2, errors: 0 });
  });

  it("stops rendering for the whole run when the box cannot render at all", async () => {
    const warnings: string[] = [];
    const { deps } = makeDeps([blockedRow(), blockedRow(), blockedRow()], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
      render: vi.fn(async () => {
        throw new HeadlessUnavailableError("chromium is not installed");
      }),
      warn: (line: string) => warnings.push(line),
    });

    const summary = await runAgent({ execute: true }, deps);

    // One doomed launch, not one per row.
    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("chromium is not installed");
    expect(summary).toMatchObject({ challenge: 3, rendered: 0, renders_skipped: 3 });
  });

  it("counts qualified rows as skipped when no renderer is configured", async () => {
    // Supported configuration (a box with no browser), and it has to be visible:
    // renders_skipped at zero would read as "nothing was missed".
    const { deps } = makeDeps([blockedRow(), blockedRow()], {
      render: undefined,
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary).toMatchObject({ challenge: 2, rendered: 0, renders_skipped: 2 });
  });

  it("caps renders per run and leaves the rest on their tier-1 outcome", async () => {
    const { deps } = makeDeps([blockedRow(), blockedRow(), blockedRow()], {
      config: makeConfig({ maxRenders: 1 }),
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ rendered: 1, imported: 1, challenge: 2, renders_skipped: 2 });
  });

  it("renders without consuming the paid-action budget", async () => {
    // A render costs wall clock, not money; only submits are paid actions.
    const { deps } = makeDeps([blockedRow(), blockedRow()], {
      config: makeConfig({ maxPaidActions: 2 }),
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
    });

    const summary = await runAgent({ execute: true }, deps);

    expect(summary).toMatchObject({ rendered: 2, imported: 2, deferred: 0 });
  });

  it("performs zero renders in a dry run", async () => {
    const { deps } = makeDeps([blockedRow(), blockedRow()], {
      extract: vi.fn(async (): Promise<ExtractOutcome> => ({ kind: "challenge", detail: "403" })),
    });

    await runAgent({ execute: false }, deps);

    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("keeps YouTube in the manual queue without invoking any extraction route", async () => {
    const youtube = blockedRow({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const { deps } = makeDeps([youtube]);

    const summary = await runAgent({ execute: true }, deps);

    expect(deps.reddit).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(summary.manual).toBe(1);
    expect(summary.rows[0]).toMatchObject({ route: "youtube", outcome: "manual" });
  });
});
