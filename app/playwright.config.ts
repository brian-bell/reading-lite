import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import type { EvidenceOptions } from "./e2e/test";
import { OUTPUT_DIR } from "./e2e/harness";
import { inScope } from "./e2e/scope";

// Browser evidence for the frontend (issue #374): the built Worker served by
// e2e/harness.ts against the fixture pack, checked at 390 px and 1440 px in
// light and dark. Run `npm run build` first; `npm run test:browser` runs it.
//
// The matrix lives in two places by design: routes and states in
// e2e/coverage.ts, viewports and themes in the projects below. CI runs the
// essential scope (e2e/scope.ts): `npm run test:browser:ci` keeps two of the
// four matrix projects and drops the reduced-motion and zoom passes.

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

// Every project the suite defines; e2e/scope.ts says which ones this run keeps.
const PROJECTS: NonNullable<PlaywrightTestConfig<EvidenceOptions>["projects"]> = [
  ...matrixProjects,
  {
    // The checks' own regression test: it breaks the shell's CSS on purpose,
    // so it stays out of the evidence matrix.
    name: "checks",
    testMatch: /focus-check\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // Requests, not rendering: the reading is read on the server and never
    // again in the browser, so one viewport and theme is enough.
    name: "reading-cache",
    testMatch: /reading-cache\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // The library (#413, #414): read on the server and not again after
    // hydration, asked for in the browser only on a client-side visit or a
    // page change, and each card one target from the pointer and the
    // keyboard. The matrix screenshots its pages in every project.
    name: "library",
    testMatch: /library\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // The return trail's history behaviour and the phone jump's focus and
    // motion (#371): Back and reload, and the reduced-motion contexts, are
    // about state rather than rendering. The matrix already screenshots the
    // trail states in every project.
    name: "reading-trail",
    testMatch: /reading-trail\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // The Source view (#372): URL and history behaviour, request timing, the
    // no-referrer image load, the policy header, and rich content at 390 px.
    // The matrix screenshots the view's states in every project.
    name: "reading-source",
    testMatch: /reading-source\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // The Details section (#373): request timing, the native disclosure
    // from the keyboard, the files opening in a new tab as plain text, and
    // the open section at 390 px. The matrix screenshots its states.
    name: "reading-details",
    testMatch: /reading-details\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // Saving a URL (#431): the request the form makes and the client-side
    // navigation to the reading it created. The matrix screenshots the page
    // and its rejected states in every project.
    name: "save",
    testMatch: /save\.spec\.ts/,
    use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop, theme: "light", colorScheme: "light" },
  },
  {
    // Reduced motion and zoom for the shell: local verification only.
    name: "shell-extras",
    testMatch: /shell-extras\.spec\.ts/,
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
