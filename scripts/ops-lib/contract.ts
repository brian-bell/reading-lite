// The native command contract for the unified operator CLI (`npm run ops`).
//
// Every operator workflow is a native module implementing CommandDefinition:
// `run(argv, deps)` with injected side-effect seams. Commands come in exactly
// two safety classes — there is no acts-by-default class:
//
// - "read-only" commands run immediately and never accept --execute.
// - "plan-first" commands print a plan by default and perform durable local or
//   remote effects only when the operator passes --execute. Plan mode may read
//   local and remote state to compute an accurate plan, but it must not submit
//   work, call paid providers, deploy, mutate remote data, write durable local
//   output, persist resume state, or move source files.
//
// Exit semantics are shared by every command: 0 for a successful plan or
// execution, 2 for invalid usage (UsageError), 1 for operational failure —
// unless a command deliberately preserves a child tool's documented status.

export type CommandSafety = "read-only" | "plan-first";

// Invalid command usage (unknown flag, missing argument, --execute on a
// read-only command). The dispatcher maps this to exit code 2 and prints the
// command's help; anything else thrown maps to exit code 1.
export class UsageError extends Error {}

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// Deps every command receives. Command modules extend this with their own
// injected seams (filesystem, R2 reads, API clients, clocks) so tests can run
// them without touching Cloudflare or the local disk.
export interface BaseDeps {
  io: CommandIo;
}

export interface CommandDefinition<Deps extends BaseDeps = BaseDeps> {
  group: string;
  name: string;
  // One line for root/group help listings.
  summary: string;
  safety: CommandSafety;
  // Command-specific help body (description + options). The dispatcher frames
  // it with the usage line and the shared mode contract.
  helpText: string;
  defaultDeps: (io: CommandIo) => Deps;
  run: (argv: string[], deps: Deps) => Promise<number>;
}

// The registry erases the per-command Deps type; the dispatcher only needs the
// shared shape. Command modules keep their own precise Deps for tests.
export type AnyCommand = CommandDefinition<BaseDeps & any>;

export interface CommandGroup {
  name: string;
  summary: string;
}
