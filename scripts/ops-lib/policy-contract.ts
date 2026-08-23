// The extension contract for the future system-policy command
// (reading-lite-s1k.9.4). This module records the requirements and provides a
// tested checker; it deliberately implements NO policy or kill-switch
// behavior — that stays owned by s1k.9.4.
//
// The policy command plugs into the same registry as every other command by
// exporting a CommandDefinition and registering it. Beyond the shared
// contract (plan-first, run(argv, deps), shared exit semantics), a policy
// command must additionally satisfy the requirements below, which
// assertPolicyCommandContract verifies against its definition. The registry
// coverage test runs the checker against a conforming fixture so the
// extension point stays enforced before the real command lands.

import { UsageError, type AnyCommand } from "./contract";

export interface PolicyContractViolation {
  requirement: string;
  detail: string;
}

// Each requirement is checked structurally where the definition can carry it
// (safety class) and textually against the command's help contract otherwise:
// the help text is registry-rendered documentation, so an acknowledgement
// flag that is not documented there does not exist as far as operators are
// concerned.
const HELP_REQUIREMENTS: { requirement: string; pattern: RegExp; detail: string }[] = [
  {
    requirement: "explicit environment",
    pattern: /--env\b/,
    detail: "must take an explicit, validated --env target (no default-to-production, no global env option)",
  },
  {
    requirement: "production confirmation",
    pattern: /--confirm-production\b/,
    detail: "a production write must require --confirm-production in addition to --execute",
  },
  {
    requirement: "idempotency",
    pattern: /idempotent/i,
    detail: "the command must document that re-running an execute is safe (idempotent)",
  },
  {
    requirement: "redaction",
    pattern: /never print|redact/i,
    detail: "secrets and tokens must be documented as never printed (redacted) in plans or logs",
  },
  {
    requirement: "guard version acknowledgement",
    pattern: /--acknowledge-guard-version\b/,
    detail:
      "an execute must assert the guard version it was written against " +
      "(--acknowledge-guard-version <n>) so a stale automation cannot flip a newer policy",
  },
];

export function policyContractViolations(command: AnyCommand): PolicyContractViolation[] {
  const violations: PolicyContractViolation[] = [];
  if (command.safety !== "plan-first") {
    violations.push({
      requirement: "plan-first",
      detail: "a policy command mutates system state and must be classified plan-first",
    });
  }
  for (const { requirement, pattern, detail } of HELP_REQUIREMENTS) {
    if (!pattern.test(command.helpText)) {
      violations.push({ requirement, detail });
    }
  }
  return violations;
}

export function assertPolicyCommandContract(command: AnyCommand): void {
  const violations = policyContractViolations(command);
  if (violations.length > 0) {
    throw new Error(
      `policy command "${command.group} ${command.name}" violates the extension contract:\n` +
        violations.map((v) => `  - ${v.requirement}: ${v.detail}`).join("\n"),
    );
  }
}

// Behavioral probes: documentation alone is not the contract — the command's
// run seam must actually refuse each unsafe invocation. Every probe is an
// invocation a conforming policy command MUST reject as usage (throw
// UsageError or return 2) before any injected side-effect seam runs, so these
// are checkable without implementing any policy behavior. The caller supplies
// deps whose side-effect seams throw (or record) so a probe that reaches one
// fails loudly.
export const POLICY_REFUSAL_PROBES: { requirement: string; argv: string[] }[] = [
  {
    requirement: "explicit environment",
    // An execute with no --env must be refused, never defaulted.
    argv: ["--execute", "--acknowledge-guard-version", "1"],
  },
  {
    requirement: "production confirmation",
    argv: ["--execute", "--env", "production", "--acknowledge-guard-version", "1"],
  },
  {
    requirement: "guard version acknowledgement",
    argv: ["--execute", "--env", "staging"],
  },
];

export async function assertPolicyCommandBehavior(
  command: AnyCommand,
  deps: unknown,
): Promise<void> {
  const failures: string[] = [];
  for (const probe of POLICY_REFUSAL_PROBES) {
    let refused = false;
    let failure: string | undefined;
    try {
      const code = await command.run(probe.argv, deps as never);
      refused = code === 2;
      if (!refused) failure = `returned ${code} instead of refusing`;
    } catch (e) {
      // Only the usage-refusal type counts. Any other throw — including the
      // caller's side-effect seams firing — means the command reached work it
      // must never reach on this invocation, and the probe fails loudly.
      if (e instanceof UsageError) {
        refused = true;
      } else {
        failure = `threw a non-usage error (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    if (!refused) {
      failures.push(
        `${probe.requirement}: did not refuse \`${probe.argv.join(" ")}\`` +
          (failure ? ` — ${failure}` : ""),
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `policy command "${command.group} ${command.name}" fails behavioral probes:\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
  }
}
