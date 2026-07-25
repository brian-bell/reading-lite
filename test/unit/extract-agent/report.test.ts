import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendRunLine, buildRunLine, pingHealthcheck, type RunLine } from "../../../scripts/extract-agent-lib/report";
import type { PerRowOutcome, RunSummary } from "../../../scripts/extract-agent-lib/run";
import { makeConfig } from "./helpers";

const STARTED = new Date("2026-07-15T12:00:00.000Z");
const FINISHED = new Date("2026-07-15T12:00:04.500Z");

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    dry_run: false,
    scanned: 0,
    eligible: 0,
    ineligible: 0,
    out_of_scope: 0,
    never: 0,
    manual: 0,
    backed_off: 0,
    attempted: 0,
    imported: 0,
    gate_rejected: 0,
    challenge: 0,
    dead: 0,
    no_article: 0,
    errors: 0,
    deferred: 0,
    rendered: 0,
    rendered_failed: 0,
    renders_skipped: 0,
    rows: [],
    ...overrides,
  };
}

function row(overrides: Partial<PerRowOutcome>): PerRowOutcome {
  return { id: "rd_1", url: "https://example.com/a", decision: "attempt", why: "why", ...overrides };
}

function okLine(overrides: Partial<Parameters<typeof buildRunLine>[0]> = {}): RunLine {
  return buildRunLine({
    status: "ok",
    args: { execute: true },
    config: makeConfig(),
    summary: summary(),
    startedAt: STARTED,
    finishedAt: FINISHED,
    runId: "run_1",
    host: "box",
    pid: 4242,
    ...overrides,
  });
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "extract-agent-report-"));
}

