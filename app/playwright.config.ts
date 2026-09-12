import { defineConfig, devices } from "@playwright/test";
import type { EvidenceOptions } from "./e2e/test";
import { OUTPUT_DIR } from "./e2e/harness";

// Browser evidence for the frontend (issue #374): the built Worker served by
// e2e/harness.ts against the fixture pack, checked at 390 px and 1440 px in
// light and dark. Run `npm run build` first; `npm run test:browser` runs it.
//
// The matrix lives in two places by design: routes and states in
// e2e/coverage.ts, viewports and themes in the projects below.

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 932 },
};

const THEMES = ["light", "dark"] as const;

const matrixProjects = Object.entries(VIEWPORTS).flatMap(([size, viewport]) =>
  THEMES.map((theme) => ({
    name: `${size}-${theme}`,
    testMatch: /matrix\.spec\.ts/,
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

export default defineConfig<EvidenceOptions>({
  testDir: "./e2e/specs",
  outputDir: OUTPUT_DIR,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["html", { outputFolder: "e2e/report", open: "never" }], ["list"]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    ...matrixProjects,
    {
      // The checks' own regression test: it breaks the shell's CSS on purpose,
      // so it stays out of the evidence matrix.
      name: "checks",
      testMatch: /focus-check\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
    },
    {
      name: "shell-extras",
      testMatch: /shell-extras\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
    },
  ],
});
