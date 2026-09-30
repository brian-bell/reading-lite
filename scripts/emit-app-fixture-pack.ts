#!/usr/bin/env tsx
// Writes app/e2e/fixtures/fixture-pack.json, the fixture-pack snapshot the
// frontend's browser-evidence suite serves from its stub backend (issue #374),
// and app/src/samples/sample-library.json, the public sample library the
// frontend bundles (reading-lite-gh341.10). Run after changing
// test/fixtures/local-seed.ts and commit the result;
// test/unit/fixtures/app-fixture-pack.test.ts fails while either is stale.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_FIXTURE_PACK_PATH,
  buildAppFixturePack,
  serializeAppFixturePack,
} from "../test/fixtures/app-fixture-pack";
import {
  APP_SAMPLE_LIBRARY_PATH,
  buildAppSampleLibrary,
  serializeAppSampleLibrary,
} from "../test/fixtures/app-sample-library";

export function emitAppFixturePack(repoRoot: string): string[] {
  const pack = path.join(repoRoot, APP_FIXTURE_PACK_PATH);
  writeFileSync(pack, serializeAppFixturePack(buildAppFixturePack()), "utf8");
  const samples = path.join(repoRoot, APP_SAMPLE_LIBRARY_PATH);
  mkdirSync(path.dirname(samples), { recursive: true });
  writeFileSync(samples, serializeAppSampleLibrary(buildAppSampleLibrary()), "utf8");
  return [pack, samples];
}

function main(): void {
  for (const target of emitAppFixturePack(path.join(import.meta.dirname, ".."))) {
    console.log(`wrote ${path.relative(process.cwd(), target)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
