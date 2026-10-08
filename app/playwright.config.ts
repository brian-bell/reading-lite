import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import type { EvidenceOptions } from "./e2e/test";
import { OUTPUT_DIR } from "./e2e/harness";
import { inScope } from "./e2e/scope";

// Browser evidence for the frontend (issue #374): the built Worker served by
// e2e/harness.ts against the fixture pack, checked at 390 px and 1440 px in
// light and dark. Run `npm run build` first; `npm run test:browser` runs it.
//
// The matrix lives in two places by design: routes in e2e/coverage.ts,
// viewports and themes in the projects below. CI runs the essential scope
// (e2e/scope.ts): `npm run test:browser:ci` keeps two of the four matrix
// projects.

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 932 },
};

const THEMES = ["light", "dark"] as const;

const matrixProjects = Object.entries(VIEWPORTS).flatMap(([size, viewport]) =>
  THEMES.map((theme) => ({
    name: `${size}-${theme}`,
    testMatch: /matrix\.spec\.ts/,
    metadata: { anyHost: true },
    use: {
      ...devices["Desktop Chrome"],
      viewport,
      theme,
      // The shell's tokens use light-dark(), so the browser preference has to
      // agree with the cookie for "system" to mean anything later.
      colorScheme: theme,
    },
  })),
);

// Every project the suite defines; e2e/scope.ts says which ones this run keeps.
// `metadata.anyHost` marks the projects that read only e2e/coverage.ts's
// `anyHost` cases, the only ones an external run (E2E_BASE_URL) keeps.
const PROJECTS: NonNullable<PlaywrightTestConfig<EvidenceOptions>["projects"]> = [
  ...matrixProjects,
  {
    // A new reader's way in, end to end (reading-lite-gh341.11): the
    // signed-out front door, the samples, sign-in, connecting a key, and the
    // first save, with the session cookie, the key, and each write's CSRF
    // token and tenant pin checked on the way.
    name: "onboarding",
    testMatch: /onboarding\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
];

export default defineConfig<EvidenceOptions>({
  testDir: "./e2e/specs",
  outputDir: OUTPUT_DIR,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Two workers on CI, measured: four on the 4-vCPU runner ran the suite
  // slower (635 s against 605 s) and starved hydration enough to break the
  // library-offline case, so the run is CPU-bound alongside the harness.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["html", { outputFolder: "e2e/report", open: "never" }], ["list"]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: PROJECTS.filter(inScope),
});
