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

import { expect, type Page, type Request } from "@playwright/test";
import pack from "./fixtures/fixture-pack.json" with { type: "json" };
import { externalBaseUrl } from "./harness";
import { hostSession } from "./sessions";
import {
  E2E_DIGEST_PREVIEW,
  E2E_PROVIDER,
  serveDeskInBrowser,
  serveDigestPreviewInBrowser,
  serveExportInBrowser,
  serveInboxInBrowser,
  serveLibraryInBrowser,
  serveProviderInBrowser,
  serveReadingsInBrowser,
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
  {
    name: "desk-signed-out",
    anyHost: true,
    path: "/",
    state: "signed-out",
    heading: "Reading Lite summarizes what you save and connects it to what you have already read.",
    prepare: async (page) => {
      const signIn = page.getByRole("region", { name: "Sign in" });
      await expect(signIn.getByRole("textbox", { name: "Email" })).toBeVisible();
      const samples = page.getByRole("region", { name: "Sample library" });
      await expect(samples.getByRole("link", { name: "Browse samples" })).toBeVisible();
      await expect(samples.getByRole("link", { name: "A quieter internet is a choice we can make" })).toBeVisible();
    },
  },
  // Signed in, the pack's first-visit desk, rendered on the server
  // (reading-lite-kl7y.7): failures and a failed reprocess under Needs you,
  // the pending rows, two readings on the desk, and what arrived this week.
  {
    name: "desk-signed-in",
    path: "/",
    state: "signed-in",
    heading: "Desk",
    // The digest and provider tiles read in the browser; the pending rows make
    // the page check itself on the library's schedule; its links preload readings.
    stub: async (page) => {
      await serveDigestPreviewInBrowser(page);
      await serveProviderInBrowser(page, { json: E2E_PROVIDER.connected });
      await serveInboxInBrowser(page);
      await serveDeskInBrowser(page);
      await serveReadingsInBrowser(page);
    },
    prepare: async (page) => {
      const needsYou = page.getByRole("region", { name: "Needs you" });
      await expect(needsYou.getByText(/^Reprocess failed · /)).toBeVisible();
      const inbox = page.getByRole("region", { name: "Inbox" });
      await expect(inbox.getByRole("link", { name: "How to keep a reading log", exact: true })).toBeVisible();
      await expect(
        inbox.getByRole("link", { name: "https://small-hours.example/talks/attention-2026/transcript", exact: true }),
      ).toBeVisible();
      await expect(inbox.getByRole("link", { name: "Three questions to ask before saving", exact: true })).toBeVisible();
      await expect(inbox.getByRole("link", { name: "A reading list for a slow winter", exact: true })).toBeVisible();
      await expect(inbox.getByRole("link", { name: "Notes from the margins workshop", exact: true })).toBeVisible();
      await expect(inbox.getByRole("link", { name: "Show all 6", exact: true })).toBeVisible();
      await expect(inbox.getByText("What the archive forgot")).toHaveCount(0);
      const onDesk = page.getByRole("region", { name: "On your desk" });
      await expect(onDesk.getByRole("link", { name: "Start" })).toBeVisible();
      await expect(onDesk.getByRole("button", { name: "Take off desk" })).toHaveCount(2);
      const readySince = page.getByRole("region", { name: /^Ready since / });
      await expect(readySince.getByRole("button", { name: "Put on desk" }).first()).toBeEnabled();
      await expect(page.getByRole("region", { name: "Provider" }).getByText("OpenAI key ending c0de")).toBeVisible();
      const digest = page.getByRole("region", { name: "Next digest" });
      await expect(digest.getByText(`${E2E_DIGEST_PREVIEW.scheduled.items.length} readings so far`)).toBeVisible();
      await expect(digest.getByText("Goes out Monday 14 September at 08:00, Europe/London.")).toBeVisible();
    },
  },
  // Signed in, the first page of the pack's list index, rendered on the server
  // (#413), with its pending, failed, and long-title rows.
  {
    name: "library-signed-in",
    path: "/library",
    state: "signed-in",
    heading: "Library",
    // The pending row makes the page check itself every 15 s in the browser
    // (#409), and the frontend Worker answers /api/* with 404 by design. The
    // desk toggles read what is on the desk.
    stub: async (page) => {
      await serveLibraryInBrowser(page);
      await serveDeskInBrowser(page);
    },
    prepare: async (page) => {
      const list = page.getByRole("list", { name: "Readings" });
      await expect(list.getByRole("listitem").first()).toBeVisible();
      await expect(list.getByText("Reprocess failed")).toBeVisible();
      await expect(list.getByRole("link", { name: /^What we lose when every tool/ })).toBeVisible();
    },
  },
  {
    name: "catalog",
    path: "/catalog",
    state: "signed-in",
    heading: "Catalog",
    stub: async (page) => {
      await serveReadingsInBrowser(page);
      await serveLibraryInBrowser(page);
      await serveDeskInBrowser(page);
    },
    prepare: async (page) => {
      const searches: string[] = [];
      const recordSearch = (request: Request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/readings/search") {
          searches.push(request.postData() ?? "");
        }
      };
      page.on("request", recordSearch);
      try {
        await page.waitForLoadState("networkidle");
        const find = page.getByRole("search", { name: "Find readings" });
        await find.getByRole("radio", { name: "Meaning" }).check();
        await find.getByRole("searchbox", { name: "Find" }).fill("why quiet tools hold attention");
        await find.getByRole("button", { name: "Find" }).click();
        await expect(page.getByRole("list", { name: "Readings" }).getByRole("listitem")).toHaveText([
          /^A quieter internet is a choice we can make\s*Close$/,
          /^The case for a little friction\s*Near$/,
          /^Against the endless queue\s*Faint$/,
        ]);
        expect(searches).toEqual([JSON.stringify({ query: "why quiet tools hold attention" })]);
        await page.reload();
        await expect(find.getByRole("searchbox", { name: "Find" })).toHaveValue("");
        await expect(find.getByRole("radio", { name: "Text" })).toBeChecked();
        await page.waitForLoadState("networkidle");
        expect(searches, "a reload does not ask again").toHaveLength(1);
      } finally {
        page.off("request", recordSearch);
      }

      const term = pack.catalog_index.people[0].term;
      const href = await page.getByRole("tabpanel").getByRole("link", { name: term, exact: true }).getAttribute("href");
      if (!href) throw new Error(`${term} has no catalog link`);
      // A document load, so the keyboard walk still starts at the skip link.
      // A click would leave Chromium's tab sequence on the term page.
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 2, name: term, exact: true })).toBeVisible();
      const readings = page.getByRole("list", { name: "Readings" });
      await expect(readings.getByRole("listitem").first()).toBeVisible();
      await readings.getByRole("link").first().click();
      await page.getByRole("button", { name: "Back to catalog" }).click();
      await expect(page.getByRole("heading", { level: 2, name: term, exact: true })).toBeVisible();
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 2, name: term, exact: true })).toBeVisible();
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
    // The thread strip reads the relationship graph after hydration
    // (reading-lite-kl7y.3), and More like this its similar readings
    // (reading-lite-kl7y.5), so the page is measured with both in place.
    stub: (page) => serveReadingsInBrowser(page),
    prepare: async (page) => {
      const strip = page.getByRole("navigation", { name: "Thread" });
      await expect(strip.getByRole("link", { name: /^Earlier/ })).toBeVisible();
      await expect(strip.getByRole("link", { name: /^Later/ })).toBeVisible();
      await expect(page.getByRole("region", { name: "More like this" }).getByRole("link")).toHaveText([
        "Against the endless queue",
        "Reading on paper, again",
      ]);
    },
  },
  // The pack's two threads, its tension pairs, and the readings standing
  // alone, rendered on the server from the relationship graph (reading-lite-kl7y.3).
  {
    name: "threads-signed-in",
    path: "/threads",
    state: "signed-in",
    heading: "Threads",
    // Its links preload the readings they open.
    stub: (page) => serveReadingsInBrowser(page),
    prepare: async (page) => {
      const threads = page.getByRole("list", { name: "Threads" });
      await expect(threads.getByRole("link")).toHaveText(["Attention", "Notes"]);
      await expect(page.getByRole("list", { name: "Tensions" }).getByRole("listitem")).toHaveCount(2);
      await expect(page.getByRole("list", { name: "Readings standing alone" }).getByRole("listitem")).toHaveCount(4);
    },
  },
  // The next weekly digest as it stands, read in the browser (reading-lite-kl7y.10),
  // told on the reader's digest clock whatever the browser's zone.
  {
    name: "digest-signed-in",
    path: "/digest",
    state: "signed-in",
    heading: "Digest preview",
    stub: async (page) => {
      await serveDigestPreviewInBrowser(page);
      await serveReadingsInBrowser(page);
      await serveDeskInBrowser(page);
    },
    prepare: async (page) => {
      await expect(page.getByText("Goes out Monday 14 September at 08:00, Europe/London.")).toBeVisible();
      const mail = page.getByRole("article", { name: "Digest mail" });
      await expect(mail.getByText(E2E_DIGEST_PREVIEW.scheduled.subject)).toBeVisible();
      await expect(mail.getByRole("heading", { level: 2 })).toHaveText(
        E2E_DIGEST_PREVIEW.scheduled.items.map((item) => item.title),
      );
    },
  },
  // One thread, found by a member that is not its oldest reading.
  {
    name: "thread-signed-in",
    path: "/threads/rd_FXATTENT01",
    state: "signed-in",
    heading: "Attention",
    stub: (page) => serveReadingsInBrowser(page),
    prepare: async (page) => {
      await expect(page.getByRole("list", { name: "Readings in Attention" }).getByRole("listitem").first()).toBeVisible();
    },
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
