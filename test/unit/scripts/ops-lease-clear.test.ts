// `ops system lease-clear` — fenced, idempotent operator recovery for a dead
// attempt's orphaned in-flight lease rows (#256). The seams under test are the
// observation and the compare-and-set clear; the invariants are: plan mode
// never clears, refused rows (not overdue / not in flight) block the whole
// invocation, execute re-observes before clearing, and a "changed" refusal is
// the live-holder race made safe. Fences and credentials never appear in any
// output this command can produce.

import { describe, expect, it } from "vitest";
import { systemLeaseClearCommand, type LeaseClearDeps } from "../../../scripts/ops-lib/commands/system-lease-clear";
import type { LeaseClearResponse, LeaseObservation } from "../../../scripts/system-lib/lease-clear";
import { UsageError } from "../../../scripts/ops-lib/contract";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const OBSERVED_AT = Date.parse("2026-09-10T00:00:00.000Z");

function observation(
  rows: { tenant?: { expiresAtMs: number; inFlight: boolean } | null; global?: { expiresAtMs: number; inFlight: boolean } | null },
): LeaseObservation {
  return {
    observedAtMs: OBSERVED_AT,
    tenantRow:
      rows.tenant === undefined || rows.tenant === null
        ? null
        : { ...rows.tenant, heartbeatOverdueMs: rows.tenant.inFlight && rows.tenant.expiresAtMs < OBSERVED_AT ? OBSERVED_AT - rows.tenant.expiresAtMs : 0 },
    globalRow:
      rows.global === undefined || rows.global === null
        ? null
        : { ...rows.global, heartbeatOverdueMs: rows.global.inFlight && rows.global.expiresAtMs < OBSERVED_AT ? OBSERVED_AT - rows.global.expiresAtMs : 0 },
    complete: true,
  };
}

