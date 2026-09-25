// The server under test. By default the browser-evidence suite runs the built
// frontend Worker (dist/server/wrangler.json, so `npm run build` first) in
// workerd through Wrangler, bound to e2e/backend-stub.js under the local
// backend's Worker name — the same arrangement smoke/worker.test.ts uses, so
// server renders cross a real service binding and Workers Assets serves
// /assets/*.
//
// Set E2E_BASE_URL to point the suite at a running host instead. Nothing is
// started in that mode, so nothing answers from the stub or the fixture pack:
// the run keeps only the matrix and shell-extras projects (e2e/scope.ts), and
// of the coverage cases only the `anyHost` ones (e2e/coverage.ts) — the
// signed-out shell, sign-in, the legal pages, /save, and a missing reading's
// 404 — so it checks the deployed shell's rendering, axe, and keyboard, never
// reading content (#392). Signed-in cases run only with E2E_SESSION_COOKIE
// (a real session) and E2E_SESSION_EMAIL (its account's address); without
// the cookie the run is signed-out only, and the cookie alone, or either one
// without E2E_BASE_URL, is refused below. No case writes: /save's are the
// empty form and a URL the page refuses before it asks.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTestHarness } from "wrangler";
import { hostSession, hostSessionEmail } from "./sessions";

export const OUTPUT_DIR = path.join(import.meta.dirname, "test-results");
const URL_FILE = path.join(OUTPUT_DIR, "harness-url");
const BUILT_WORKER_CONFIG = "dist/server/wrangler.json";

export function externalBaseUrl(): string | undefined {
  return process.env.E2E_BASE_URL || undefined;
}

export async function startHarness(root: string): Promise<() => Promise<void>> {
  const external = externalBaseUrl();
  if (external) {
    if (hostSession() !== undefined && hostSessionEmail() === undefined) {
      throw new Error("E2E_SESSION_COOKIE needs E2E_SESSION_EMAIL, the address the signed-in cases expect");
    }
    publishBaseUrl(external);
    return async () => rmSync(URL_FILE, { force: true });
  }
  // The stub answers only its own sessions, so a real one left in the
  // environment would fail every signed-in case for no visible reason.
  if (hostSession() !== undefined || hostSessionEmail() !== undefined) {
    throw new Error("E2E_SESSION_COOKIE and E2E_SESSION_EMAIL apply only with E2E_BASE_URL");
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
