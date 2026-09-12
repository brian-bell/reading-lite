// The server under test. By default the browser-evidence suite runs the built
// frontend Worker (dist/server/wrangler.json, so `npm run build` first) in
// workerd through Wrangler, bound to e2e/backend-stub.js under the local
// backend's Worker name — the same arrangement smoke/worker.test.ts uses, so
// server renders cross a real service binding and Workers Assets serves
// /assets/*.
//
// Set E2E_BASE_URL to point the same suite at a running host instead (the
// ADR's route-precedence check after a route change, or Phase 5's rollback
// rehearsal against a deployed host). Nothing is started in that mode.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTestHarness } from "wrangler";

export const OUTPUT_DIR = path.join(import.meta.dirname, "test-results");
const URL_FILE = path.join(OUTPUT_DIR, "harness-url");
const BUILT_WORKER_CONFIG = "dist/server/wrangler.json";

export function externalBaseUrl(): string | undefined {
  return process.env.E2E_BASE_URL;
}

export async function startHarness(root: string): Promise<() => Promise<void>> {
  const external = externalBaseUrl();
  if (external) {
    publishBaseUrl(external);
    return async () => rmSync(URL_FILE, { force: true });
  }

  if (!existsSync(path.join(root, BUILT_WORKER_CONFIG))) {
    throw new Error(`${BUILT_WORKER_CONFIG} is missing; run \`npm run build\` before the browser suite`);
  }

  const server = createTestHarness({
    root,
    workers: [
      { configPath: BUILT_WORKER_CONFIG },
      {
        config: {
          name: "reading-lite-dev",
          main: "e2e/backend-stub.js",
          compatibility_date: "2026-09-01",
        },
      },
    ],
  });
  const { url } = await server.listen();
  publishBaseUrl(url.toString());
  return async () => {
    rmSync(URL_FILE, { force: true });
    await server.close();
  };
}

/** The harness picks its own port, so workers read the URL from disk. */
function publishBaseUrl(url: string): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(URL_FILE, url, "utf8");
}

export function harnessBaseUrl(): string {
  if (!existsSync(URL_FILE)) {
    throw new Error("no harness URL; the browser suite starts one in e2e/global-setup.ts");
  }
  return readFileSync(URL_FILE, "utf8").trim();
}
