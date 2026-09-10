import { describe, expect, it } from "vitest";
import { deployReleaseCommand } from "../../../scripts/ops-lib/commands/deploy-release";
import { stagingTokenRevocationCommand } from "../../../scripts/ops-lib/commands/staging-token-revocation";
import { EvidenceSchema } from "../../../scripts/lib/release-evidence";

const sha = "a".repeat(40);
const provenance = { commit: sha, config_sha256: "b".repeat(64), version_id: "version-1", effective_config_sha256: "c".repeat(64) };
const time = "2026-09-06T12:00:00.000Z";
const io = { stdout() {}, stderr() {} };
const args = ["--tenant", "usr_fixture", "--release-sha", sha, "--output", "/evidence/run", "--execute"];

function drill(failStep?: string) {
  const calls: string[] = [];
  const reports: unknown[] = [];
  let revoked = false;
  const deps = {
    io, now: () => time, newId: () => "unique-run", provenance: async () => provenance,
    reserve: async () => {}, save: async (_: string, report: unknown) => { reports.push(report); },
    session: () => "__Host-session=SECRET_COOKIE",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const bearer = new Headers(init?.headers).has("authorization");
      const step = method === "POST" ? "create" : method === "DELETE" ? "revoke" :
        url.endsWith("/tokens") ? "list" : bearer ? revoked ? "rejected" : "baseline" : "session";
      calls.push(step);
      if (step === failStep) throw new Error("SECRET_ERROR");
      if (step === "create") return Response.json({ id: "tok_fixture", token: "SECRET_TOKEN" }, { status: 201 });
      if (step === "revoke") { revoked = true; return Response.json({ ok: true }); }
      if (step === "list") return Response.json({ tokens: [{ id: "tok_fixture", name: "release-drill-unique-run", usable: !revoked, revoked_at_ms: revoked ? 123 : null }] });
      if (step === "rejected") return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ tenant_id: "usr_fixture", principal: bearer ? "api_token" : "session", csrf_token: "SECRET_CSRF" });
    }) as typeof fetch,
  };
  return { calls, reports, deps };
}

async function successfulEvidence() {
  const d = drill();
  expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(0);
  return EvidenceSchema.parse(d.reports[0]);
}

function release(report: unknown) {
  const effects: string[] = [];
  const deps = {
    io, read: async () => JSON.stringify(report), provenance: async () => provenance,
    wipe: async () => { effects.push("wipe"); return 0; },
    deploy: async () => { effects.push("deploy"); return 0; },
  };
  return { effects, deps };
}
const releaseArgs = ["--check", "token-revocation", "--evidence", "run/result.json", "--release-sha", sha, "--execute"];

