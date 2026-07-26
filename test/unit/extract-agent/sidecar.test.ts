import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  emptySidecar,
  loadSidecar,
  recordAttempt,
  saveSidecar,
  shouldAttempt,
  type SidecarState,
} from "../../../scripts/extract-agent-lib/sidecar";
import { makeRow } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const deps = { now: () => NOW, maxAttempts: 3 };

async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "extract-agent-sidecar-"));
  return join(dir, "nested", "state.json");
}

describe("sidecar load/save", () => {
  it("loads a missing file as the empty state", async () => {
    const warn = vi.fn();
    const state = await loadSidecar(await freshPath(), { warn });
    expect(state).toEqual({ version: 1, readings: {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the file exists but cannot be read (a silent empty state re-arms backed-off rows)", async () => {
    // A directory at the state path fails readFile with EISDIR, not ENOENT —
    // stands in for EACCES/EIO, which can't be provoked portably.
    const path = await mkdtemp(join(tmpdir(), "extract-agent-sidecar-"));
    const warn = vi.fn();
    const state = await loadSidecar(path, { warn });
    expect(state).toEqual({ version: 1, readings: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/unreadable/);
  });

  it("treats a corrupted file as empty with a warning (loss-safe invariant)", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "extract-agent-sidecar-")), "state.json");
    await writeFile(path, "{not json", "utf-8");
    const warn = vi.fn();
    const state = await loadSidecar(path, { warn });
    expect(state).toEqual({ version: 1, readings: {} });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats an unknown version as empty with a warning", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "extract-agent-sidecar-")), "state.json");
    await writeFile(path, JSON.stringify({ version: 99, readings: {} }), "utf-8");
    const warn = vi.fn();
    const state = await loadSidecar(path, { warn });
    expect(state).toEqual({ version: 1, readings: {} });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats a sidecar with malformed reading entries as empty with a warning", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "extract-agent-sidecar-")), "state.json");
    await writeFile(path, JSON.stringify({ version: 1, readings: { rd_x: null } }), "utf-8");
    const warn = vi.fn();
    const state = await loadSidecar(path, { warn });
    expect(state).toEqual({ version: 1, readings: {} });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("saves atomically (creates parent dirs, leaves no .tmp sibling) and round-trips", async () => {
    const path = await freshPath();
    const row = makeRow();
    const state = recordAttempt(emptySidecar(), row, "error", deps);
    await saveSidecar(path, state);

    const reloaded = await loadSidecar(path, { warn: vi.fn() });
    expect(reloaded).toEqual(state);
    const siblings = await readdir(join(path, ".."));
    expect(siblings).toEqual(["state.json"]);
    expect(JSON.parse(await readFile(path, "utf-8")).version).toBe(1);
  });

  it("round-trips a terminal manual outcome", async () => {
    const path = await freshPath();
    const row = makeRow();
    const state = recordAttempt(emptySidecar(), row, "manual", deps);

    await saveSidecar(path, state);

    expect(await loadSidecar(path, { warn: vi.fn() })).toEqual(state);
  });
});

describe("recordAttempt", () => {
  it("records a terminal manual outcome without a retry deadline", () => {
    const row = makeRow();
    const state = recordAttempt(emptySidecar(), row, "manual", deps);

    expect(state.readings[row.id]).toEqual({
      attempts: 1,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: row.updated_at,
      last_outcome: "manual",
      given_up: true,
    });
  });

  it("doubles the backoff per failure and gives up at maxAttempts", () => {
    const row = makeRow();
    let state: SidecarState = emptySidecar();

    state = recordAttempt(state, row, "error", deps);
    expect(state.readings[row.id]).toMatchObject({
      attempts: 1,
      last_outcome: "error",
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: row.updated_at,
      next_eligible_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      given_up: false,
    });

    state = recordAttempt(state, row, "challenge", deps);
    expect(state.readings[row.id]).toMatchObject({
      attempts: 2,
      next_eligible_at: new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      given_up: false,
    });

    state = recordAttempt(state, row, "gate_rejected", deps);
    expect(state.readings[row.id]).toMatchObject({ attempts: 3, given_up: true });
  });

  it("resets attempts and backoff on a successful import", () => {
    const row = makeRow();
    let state = recordAttempt(emptySidecar(), row, "error", deps);
    state = recordAttempt(state, row, "imported", deps);
    expect(state.readings[row.id]).toMatchObject({
      attempts: 0,
      last_outcome: "imported",
      last_manifest_updated_at: row.updated_at,
      given_up: false,
    });
    expect(state.readings[row.id]?.next_eligible_at).toBeUndefined();
  });

  it("restarts the attempt count when the manifest moved since the last attempt", () => {
    const stale = makeRow({ updated_at: "2026-07-01T00:00:00.000Z" });
    let state = recordAttempt(emptySidecar(), stale, "error", deps);
    state = recordAttempt(state, stale, "error", deps);
    expect(state.readings[stale.id]?.attempts).toBe(2);

    const moved = { ...stale, updated_at: "2026-07-10T00:00:00.000Z" };
    state = recordAttempt(state, moved, "error", deps);
    expect(state.readings[moved.id]).toMatchObject({ attempts: 1, given_up: false });
  });

  it("counts a legacy row gaining updated_at as manifest movement", () => {
    // updated_at is optional on a list row. A legacy row records no baseline,
    // so requiring both timestamps would keep the entry suppressed forever even
    // after the Worker republishes the manifest and starts stamping one.
    const legacy = makeRow({ updated_at: undefined });
    let state = recordAttempt(emptySidecar(), legacy, "error", deps);
    state = recordAttempt(state, legacy, "error", deps);
    expect(state.readings[legacy.id]?.attempts).toBe(2);

    const republished = { ...legacy, updated_at: "2026-07-10T00:00:00.000Z" };
    state = recordAttempt(state, republished, "error", deps);
    expect(state.readings[republished.id]).toMatchObject({ attempts: 1, given_up: false });
  });
});

describe("shouldAttempt", () => {
  const row = makeRow({ updated_at: "2026-07-02T00:00:00.000Z" });

  it("keeps a manual outcome terminal until the manifest moves", () => {
    const entry = recordAttempt(emptySidecar(), row, "manual", deps).readings[row.id];
    expect(shouldAttempt(entry, row, deps).ok).toBe(false);

    const moved = { ...row, updated_at: "2026-07-03T00:00:00.000Z" };
    expect(shouldAttempt(entry, moved, deps)).toEqual({ ok: true });
  });

  it("allows a row with no sidecar entry", () => {
    expect(shouldAttempt(undefined, row, deps)).toEqual({ ok: true });
  });

  it("allows a given-up row once the Worker has acted since (newer manifest)", () => {
    const givenUp = {
      attempts: 3,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: "2026-07-01T00:00:00.000Z",
      last_outcome: "error" as const,
      given_up: true,
    };
    expect(shouldAttempt(givenUp, row, deps).ok).toBe(true);
  });

  it("honors given_up when the manifest is unchanged", () => {
    const givenUp = {
      attempts: 3,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: row.updated_at!,
      last_outcome: "error" as const,
      given_up: true,
    };
    const verdict = shouldAttempt(givenUp, row, deps);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/given up/i);
  });

  it("honors backoff when the manifest is unchanged", () => {
    const backedOff = {
      attempts: 1,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: row.updated_at!,
      last_outcome: "error" as const,
      next_eligible_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      given_up: false,
    };
    expect(shouldAttempt(backedOff, row, deps).ok).toBe(false);
    const later = { ...deps, now: () => new Date(NOW.getTime() + 61 * 60 * 1000) };
    expect(shouldAttempt(backedOff, row, later).ok).toBe(true);
  });

  it("treats an older manifest (clock skew / list rebuild) like an unchanged one", () => {
    const entry = {
      attempts: 3,
      last_attempt_at: NOW.toISOString(),
      last_manifest_updated_at: "2026-07-05T00:00:00.000Z",
      last_outcome: "error" as const,
      given_up: true,
    };
    expect(shouldAttempt(entry, row, deps).ok).toBe(false);
  });
});
