// Registry completeness: every supported operator workflow must have exactly
// one native route with a safety classification, a working help path, and the
// shared exit contract — and no retired interface may linger. Adding or
// removing a workflow means updating SUPPORTED_WORKFLOWS alongside the
// registry; this test fails when either side drifts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../../scripts/ops-lib/cli";
import type { CommandIo } from "../../../scripts/ops-lib/contract";
import { defaultRegistry } from "../../../scripts/ops-lib/registry";
import {
  assertPolicyCommandBehavior,
  assertPolicyCommandContract,
  policyContractViolations,
} from "../../../scripts/ops-lib/policy-contract";
import { UsageError } from "../../../scripts/ops-lib/contract";

// group -> commands. The complete supported operator surface.
const SUPPORTED_WORKFLOWS: Record<string, string[]> = {
  corpus: [
    "audit",
    "recover",
    "ingest",
    "drop",
    "sweep",
    "delete-orphans",
    "backfill-similarity",
    "backfill-vectors",
    "normalize-tags",
    "rebuild-list",
  ],
  reading: ["submit"],
  import: ["markdown", "bookmarks", "reddit", "youtube"],
  "reading-list": ["check", "process"],
  deploy: ["worker", "web"],
  staging: ["setup", "teardown", "smoke"],
  founder: ["bootstrap"],
  extract: ["agent", "probe"],
  eval: ["summarizer"],
};

const repoRoot = path.resolve(__dirname, "../../..");

function captureIo(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

describe("ops registry completeness", () => {
  it("registers exactly the supported workflows, each with a safety classification", () => {
    const expected = Object.entries(SUPPORTED_WORKFLOWS)
      .flatMap(([group, names]) => names.map((name) => `${group} ${name}`))
      .sort();
    const registered = defaultRegistry.commands.map((c) => `${c.group} ${c.name}`).sort();
    expect(registered).toEqual(expected);
    for (const cmd of defaultRegistry.commands) {
      expect(["read-only", "plan-first"]).toContain(cmd.safety);
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(cmd.helpText.length).toBeGreaterThan(0);
    }
  });

  it("has a group entry for every command and no empty groups", () => {
    const groupNames = defaultRegistry.groups.map((g) => g.name);
    expect(new Set(groupNames).size).toBe(groupNames.length);
    expect(groupNames.sort()).toEqual(Object.keys(SUPPORTED_WORKFLOWS).sort());
    for (const group of defaultRegistry.groups) {
      expect(defaultRegistry.commands.some((c) => c.group === group.name)).toBe(true);
    }
  });

  it("serves root, group, and command help for every registered command (exit 0)", async () => {
    const root = captureIo();
    expect(await runCli(["--help"], { io: root.io })).toBe(0);
    for (const group of defaultRegistry.groups) {
      const g = captureIo();
      expect(await runCli([group.name, "--help"], { io: g.io })).toBe(0);
      expect(g.out.join("\n")).toContain(group.name);
    }
    for (const cmd of defaultRegistry.commands) {
      const c = captureIo();
      expect(await runCli([cmd.group, cmd.name, "--help"], { io: c.io }), `${cmd.group} ${cmd.name} --help`).toBe(0);
      const text = c.out.join("\n");
      expect(text).toContain(cmd.summary);
      // Root help lists the command with its safety label.
      expect(root.out.join("\n")).toContain(cmd.name);
    }
  });

  it("keeps the shared exit contract: unknown targets exit 2, read-only rejects --execute", async () => {
    const unknownGroup = captureIo();
    expect(await runCli(["nope"], { io: unknownGroup.io })).toBe(2);
    const unknownCommand = captureIo();
    expect(await runCli(["corpus", "nope"], { io: unknownCommand.io })).toBe(2);
    for (const cmd of defaultRegistry.commands.filter((c) => c.safety === "read-only")) {
      const { io } = captureIo();
      expect(await runCli([cmd.group, cmd.name, "--execute"], { io }), `${cmd.group} ${cmd.name}`).toBe(2);
    }
  });

  it("exposes ops as the only operator entry point in package.json", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const DEV_SCRIPTS = new Set(["dev", "dev:setup", "typecheck", "test", "test:quiet", "test:watch"]);
    const operatorScripts = Object.keys(pkg.scripts).filter((s) => !DEV_SCRIPTS.has(s));
    expect(operatorScripts).toEqual(["ops"]);
  });

  it("leaves no retired top-level operator entry point or Make wrapper behind", async () => {
    const entries = await fs.readdir(path.join(repoRoot, "scripts"));
    // Development-infrastructure scripts, not operator workflows.
    const allowed = new Set(["ops.ts", "dev-setup.ts", "cloud-agent-install.ts", "test-quiet.mjs",
      "control-plane-env.ts", "staging-env.ts"]);
    const strays = entries.filter((e) => /\.(ts|mjs|js)$/.test(e) && !allowed.has(e));
    expect(strays).toEqual([]);
    await expect(fs.stat(path.join(repoRoot, "Makefile"))).rejects.toThrow();
  });
});

