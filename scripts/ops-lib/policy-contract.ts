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
// Flag requirements match the flag name (unambiguous); the idempotency and
// redaction guarantees must appear as these exact affirmative sentences —
// substring keyword matching would also accept help text that *denies* the
// requirement ("non-idempotent", "printed unredacted").
//
// Ownership boundary: idempotency and redaction are *documented* obligations
// here and *behaviorally verified* in s1k.9.4's own test suite. Verifying
// them behaviorally requires a valid execute against real (or faked) policy
// state — i.e. the policy command's design — which this epic deliberately
// does not implement. The behavioral half of this contract is limited to what
// is design-independent: refusals of unsafe invocations and plan-mode purity.
export const POLICY_IDEMPOTENCY_PHRASE =
  "Idempotent: re-running the same execute converges to the same policy state.";
export const POLICY_REDACTION_PHRASE = "Tokens and secrets are never printed.";

const HELP_REQUIREMENTS: { requirement: string; test: (help: string) => boolean; detail: string }[] = [
  {
    requirement: "explicit environment",
    test: (help) => /--env\b/.test(help),
    detail: "must take an explicit, validated --env target (no default-to-production, no global env option)",
  },
  {
    requirement: "production confirmation",
    test: (help) => /--confirm-production\b/.test(help),
    detail: "a production write must require --confirm-production in addition to --execute",
  },
  {
    requirement: "idempotency",
    test: (help) => help.includes(POLICY_IDEMPOTENCY_PHRASE),
    detail: `help must carry the exact guarantee: "${POLICY_IDEMPOTENCY_PHRASE}"`,
  },
  {
    requirement: "redaction",
    test: (help) => help.includes(POLICY_REDACTION_PHRASE),
    detail: `help must carry the exact guarantee: "${POLICY_REDACTION_PHRASE}"`,
  },
  {
    requirement: "guard version acknowledgement",
    test: (help) => /--acknowledge-guard-version\b/.test(help),
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
  for (const { requirement, test, detail } of HELP_REQUIREMENTS) {
    if (!test(command.helpText)) {
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
// run seam must actually behave. The caller supplies deps whose WRITE seams
// throw (read seams may work — a plan is allowed to read); any probe that
// reaches a write seam fails loudly. The deps must also carry the current
// guard version (`currentGuardVersion`) so the stale-acknowledgement probe is
// checkable: the s1k.9.4 command is expected to resolve the live guard
// version through its deps and compare. All of this is checkable without
// implementing any policy behavior.
// A registered policy command must carry its own contract-deps factory so the
// registry coverage suite can execute the behavioral checker against the real
// definition — no external wiring, no trust in a conventionally named test
// file. The factory returns deps whose READ seams work (a plan may read live
// policy and guard-version state — faked is fine) and whose WRITE seams
// throw, plus the probe options (current guard version, valid baseline argv).
export interface PolicyContractCapable {
  makeContractDeps: () => {
    deps: unknown;
    options: PolicyBehaviorOptions;
    // Deps for the execute-control probe: write seams RECORD (over faked
    // state) instead of throwing, so one fully-valid staging execute can
    // succeed. This is what proves the refusal probes are discriminating — a
    // command that blanket-refuses every --execute must fail the control.
    executeControlDeps: unknown;
  };
}

export function isPolicyContractCapable(command: AnyCommand): command is AnyCommand & PolicyContractCapable {
  return typeof (command as Partial<PolicyContractCapable>).makeContractDeps === "function";
}

export interface PolicyBehaviorOptions {
  // The guard version the injected deps present as current. The stale probe
  // acknowledges (currentGuardVersion - 1) and must be refused.
  currentGuardVersion: number;
  // A known-valid mutation argv fragment for the command under test (its
  // operation arguments, e.g. ["--policy", "disabled"]). Every probe starts
  // from this valid baseline and varies exactly one safety guard, so a
  // command cannot pass by rejecting probes for an unrelated missing
  // operation argument. Empty when the command needs no operation args.
  baselineArgv: string[];
}

export function policyRefusalProbes(
  opts: PolicyBehaviorOptions,
): { requirement: string; argv: string[] }[] {
  const current = String(opts.currentGuardVersion);
  const stale = String(opts.currentGuardVersion - 1);
  const future = String(opts.currentGuardVersion + 1);
  const base = opts.baselineArgv;
  return [
    {
      requirement: "explicit environment",
      // An execute with no --env must be refused, never defaulted.
      argv: [...base, "--execute", "--acknowledge-guard-version", current],
    },
    {
      requirement: "explicit environment (invalid value)",
      // The target type is validated, not merely present — an unknown
      // environment must never resolve through a fallback.
      argv: [...base, "--execute", "--env", "typo", "--acknowledge-guard-version", current],
    },
    {
      requirement: "production confirmation",
      argv: [...base, "--execute", "--env", "production", "--acknowledge-guard-version", current],
    },
    {
      requirement: "guard version acknowledgement",
      argv: [...base, "--execute", "--env", "staging"],
    },
    {
      requirement: "guard version acknowledgement (stale)",
      // Presence is not enough: acknowledging an outdated guard version must
      // be refused, or stale automation could flip a newer policy.
      argv: [...base, "--execute", "--env", "staging", "--acknowledge-guard-version", stale],
    },
    {
      requirement: "guard version acknowledgement (future)",
      // Exact equality with the live version: a blanket high value must not
      // pre-acknowledge guard changes that have not happened yet.
      argv: [...base, "--execute", "--env", "staging", "--acknowledge-guard-version", future],
    },
    {
      requirement: "guard version acknowledgement (malformed)",
      argv: [...base, "--execute", "--env", "staging", "--acknowledge-guard-version", "not-a-version"],
    },
    {
      requirement: "guard version acknowledgement (confirmed production, missing)",
      // Guard-version enforcement must hold for production too: a confirmed
      // production execute with no acknowledgement is still refused.
      argv: [...base, "--execute", "--env", "production", "--confirm-production"],
    },
    {
      requirement: "guard version acknowledgement (confirmed production, stale)",
      argv: [
        ...base, "--execute", "--env", "production", "--confirm-production",
        "--acknowledge-guard-version", stale,
      ],
    },
  ];
}

export async function assertPolicyCommandBehavior(
  command: AnyCommand,
  deps: unknown,
  opts: PolicyBehaviorOptions,
  // Deps under which one fully-valid staging execute must SUCCEED (write
  // seams recording over faked state). Without this control a command could
  // pass every refusal probe by unconditionally rejecting --execute.
  executeControlDeps?: unknown,
): Promise<void> {
  const failures: string[] = [];

  if (executeControlDeps !== undefined) {
    const controlArgv = [
      ...opts.baselineArgv, "--execute", "--env", "staging",
      "--acknowledge-guard-version", String(opts.currentGuardVersion),
    ];
    try {
      const code = await command.run(controlArgv, executeControlDeps as never);
      if (code !== 0) {
        failures.push(
          `execute control: a fully-valid staging execute returned ${code} — ` +
            "refusal probes are meaningless if every execute is rejected",
        );
      }
    } catch (e) {
      failures.push(
        `execute control: a fully-valid staging execute threw (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  // Plan-first: a mode-less invocation must succeed as a pure plan — exit 0
  // and no write seam reached (the caller's write seams throw, and any
  // non-usage throw is recorded as a failure here). Both environments are
  // probed: production plans must be exactly as pure as staging plans.
  for (const env of ["staging", "production"]) {
    try {
      const code = await command.run([...opts.baselineArgv, "--env", env], deps as never);
      if (code !== 0) {
        failures.push(`plan-first (${env}): mode-less invocation returned ${code} instead of a successful plan`);
      }
    } catch (e) {
      failures.push(
        `plan-first (${env}): mode-less invocation threw (${e instanceof Error ? e.message : String(e)}) — ` +
          "a plan must succeed without reaching any write seam",
      );
    }
  }

  // The explicit-environment rule binds plans too: a missing or unknown --env
  // must be refused as usage (never defaulted), still without reaching a
  // write seam.
  for (const [label, argv] of [
    ["plan without --env", [...opts.baselineArgv]],
    ["plan with invalid --env", [...opts.baselineArgv, "--env", "typo"]],
  ] as const) {
    try {
      const code = await command.run(argv as string[], deps as never);
      if (code !== 2) {
        failures.push(`explicit environment: ${label} returned ${code} instead of refusing`);
      }
    } catch (e) {
      if (!(e instanceof UsageError)) {
        failures.push(
          `explicit environment: ${label} threw a non-usage error (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
  }

  for (const probe of policyRefusalProbes(opts)) {
    let refused = false;
    let failure: string | undefined;
    try {
      const code = await command.run(probe.argv, deps as never);
      refused = code === 2;
      if (!refused) failure = `returned ${code} instead of refusing`;
    } catch (e) {
      // Only the usage-refusal type counts. Any other throw — including the
      // caller's write seams firing — means the command reached work it must
      // never reach on this invocation, and the probe fails loudly.
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
