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

import type { AnyCommand } from "./contract";

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
