// Everything the browser-evidence matrix covers, in one place (issue #374).
//
// Each case is a major route a reader reaches: every matrix project in
// playwright.config.ts (390 px and 1440 px, light and dark) runs axe, the
// keyboard pass, the offscreen check, and a screenshot against it. Add one
// only for a route none of these share a layout with. `fixture` names a state
// from the fixture pack (docs/design/connected/fixture-pack.md), which
// e2e/backend-stub.js serves from e2e/fixtures/fixture-pack.json. Mark a case
// `anyHost` only if it expects nothing the stub or the pack supplies, so it
// also passes against a deployed host (E2E_BASE_URL, #392).

import { expect, type Page } from "@playwright/test";
import { externalBaseUrl } from "./harness";
import { hostSession } from "./sessions";
import {
  serveExportInBrowser,
  serveLibraryInBrowser,
  serveSessionsInBrowser,
  serveSettingsInBrowser,
  serveTokensInBrowser,
} from "./test";

export type SignedState = "signed-out" | "signed-in";

export interface EvidenceCase {
  /** Test name and screenshot file name. */
  name: string;
  path: string;
  state: SignedState;
  /** The `<h1>` that proves the page rendered before anything is measured. */
  heading: string;
  /**
   * Expects nothing from e2e/backend-stub.js or the fixture pack: no reading,
   * list, or stub session, and no `stub`. The only cases an
   * external run (E2E_BASE_URL) covers; see e2e/harness.ts.
   */
  anyHost?: true;
  /** Fixture-pack state this case reads. */
  fixture?: string;
  /** Routes the browser's own requests before the page loads, for a state the load itself must reach. */
  stub?: (page: Page) => Promise<void>;
  /** Reaches the state under test after load: wait for what it renders. */
  prepare?: (page: Page) => Promise<void>;
}

export const ALL_EVIDENCE_CASES: EvidenceCase[] = [
  // Signed out, the library renders the sign-in form in place (#369), so its
  // heading is the form's.
  {
    name: "library-signed-out",
    anyHost: true,
    path: "/",
    state: "signed-out",
    heading: "Sign in",
    // The front door (reading-lite-gh341.11): what the service is, and the samples.
    prepare: async (page) => {
      const about = page.getByRole("complementary", { name: "About Reading Lite" });
      await expect(about.getByRole("link", { name: "Browse samples" })).toBeVisible();
    },
  },
  // Signed in, the first page of the pack's list index, rendered on the server
  // (#413), with its pending, failed, and long-title rows.
  {
    name: "library-signed-in",
    path: "/",
    state: "signed-in",
    heading: "Library",
    // The pending row makes the page check itself every 15 s in the browser
    // (#409), and the frontend Worker answers /api/* with 404 by design.
    stub: (page) => serveLibraryInBrowser(page),
    prepare: async (page) => {
      const list = page.getByRole("list", { name: "Readings" });
      await expect(list.getByRole("listitem").first()).toBeVisible();
      await expect(list.getByText("Reprocess failed")).toBeVisible();
      await expect(list.getByRole("link", { name: /^What we lose when every tool/ })).toBeVisible();
    },
  },
  { name: "save-signed-in", anyHost: true, path: "/save", state: "signed-in", heading: "Save reading" },
  // Account sessions, settings, and tokens are read in the browser, so the
  // case stubs all four; without that the frontend Worker answers /api/* with 404.
  {
    name: "account-sessions",
    path: "/account/security",
    state: "signed-in",
    heading: "Account",
    stub: async (page) => {
      await serveSettingsInBrowser(page);
      await serveExportInBrowser(page);
      await serveTokensInBrowser(page);
      await serveSessionsInBrowser(page);
    },
    prepare: async (page) => {
      await expect(page.getByText("Firefox (this device)")).toBeVisible();
      await expect(page.getByRole("button", { name: "Revoke this device" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Sessions" }).getByRole("status")).toContainText("10-session limit");
      await expect(page.getByRole("checkbox", { name: "Email me when a reading is ready" })).toBeChecked();
      await expect(page.getByText("CI (standard) · usable")).toBeVisible();
      await expect(page.getByText("Old script (standard) · revoked")).toBeVisible();
    },
  },
  // A ready reading (#370): the summary, tags, novelty, and connections.
  {
    name: "reading-ready",
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
  },
];

// An `anyHost` case that reads the stub or the pack would fail every external run.
for (const evidence of ALL_EVIDENCE_CASES) {
  if (evidence.anyHost && (evidence.fixture ?? evidence.stub) !== undefined) {
    throw new Error(`${evidence.name} is anyHost but sets a fixture or stub`);
  }
}

/**
 * The cases this run covers: every case against the harness. Against an
 * external host only the `anyHost` ones, and only the signed-out ones of those
 * unless E2E_SESSION_COOKIE supplies a real session.
 */
export const EVIDENCE_CASES: EvidenceCase[] = ALL_EVIDENCE_CASES.filter(
  (evidence) =>
    !externalBaseUrl() || (evidence.anyHost && (evidence.state === "signed-out" || hostSession() !== undefined)),
);