describe("buildRunLine", () => {
  it("describes a completed run", () => {
    const line = okLine({ args: { execute: true, limit: 5, only: "rd_9" } });
    expect(line).toMatchObject({
      v: 1,
      run_id: "run_1",
      status: "ok",
      dry_run: false,
      started_at: "2026-07-15T12:00:00.000Z",
      finished_at: "2026-07-15T12:00:04.500Z",
      duration_ms: 4500,
      host: "box",
      pid: 4242,
      api_base: "https://reading.example",
      args: { execute: true, limit: 5, only: "rd_9" },
      caps: { max_paid_actions: 25, max_attempts: 3 },
    });
  });

  it("derives counts from the summary's own numeric fields", () => {
    const s = summary({ scanned: 7, imported: 2 });
    const expected = Object.entries(s)
      .filter(([, value]) => typeof value === "number")
      .map(([key]) => key);
    expect(Object.keys(okLine({ summary: s }).counts!)).toEqual(expected);
    expect(okLine({ summary: s }).counts).toMatchObject({ scanned: 7, imported: 2 });
  });

  it("carries the tier-2 counters, so a render-heavy run explains itself in the log", () => {
    const line = okLine({ summary: summary({ rendered: 3, rendered_failed: 1, renders_skipped: 2 }) });

    expect(line.counts).toMatchObject({ rendered: 3, rendered_failed: 1, renders_skipped: 2 });
    // Without the cap on the line, a skipped count months later cannot be told
    // apart from a box that simply had no browser.
    expect(line.caps).toMatchObject({ max_renders: 10 });
  });

  it("keeps the tier that produced a row's outcome", () => {
    const line = okLine({
      summary: summary({ rows: [row({ decision: "attempt", outcome: "imported", tier: "headless" })] }),
    });

    expect(line.rows?.[0]).toMatchObject({ tier: "headless" });
  });

  it("marks a dry run", () => {
    const line = okLine({ args: { execute: false }, summary: summary({ dry_run: true }) });
    expect(line.dry_run).toBe(true);
    expect(line.args.execute).toBe(false);
  });

  it("serializes only rows that acted or need a human, leaving counts complete", () => {
    const rows: PerRowOutcome[] = [
      ...Array.from({ length: 500 }, (_, i) => row({ id: `rd_i${i}`, decision: "ineligible" })),
      row({ id: "rd_never", decision: "never" }),
      row({ id: "rd_oos", decision: "out_of_scope" }),
      row({ id: "rd_a1", decision: "attempt", outcome: "imported" }),
      row({ id: "rd_a2", decision: "attempt", outcome: "deferred" }),
      row({ id: "rd_m", decision: "manual", outcome: "manual" }),
      row({ id: "rd_b", decision: "backed_off" }),
    ];
    const line = okLine({ summary: summary({ scanned: 506, ineligible: 500, rows }) });
    expect(line.rows!.map((r) => r.id)).toEqual(["rd_a1", "rd_a2", "rd_m", "rd_b"]);
    expect(line.counts!.ineligible).toBe(500);
    expect(line.counts!.scanned).toBe(506);
    expect(JSON.stringify(line).length).toBeLessThan(8 * 1024);
  });

  it("caps the rows on one line and counts the overflow", () => {
    const rows = Array.from({ length: 250 }, (_, i) => row({ id: `rd_m${i}`, decision: "manual", outcome: "manual" }));
    const line = okLine({ summary: summary({ scanned: 250, manual: 250, rows }) });
    expect(line.rows).toHaveLength(200);
    expect(line.rows_omitted).toBe(50);
    expect(line.counts!.manual).toBe(250);
  });

  it("clamps a row's free-text fields so one line stays inside the log ceiling", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({
        id: `rd_a${i}`,
        url: `https://example.com/${"q".repeat(4000)}`,
        why: "w".repeat(4000),
        outcome: "error",
        detail: "d".repeat(4000),
      }),
    );
    const line = okLine({ summary: summary({ rows }) });
    expect(line.rows![0]!.url).toHaveLength(500);
    expect(line.rows![0]!.why).toHaveLength(200);
    expect(line.rows![0]!.detail).toHaveLength(300);
    expect(JSON.stringify(line).length).toBeLessThan(256 * 1024);
  });

  it("omits the overflow marker when every reportable row fits", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `rd_m${i}`, decision: "manual" }));
    expect(okLine({ summary: summary({ rows }) }).rows_omitted).toBeUndefined();
  });

  it("never serializes the API token", () => {
    const config = makeConfig({ api: { base: "https://reading.example", token: "tok_super_secret" } });
    expect(JSON.stringify(okLine({ config }))).not.toContain("tok_super_secret");
  });

  it("describes a crashed run with a truncated error and no counts", () => {
    const error = new Error("x".repeat(900));
    error.name = "AgentFatalError";
    const line = buildRunLine({
      status: "crashed",
      args: { execute: true },
      config: makeConfig(),
      error,
      startedAt: STARTED,
      finishedAt: FINISHED,
      runId: "run_1",
      host: "box",
      pid: 4242,
    });
    expect(line.status).toBe("crashed");
    expect(line.error).toEqual({ name: "AgentFatalError", message: "x".repeat(500) });
    expect(line.counts).toBeUndefined();
    expect(line.rows).toBeUndefined();
  });

  it("describes a non-Error crash", () => {
    const line = buildRunLine({
      status: "crashed",
      args: { execute: false },
      config: makeConfig(),
      error: "boom",
      startedAt: STARTED,
      finishedAt: FINISHED,
      runId: "run_1",
      host: "box",
      pid: 4242,
    });
    expect(line.error).toEqual({ name: "Error", message: "boom" });
  });
});

