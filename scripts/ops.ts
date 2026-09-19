#!/usr/bin/env -S npx tsx
// Unified operator CLI entry point: `npm run ops -- <group> <command> [options]`.
// All behavior lives in ops-lib (registry, dispatcher, command modules); this
// file only binds process argv and the exit code.
//
// Operator Node is 22. Wrangler child processes go through
// scripts/lib/wrangler-cli.ts.
import { runCli } from "./ops-lib/cli";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
