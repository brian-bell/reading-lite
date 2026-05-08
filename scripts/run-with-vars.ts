#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";

function printUsage(): void {
  process.stderr.write(`Usage: tsx scripts/run-with-vars.ts --vars <file> -- <cmd> [args...]

Loads dotenv-style variables from <file>, overlays them on the current process
environment, then runs the command.
`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vars: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.vars) {
  process.stderr.write("missing required --vars <file>\n");
  printUsage();
  process.exit(2);
}

if (!existsSync(values.vars)) {
  process.stderr.write(`missing vars file: ${values.vars}\n`);
  process.exit(2);
}

if (positionals.length === 0) {
  process.stderr.write("missing command after --\n");
  printUsage();
  process.exit(2);
}

const [cmd, ...args] = positionals;
const child = spawn(cmd, args, {
  env: { ...process.env, ...loadDotVars(values.vars) },
  shell: false,
  stdio: "inherit",
});

child.on("error", (e) => {
  process.stderr.write(`${cmd}: ${e.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`${cmd}: exited via signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