describe("policy command extension contract (reading-lite-s1k.9.4)", () => {
  // A minimal conforming stub: it implements the *refusals* the contract
  // demands (which any policy command must have) without any policy behavior.
  const conforming = {
    group: "system",
    name: "policy",
    summary: "stub",
    safety: "plan-first" as const,
    helpText: `Usage: npm run ops -- system policy --env staging|production [options]

Plans by default; --execute applies. Idempotent: re-running the same execute
converges to the same policy state. Tokens and secrets are never printed.

Options:
  --env <name>                     Explicit target environment (required).
  --confirm-production             Required with --execute --env production.
  --acknowledge-guard-version <n>  Assert the guard version this invocation
                                   was written against.
  --execute                        Apply the policy change.`,
    defaultDeps: (io: never) => ({ io }),
    run: async (argv: string[]) => {
      const flag = (name: string) => argv.includes(name);
      const value = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      if (flag("--execute")) {
        const env = value("--env");
        if (!env) throw new UsageError("--env is required");
        if (env === "production" && !flag("--confirm-production")) {
          throw new UsageError("--confirm-production is required for production");
        }
        if (!value("--acknowledge-guard-version")) {
          throw new UsageError("--acknowledge-guard-version is required");
        }
      }
      return 0;
    },
  };

  // Side-effect seams must never be reached by a refusal probe.
  const inertDeps = new Proxy(
    { io: { stdout: () => {}, stderr: () => {} } },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        throw new Error(`side-effect seam ${String(prop)} reached during a refusal probe`);
      },
    },
  );

  it("accepts a conforming plan-first policy command, documentation and behavior", async () => {
    expect(() => assertPolicyCommandContract(conforming as never)).not.toThrow();
    await expect(assertPolicyCommandBehavior(conforming as never, inertDeps)).resolves.toBeUndefined();
  });

  it("rejects a command missing any required acknowledgement", () => {
    const stripped = { ...conforming, helpText: "Usage: npm run ops -- system policy" };
    const violations = policyContractViolations(stripped as never);
    const requirements = violations.map((v) => v.requirement).sort();
    expect(requirements).toEqual([
      "explicit environment",
      "guard version acknowledgement",
      "idempotency",
      "production confirmation",
      "redaction",
    ]);
  });

  it("rejects a non-plan-first policy command", () => {
    const readOnly = { ...conforming, safety: "read-only" as const };
    expect(policyContractViolations(readOnly as never).map((v) => v.requirement)).toContain("plan-first");
  });

  it("behavioral probes catch a command whose run ignores its documented guards", async () => {
    // Documented perfectly, enforces nothing — exactly the false assurance the
    // behavioral half exists to reject.
    const documentedOnly = { ...conforming, run: async () => 0 };
    await expect(assertPolicyCommandBehavior(documentedOnly as never, inertDeps)).rejects.toThrow(
      /did not refuse/,
    );
  });

  it("behavioral probes fail a command that reaches a side-effect seam before validating", async () => {
    // Writes first, validates never: the seam's throw must count as a probe
    // failure, not as a refusal.
    const writesFirst = {
      ...conforming,
      run: async (_argv: string[], deps: { applyPolicy: () => void }) => {
        deps.applyPolicy();
        return 0;
      },
    };
    await expect(assertPolicyCommandBehavior(writesFirst as never, inertDeps)).rejects.toThrow(
      /non-usage error.*side-effect seam/,
    );
  });

  it("applies both halves to the registered policy command once it exists", async () => {
    const registered = defaultRegistry.commands.find(
      (c) => c.name === "policy" || c.group === "system",
    );
    if (!registered) return; // s1k.9.4 has not landed yet — nothing to check.
    assertPolicyCommandContract(registered);
    await assertPolicyCommandBehavior(registered, inertDeps);
  });
});
