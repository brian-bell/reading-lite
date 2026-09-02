// Root dispatcher for the unified operator CLI. Resolves `<group> <command>`
// against the registry, renders root/group/command help from the same command
// definitions that execute, and enforces the shared exit contract:
// 0 success, 2 usage error, 1 operational failure. A command returns 2 itself
// for a refusal of the same shape (an unusable flag combination, a guard it
// will not run past), and this dispatcher returns it for the ones it can see
// without running the command. Codes above those are the command's own and
// pass through untouched: `corpus refresh-neighbours` returns 3 for "the pass
// completed, but specific readings need a human" (docs/operations.md, "Refresh
// exit codes").

import { UsageError, type AnyCommand, type CommandGroup, type CommandIo } from "./contract";
import { defaultRegistry, type Registry } from "./registry";

export interface RunCliOptions {
  io?: CommandIo;
  registry?: Registry;
  // Test seam: build the deps handed to a resolved command. Defaults to the
  // command's own defaultDeps.
  depsFor?: (command: AnyCommand, io: CommandIo) => unknown;
}

const USAGE = "Usage: npm run ops -- <group> <command> [options]";

function safetyLabel(command: AnyCommand): string {
  return command.safety === "read-only" ? "[read-only]" : "[plan-first]";
}

function renderRootHelp(registry: Registry): string {
  const lines = [
    USAGE,
    "",
    "Plan-first operator CLI. [plan-first] commands print a plan by default and",
    "act only with --execute. [read-only] commands run immediately and do not",
    "accept --execute.",
    "",
    "Groups:",
  ];
  for (const group of registry.groups) {
    lines.push("", `  ${group.name}  ${group.summary}`);
    for (const command of registry.commands.filter((c) => c.group === group.name)) {
      lines.push(`    ${command.name.padEnd(22)} ${safetyLabel(command).padEnd(12)} ${command.summary}`);
    }
  }
  lines.push(
    "",
    "Run `npm run ops -- <group> --help` or `npm run ops -- <group> <command> --help` for details.",
  );
  return lines.join("\n");
}

function renderGroupHelp(group: CommandGroup, registry: Registry): string {
  const lines = [
    `Usage: npm run ops -- ${group.name} <command> [options]`,
    "",
    group.summary,
    "",
    "Commands:",
  ];
  for (const command of registry.commands.filter((c) => c.group === group.name)) {
    lines.push(`  ${command.name.padEnd(22)} ${safetyLabel(command).padEnd(12)} ${command.summary}`);
  }
  lines.push("", `Run \`npm run ops -- ${group.name} <command> --help\` for details.`);
  return lines.join("\n");
}

function renderCommandHelp(command: AnyCommand): string {
  const mode =
    command.safety === "read-only"
      ? "read-only — runs immediately; does not accept --execute."
      : "plan-first — prints a plan by default; pass --execute to act.";
  return [
    `Usage: npm run ops -- ${command.group} ${command.name} [options]`,
    "",
    command.summary,
    "",
    `Mode: ${mode}`,
    "",
    command.helpText,
  ].join("\n");
}

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io: CommandIo = options.io ?? {
    stdout: (text) => process.stdout.write(text + "\n"),
    stderr: (text) => process.stderr.write(text + "\n"),
  };
  const registry = options.registry ?? defaultRegistry;

  const [groupName, commandName, ...rest] = argv;

  if (groupName === undefined || groupName === "--help" || groupName === "-h") {
    // Bare `ops` chose nothing to run: that is a usage error, but the help text
    // is the useful response either way.
    const help = renderRootHelp(registry);
    if (groupName === undefined) {
      io.stderr(help);
      return 2;
    }
    io.stdout(help);
    return 0;
  }

  const group = registry.groups.find((g) => g.name === groupName);
  if (!group) {
    io.stderr(`Unknown group: ${groupName}`);
    io.stderr("");
    io.stderr(renderRootHelp(registry));
    return 2;
  }

  if (commandName === undefined || commandName === "--help" || commandName === "-h") {
    const help = renderGroupHelp(group, registry);
    if (commandName === undefined) {
      io.stderr(help);
      return 2;
    }
    io.stdout(help);
    return 0;
  }

  const command = registry.commands.find((c) => c.group === groupName && c.name === commandName);
  if (!command) {
    io.stderr(`Unknown command: ${groupName} ${commandName}`);
    io.stderr("");
    io.stderr(renderGroupHelp(group, registry));
    return 2;
  }

  if (wantsHelp(rest)) {
    io.stdout(renderCommandHelp(command));
    return 0;
  }

  if (command.safety === "read-only" && rest.includes("--execute")) {
    io.stderr(`${command.group} ${command.name} is read-only and does not accept --execute.`);
    io.stderr("");
    io.stderr(renderCommandHelp(command));
    return 2;
  }

  const deps = options.depsFor ? options.depsFor(command, io) : command.defaultDeps(io);
  try {
    return await command.run(rest, deps as never);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(err.message);
      io.stderr("");
      io.stderr(renderCommandHelp(command));
      return 2;
    }
    io.stderr(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}