describe("staging token revocation", () => {
  it("proves a usable token becomes rejected and retains sanitized evidence", async () => {
    const d = drill();
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(0);
    const report = EvidenceSchema.parse(d.reports[0]);
    expect(report.exit_code).toBe(0);
    expect(report.cleanup).toBe("revoked");
    expect(d.calls).toContain("baseline");
    expect(d.calls).toContain("rejected");
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
  it("retains a failed baseline and cleans up the token", async () => {
    const d = drill("baseline");
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(1);
    expect(d.calls).toContain("revoke");
    expect(d.reports[0]).toMatchObject({ exit_code: 1, cleanup: "revoked" });
    expect(JSON.stringify(d.reports)).not.toContain("SECRET");
  });
  it("blocks success when cleanup cannot confirm revocation", async () => {
    const d = drill("list");
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(1);
    expect(d.reports[0]).toMatchObject({ exit_code: 1, cleanup: "unresolved" });
  });
  it("recovers the uniquely named token after an ambiguous create response", async () => {
    const d = drill("create");
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(1);
    expect(d.calls).toContain("revoke");
    expect(d.reports[0]).toMatchObject({ exit_code: 1, cleanup: "revoked" });
  });
  it("fails when staging changes during the drill", async () => {
    const d = drill();
    let reads = 0;
    d.deps.provenance = async () => ({ ...provenance, version_id: ++reads === 1 ? "version-1" : "version-2" });
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(1);
    expect(d.reports[0]).toMatchObject({ provenance_unchanged: false, cleanup: "revoked" });
  });
  it("does not create a token for the wrong tenant", async () => {
    const d = drill();
    const fetch = d.deps.fetch;
    d.deps.fetch = (async (input, init) => {
      const response = await fetch(input, init);
      return String(input).endsWith("/whoami") ? Response.json({ principal: "session", tenant_id: "usr_other", csrf_token: "SECRET_CSRF" }) : response;
    }) as typeof fetch;
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(1);
    expect(d.calls).toEqual(["session"]);
    expect(d.reports[0]).toMatchObject({ cleanup: "not-created", failure_stage: "session" });
  });
  it("retains provenance failures without calling the app", async () => {
    const d = drill();
    d.deps.provenance = async () => { throw new Error("SECRET_METADATA"); };
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(1);
    expect(d.calls).toEqual([]);
    expect(d.reports[0]).toMatchObject({ exit_code: 1, provenance: null });
    expect(JSON.stringify(d.reports)).not.toContain("SECRET");
  });
  it("uses fixed-origin requests with redirect refusal and bounded timeouts", async () => {
    const d = drill();
    const fetch = d.deps.fetch;
    d.deps.fetch = (async (input, init) => {
      expect(String(input)).toMatch(/^https:\/\/staging\.readinglite\.ai\/api\//);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      return fetch(input, init);
    }) as typeof fetch;
    expect(await stagingTokenRevocationCommand.run(args, d.deps)).toBe(0);
  });
  it("does no remote work or durable writing in plan mode", async () => {
    const d = drill();
    d.deps.reserve = async () => { throw new Error("write"); };
    d.deps.provenance = async () => { throw new Error("remote read"); };
    expect(await stagingTokenRevocationCommand.run(args.filter(x => x !== "--execute"), d.deps)).toBe(0);
    expect(d.calls).toEqual([]);
  });
  it("does no HTTP work if the evidence directory already exists", async () => {
    const d = drill();
    d.deps.reserve = async () => { throw new Error("exists"); };
    await expect(stagingTokenRevocationCommand.run(args, d.deps)).rejects.toThrow();
    expect(d.calls).toEqual([]);
  });
});

describe("explicit operator release gate (production effects trapped)", () => {
  it.each(["missing", "malformed", "failed", "incomplete", "commit", "config", "version", "cleanup", "baseline"])("refuses %s evidence before production effects", async kind => {
    const report = await successfulEvidence();
    if (kind === "failed") report.exit_code = 1;
    if (kind === "incomplete") report.checks.pop();
    if (kind === "commit") report.provenance!.commit = "d".repeat(40);
    if (kind === "config") report.provenance!.config_sha256 = "d".repeat(64);
    if (kind === "version") report.provenance!.version_id = "different";
    if (kind === "cleanup") report.cleanup = "unresolved";
    if (kind === "baseline") report.checks.find(c => c.step === "baseline")!.status = 401;
    const r = release(report);
    if (kind === "missing") r.deps.read = async () => { throw new Error("ENOENT"); };
    if (kind === "malformed") r.deps.read = async () => "{";
    expect(await deployReleaseCommand.run(releaseArgs, r.deps)).not.toBe(0);
    expect(r.effects).toEqual([]);
  });
  it("runs wipe before deploy and preserves a deployment failure code", async () => {
    const r = release(await successfulEvidence());
    r.deps.deploy = async () => { r.effects.push("deploy"); return 7; };
    expect(await deployReleaseCommand.run(releaseArgs, r.deps)).toBe(7);
    expect(r.effects).toEqual(["wipe", "deploy"]);
  });
  it("never deploys after a wipe refusal", async () => {
    const r = release(await successfulEvidence());
    r.deps.wipe = async () => { r.effects.push("wipe"); return 1; };
    expect(await deployReleaseCommand.run(releaseArgs, r.deps)).toBe(1);
    expect(r.effects).toEqual(["wipe"]);
  });
  it("plan mode validates evidence without production effects", async () => {
    const r = release(await successfulEvidence());
    expect(await deployReleaseCommand.run(releaseArgs.filter(x => x !== "--execute"), r.deps)).toBe(0);
    expect(r.effects).toEqual([]);
  });
});
