// Everything the browser-evidence suite covers, in one place (issue #374).
//
// Add a route or a state by adding a case here: every project in
// playwright.config.ts — 390 px and 1440 px, light and dark — then runs axe,
// the keyboard pass, and a screenshot against it. `fixture` names a state from
// the fixture pack (docs/design/connected/fixture-pack.md); e2e/backend-stub.js
// serves it from e2e/fixtures/fixture-pack.json, so a new fixture state is one
// edit in test/fixtures/local-seed.ts plus `npm run fixtures:app` at the repo
// root.

import type { Page } from "@playwright/test";

export type SignedState = "signed-out" | "signed-in";

export interface EvidenceCase {
  /** Test name and screenshot file name. */
  name: string;
  path: string;
  state: SignedState;
  /** The `<h1>` that proves the page rendered before anything is measured. */
  heading: string;
  /** Fixture-pack state this case reads, once routes read readings (#369+). */
  fixture?: string;
  /** Reaches the state under test after load: open a disclosure, follow a link. */
  prepare?: (page: Page) => Promise<void>;
}

export const EVIDENCE_CASES: EvidenceCase[] = [
  // Signed out, the library renders the sign-in form in place (#369), so its
  // heading is the form's.
  { name: "library-signed-out", path: "/", state: "signed-out", heading: "Sign in" },
  { name: "library-signed-in", path: "/", state: "signed-in", heading: "Library" },
  {
    name: "library-account-menu-open",
    path: "/",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await page.locator("details.account-menu > summary").click();
      await page.locator("details.account-menu[open] .account-menu-panel").waitFor();
    },
  },
  { name: "save-signed-out", path: "/save", state: "signed-out", heading: "Save reading" },
  { name: "save-signed-in", path: "/save", state: "signed-in", heading: "Save reading" },
  { name: "login", path: "/login", state: "signed-out", heading: "Sign in" },

  // Reading detail (#370). Each heading is the page's own <h1>: the title for a
  // reading that has one, the URL for a failed manifest (which never got one),
  // and the state's sentence where there is no reading to show.
  {
    name: "reading-ready",
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
  },
  {
    name: "reading-long-title",
    path: "/readings/rd_FXMAXNAME1",
    state: "signed-in",
    heading:
      "What we lose when every tool for thinking becomes a place to organize, optimize, and measure the work instead of actually doing it",
    fixture: "long-title",
  },
  {
    name: "reading-imported-markdown",
    path: "/readings/rd_FXMDPAGE01",
    state: "signed-in",
    heading: "Slow reading week",
    fixture: "imported-markdown",
  },
  {
    name: "reading-pending",
    path: "/readings/rd_FXPENDNG01",
    state: "signed-in",
    heading: "https://fieldnotes.example/making-room-for-slow-work",
    fixture: "pending",
  },
  {
    name: "reading-failed",
    path: "/readings/rd_FXERR00001",
    state: "signed-in",
    heading: "https://registration-wall.example/members-only-report",
    fixture: "fail-source-unreachable",
  },
  // The pack's removed target: referenced by `attention` but never written, so
  // the route 404s (docs/design/connected/fixture-pack.md).
  {
    name: "reading-not-found",
    path: "/readings/rd_FXVANSHD01",
    state: "signed-in",
    heading: "This reading isn't in your library.",
  },
];