describe("appendRunLine", () => {
  it("creates parent directories and appends one line per call", async () => {
    const path = join(await freshDir(), "nested", "runs.jsonl");
    await appendRunLine(path, okLine(), { maxBytes: 1024 * 1024 });
    await appendRunLine(path, okLine({ runId: "run_2" }), { maxBytes: 1024 * 1024 });
    const lines = (await readFile(path, "utf-8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect((await stat(path)).mode & 0o077).toBe(0); // owner-only: the log holds every URL touched
    expect(lines.map((l) => (JSON.parse(l) as RunLine).run_id)).toEqual(["run_1", "run_2"]);
  });

  it("rotates an over-size log to .1, replacing any previous .1", async () => {
    const path = join(await freshDir(), "runs.jsonl");
    await writeFile(`${path}.1`, "stale\n", "utf-8");
    await writeFile(path, `${"x".repeat(300)}\n`, "utf-8");
    await appendRunLine(path, okLine(), { maxBytes: 200 });
    const rotated = await readFile(`${path}.1`, "utf-8");
    expect(rotated).toMatch(/^x{300}\n$/);
    const current = (await readFile(path, "utf-8")).trimEnd().split("\n");
    expect(current).toHaveLength(1);
    expect((JSON.parse(current[0]!) as RunLine).run_id).toBe("run_1");
  });

  it("rotates before an append that would cross the ceiling, so neither file exceeds it", async () => {
    const path = join(await freshDir(), "runs.jsonl");
    const cap = 700;
    for (const runId of ["run_1", "run_2", "run_3"]) {
      await appendRunLine(path, okLine({ runId }), { maxBytes: cap });
    }
    expect((await stat(path)).size).toBeLessThanOrEqual(cap);
    expect((await stat(`${path}.1`)).size).toBeLessThanOrEqual(cap);
  });

  it("does not rotate a log under the ceiling", async () => {
    const path = join(await freshDir(), "runs.jsonl");
    await appendRunLine(path, okLine(), { maxBytes: 1024 * 1024 });
    await appendRunLine(path, okLine({ runId: "run_2" }), { maxBytes: 1024 * 1024 });
    await expect(stat(`${path}.1`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops rows until the record fits the configured cap, counting what it dropped", async () => {
    const path = join(await freshDir(), "runs.jsonl");
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: `rd_a${i}`, outcome: "imported" }));
    await appendRunLine(path, okLine({ summary: summary({ rows }) }), { maxBytes: 1024 });

    const written = (await readFile(path, "utf-8")).trimEnd();
    expect(Buffer.byteLength(written, "utf-8")).toBeLessThanOrEqual(1024);
    const line = JSON.parse(written) as RunLine;
    expect(line.rows!.length + line.rows_omitted!).toBe(40);
    expect(line.counts).toBeDefined();
  });

  it("still writes the record when even a row-less line exceeds the cap", async () => {
    const path = join(await freshDir(), "runs.jsonl");
    await appendRunLine(path, okLine({ summary: summary({ rows: [row({ outcome: "imported" })] }) }), { maxBytes: 10 });

    const line = JSON.parse((await readFile(path, "utf-8")).trimEnd()) as RunLine;
    expect(line.status).toBe("ok");
    expect(line.rows).toEqual([]);
    expect(line.rows_omitted).toBe(1);
  });

  it("propagates a write failure so the caller can fail the run", async () => {
    // A regular file where a parent directory belongs: mkdir fails with ENOTDIR
    // on every platform. (Pointing the log at a directory is not portable — on
    // Linux the rotation rename would happily rename the directory itself.)
    const blocker = join(await freshDir(), "not-a-directory");
    await writeFile(blocker, "", "utf-8");
    await expect(appendRunLine(join(blocker, "runs.jsonl"), okLine(), { maxBytes: 1024 })).rejects.toThrow();
  });
});

describe("pingHealthcheck", () => {
  function deps(fetchImpl: typeof fetch) {
    const warn = vi.fn();
    return { warn, deps: { fetch: fetchImpl, warn } };
  }

  it("fires exactly one GET at the configured url, with an abort signal", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const { warn, deps: d } = deps(fetchMock as unknown as typeof fetch);
    await pingHealthcheck("https://hc.example/ping", d);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hc.example/ping");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });

  it("scrubs the url out of the exception text too", async () => {
    const url = "https://hc.example/hc-token-9f3c";
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    });
    const { warn, deps: d } = deps(fetchMock as unknown as typeof fetch);
    await pingHealthcheck(url, d);
    expect(warn.mock.calls[0]![0]).not.toContain("hc-token-9f3c");
  });

  it("does nothing when no url is configured", async () => {
    const fetchMock = vi.fn();
    const { warn, deps: d } = deps(fetchMock as unknown as typeof fetch);
    await pingHealthcheck(undefined, d);
    await pingHealthcheck("", d);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns but never throws on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const { warn, deps: d } = deps(fetchMock as unknown as typeof fetch);
    await expect(pingHealthcheck("https://hc.example/ping", d)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/500/);
    // The token in a healthchecks.io-style path must not reach stderr.
    expect(warn.mock.calls[0]![0]).not.toContain("/ping");
  });

  it("warns but never throws when the request fails outright", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND hc.example");
    });
    const { warn, deps: d } = deps(fetchMock as unknown as typeof fetch);
    await expect(pingHealthcheck("https://hc.example/ping", d)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/ENOTFOUND/);
    expect(warn.mock.calls[0]![0]).not.toContain("/ping");
  });
});