function harness(opts: {
  observations: LeaseObservation[];
  outcomes?: LeaseClearResponse[];
  clears?: Array<{ tenant: number | null; global: number | null }>;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const clearCalls: Array<{ tenant: number | null; global: number | null }> = [];
  const pending = [...opts.observations];
  const outcomes = [...(opts.outcomes ?? [])];
  const deps: LeaseClearDeps = {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    observe: async () => {
      if (pending.length === 0) throw new Error("unavailable");
      return pending.shift()!;
    },
    clear: async (_env, _tenant, _attempt, expected) => {
      clearCalls.push(expected);
      if (outcomes.length === 0) throw new Error("unavailable");
      return outcomes.shift()!;
    },
  };
  return { deps, out, err, clearCalls };
}

const CLEARED: LeaseClearResponse = {
  ok: true,
  tenant: { ok: true, cleared: true },
  global: { ok: true, cleared: true },
};

const OVERDUE = { expiresAtMs: OBSERVED_AT - 300_000, inFlight: true };
const FRESH = { expiresAtMs: OBSERVED_AT + 300_000, inFlight: true };
const PARKED = { expiresAtMs: OBSERVED_AT - 300_000, inFlight: false };

describe("ops system lease-clear", () => {
  it("plans without clearing when both rows are overdue orphans", async () => {
    const h = harness({ observations: [observation({ tenant: OVERDUE, global: OVERDUE })] });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_orphan"],
      h.deps,
    );
    expect(exit).toBe(0);
    expect(h.clearCalls).toHaveLength(0);
    expect(h.out.join("\n")).toContain('"verdict": "clear"');
    expect(h.out.join("\n")).toContain("Plan only");
  });

  it("execute re-observes and clears both sides with the fresh snapshot", async () => {
    const h = harness({
      observations: [observation({ tenant: OVERDUE, global: OVERDUE })],
      outcomes: [CLEARED],
    });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_orphan", "--execute"],
      h.deps,
    );
    expect(exit).toBe(0);
    expect(h.clearCalls).toEqual([{ tenant: OVERDUE.expiresAtMs, global: OVERDUE.expiresAtMs }]);
    expect(h.out.join("\n")).toContain("tenant: cleared");
    expect(h.out.join("\n")).toContain("global: cleared");
  });

  it("reports nothing-to-clear as success without touching the guards", async () => {
    const h = harness({ observations: [observation({ tenant: null, global: null })] });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_gone", "--execute"],
      h.deps,
    );
    expect(exit).toBe(0);
    expect(h.clearCalls).toHaveLength(0);
    expect(h.out.join("\n")).toContain("Nothing to clear");
  });

  it("refuses a not-yet-overdue row and clears nothing, in plan and execute", async () => {
    const h = harness({
      observations: [observation({ tenant: FRESH, global: OVERDUE }), observation({ tenant: FRESH, global: OVERDUE })],
    });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_live", "--execute"],
      h.deps,
    );
    expect(exit).toBe(1);
    expect(h.clearCalls).toHaveLength(0);
    expect(h.err.join("\n")).toContain("tenant lease is not overdue");
  });

  it("refuses a paused row — the expiry sweep owns it", async () => {
    const h = harness({ observations: [observation({ tenant: PARKED, global: null })] });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_parked"],
      h.deps,
    );
    expect(exit).toBe(1);
    expect(h.err.join("\n")).toContain("paused");
  });

  it("re-observes on execute instead of reusing a previous plan", async () => {
    const h = harness({
      observations: [
        observation({ tenant: OVERDUE, global: OVERDUE }),
        // The holder renewed between the plan and the fresh observation.
        observation({ tenant: FRESH, global: OVERDUE }),
      ],
    });
    expect(await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_race"], h.deps,
    )).toBe(0);
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_race", "--execute"],
      h.deps,
    );
    expect(exit).toBe(1);
    expect(h.clearCalls).toHaveLength(0);
    expect(h.err.join("\n")).toContain("not overdue");
  });

  it("surfaces a DO-side changed refusal without claiming success", async () => {
    const h = harness({
      observations: [observation({ tenant: OVERDUE, global: OVERDUE })],
      outcomes: [
        { ok: false, tenant: { ok: false, reason: "changed" }, global: { ok: false, reason: "peer_refused" } },
      ],
    });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_moved", "--execute"],
      h.deps,
    );
    expect(exit).toBe(1);
    expect(h.err.join("\n")).toContain('refused (changed)');
  });

  it("converges on a re-run: already-absent sides are success", async () => {
    const h = harness({
      observations: [observation({ tenant: OVERDUE, global: null })],
      outcomes: [{ ok: true, tenant: { ok: true, cleared: false }, global: { ok: true, cleared: false } }],
    });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_rerun", "--execute"],
      h.deps,
    );
    expect(exit).toBe(0);
    expect(h.clearCalls).toEqual([{ tenant: OVERDUE.expiresAtMs, global: null }]);
    expect(h.out.join("\n")).toContain("tenant: already absent");
  });

  it("exits 1 on an unavailable observation without printing a zero state", async () => {
    const h = harness({ observations: [] });
    const exit = await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_blind"],
      h.deps,
    );
    expect(exit).toBe(1);
    expect(h.err.join("\n")).toContain("unavailable");
    expect(h.clearCalls).toHaveLength(0);
  });

  it("never prints fences or credentials — only ages, states, and verdicts", async () => {
    const h = harness({ observations: [observation({ tenant: OVERDUE, global: OVERDUE })] });
    await systemLeaseClearCommand.run(
      ["--env", "staging", "--tenant", TENANT, "--attempt", "at_redact"],
      h.deps,
    );
    const all = [...h.out, ...h.err].join("\n");
    expect(all).not.toContain("fence");
    expect(all).not.toContain("token");
    expect(all).toContain("heartbeatOverdueMs");
  });

  it("rejects malformed usage", async () => {
    const h = harness({ observations: [] });
    await expect(
      systemLeaseClearCommand.run(["--env", "staging", "--attempt", "at_x"], h.deps),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      systemLeaseClearCommand.run(["--env", "staging", "--tenant", "not-a-tenant", "--attempt", "at_x"], h.deps),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      systemLeaseClearCommand.run(["--tenant", TENANT, "--attempt", "at_x"], h.deps),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
