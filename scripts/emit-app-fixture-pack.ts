#!/usr/bin/env tsx
// Writes app/e2e/fixtures/fixture-pack.json, the fixture-pack snapshot the
// frontend's browser-evidence suite serves from its stub backend (issue #374).
// Run after changing test/fixtures/local-seed.ts and commit the result;
// test/unit/fixtures/app-fixture-pack.test.ts fails while it is stale.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_FIXTURE_PACK_PATH,
  buildAppFixturePack,
  serializeAppFixturePack,
} from "../test/fixtures/app-fixture-pack";

export function emitAppFixturePack(repoRoot: string): string {
  const target = path.join(repoRoot, APP_FIXTURE_PACK_PATH);
  writeFileSync(target, serializeAppFixturePack(buildAppFixturePack()), "utf8");
  return target;
}

function main(): void {
  const target = emitAppFixturePack(path.join(import.meta.dirname, ".."));
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
