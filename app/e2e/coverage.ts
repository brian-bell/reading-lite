// Everything the browser-evidence suite covers, in one place (issue #374).
//
// Add a route or a state by adding a case here: every project in
// playwright.config.ts — 390 px and 1440 px, light and dark — then runs axe,
// the keyboard pass, and a screenshot against it. Mark it `essential` only if
// it is a major state of a route (the library, a ready, pending, failed, and
// missing reading, sign-in, save, one trail hop, Source, Details): CI runs
// those alone (e2e/scope.ts) and the rest locally. `fixture` names a state from
// the fixture pack (docs/design/connected/fixture-pack.md); e2e/backend-stub.js
// serves it from e2e/fixtures/fixture-pack.json, so a new fixture state is one
// edit in test/fixtures/local-seed.ts plus `npm run fixtures:app` at the repo
// root.

import { expect, type Page } from "@playwright/test";
import pack from "./fixtures/fixture-pack.json" with { type: "json" };
import { EVIDENCE_SCOPE } from "./scope";
import { LIBRARY_STATE_SESSIONS } from "./sessions";
import { serveDiagnosticsInBrowser, serveLibraryInBrowser, serveReadingsInBrowser, serveSourceInBrowser } from "./test";

export type SignedState = "signed-out" | "signed-in";

export interface EvidenceCase {
  /** Test name and screenshot file name. */
  name: string;
  path: string;
  state: SignedState;
  /** The `<h1>` that proves the page rendered before anything is measured. */
  heading: string;
  /** Part of the essential scope CI runs (e2e/scope.ts). */
  essential?: true;
  /**
   * A session cookie other than the default reader's, for a backend-stub
   * scenario (#416). Signs the context in whatever `state` says the page
   * then shows: an ended session renders the signed-out shell.
   */
  session?: string;
  /** Fixture-pack state this case reads, once routes read readings (#369+). */
  fixture?: string;
  /** Routes the browser's own requests before the page loads, for a state the load itself must reach. */
  stub?: (page: Page) => Promise<void>;
  /** Reaches the state under test after load: open a disclosure, follow a link. */
  prepare?: (page: Page) => Promise<void>;
}

export const ALL_EVIDENCE_CASES: EvidenceCase[] = [
  // Signed out, the library renders the sign-in form in place (#369), so its
  // heading is the form's.
  { name: "library-signed-out", essential: true, path: "/", state: "signed-out", heading: "Sign in" },
  // Signed in, the first page of the pack's list index, rendered on the server
  // (#413). The pack's pending, failed, reprocess-failed, and long-title rows
  // are all on it (#415), so this one page is the evidence for the badges, the
  // wrapped title, and the clamped summaries in every viewport and theme.
  {
    name: "library-signed-in",
    essential: true,
    path: "/",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      const list = page.getByRole("list", { name: "Readings" });
      await expect(list.getByRole("listitem").first()).toBeVisible();
      await expect(list.getByText("Reprocess failed")).toBeVisible();
      await expect(list.getByRole("link", { name: /^What we lose when every tool/ })).toBeVisible();
    },
  },
  // Pages (#414): with the generated rows past the pack's 19 there are 43 rows,
  // so page 2 is a middle page, page 3 the last (no Next), and page 6 is past
  // the end. Each is a deep link, rendered on the server.
  {
    name: "library-page-2",
    path: "/?offset=20",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByRole("navigation", { name: "Pagination" }).getByText("Page 2")).toBeVisible();
    },
  },
  {
    name: "library-last-page",
    path: "/?offset=40",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByRole("navigation", { name: "Pagination" }).getByText("Page 3")).toBeVisible();
    },
  },
  {
    name: "library-offset-past-end",
    path: "/?offset=100",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByText("No readings on page 6.")).toBeVisible();
    },
  },
  // Search and tags (#417). Each is a deep link rendered on the server: a
  // search that matches some of the pack, the tag four of its rows carry, and
  // the no-results states for a search, a tag, and both. "No readings yet."
  // needs a session with nothing saved.
  {
    name: "library-search",
    essential: true,
    path: "/?q=quiet",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("quiet");
      await expect(page.getByRole("list", { name: "Readings" }).getByRole("listitem").first()).toBeVisible();
      await expect(page.getByRole("search").getByRole("link", { name: "Clear search “quiet”" })).toBeVisible();
    },
  },
  {
    name: "library-tag",
    path: "/?tag=design",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByRole("search").getByRole("link", { name: "Clear tag design" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Readings" }).getByRole("listitem")).toHaveCount(4);
    },
  },
  {
    name: "library-no-results-search",
    path: "/?q=zzzz",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByText("No readings match “zzzz”.")).toBeVisible();
    },
  },
  {
    name: "library-no-results-tag",
    path: "/?tag=nothing",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByText("No readings tagged nothing.")).toBeVisible();
    },
  },
  {
    name: "library-no-results-both",
    path: "/?q=zzzz&tag=design",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByText("No readings match “zzzz” tagged design.")).toBeVisible();
    },
  },
  {
    name: "library-empty",
    essential: true,
    path: "/",
    state: "signed-in",
    session: LIBRARY_STATE_SESSIONS.empty,
    heading: "Library",
    prepare: async (page) => {
      await expect(page.getByText("No readings yet.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Save a reading" })).toBeVisible();
    },
  },
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
  // The common states on the library (#416). The session-ended, forbidden,
  // and account-changed pages are rendered on the server, from sessions whose
  // list answers that state. A failed list is not dehydrated, so its page goes
  // out busy and the browser's own request shows the error; offline is reached
  // in the browser, by changing page with the network gone.
  {
    name: "library-session-ended",
    essential: true,
    path: "/",
    state: "signed-out",
    session: LIBRARY_STATE_SESSIONS["session-ended"],
    heading: "Your session ended.",
  },
  {
    name: "library-forbidden",
    path: "/",
    state: "signed-in",
    session: LIBRARY_STATE_SESSIONS.forbidden,
    heading: "You don't have access to this.",
  },
  {
    name: "library-account-changed",
    path: "/",
    state: "signed-in",
    session: LIBRARY_STATE_SESSIONS["account-changed"],
    heading: "This tab is signed in to a different account than the page expects.",
  },
  {
    name: "library-server-error",
    essential: true,
    path: "/",
    state: "signed-in",
    session: LIBRARY_STATE_SESSIONS["server-error"],
    heading: "Something went wrong on our side.",
    // The failed server read is not dehydrated, so the browser asks again on
    // load; routed before the load, that request gets the backend's answer.
    stub: async (page) => {
      await serveLibraryInBrowser(page, [], () => ({ status: 503, body: { error: "backend unavailable" } }));
    },
    prepare: async (page) => {
      await expect(page.getByText("backend unavailable")).toBeVisible();
    },
  },
  {
    name: "library-offline",
    path: "/",
    state: "signed-in",
    heading: "Library",
    prepare: async (page) => {
      // Until hydration attaches the router, Next is a plain anchor and the
      // click is a full navigation, which offline is a browser error page
      // rather than this state. Network idle after the load is the same
      // signal library.spec.ts uses before its page changes.
      await page.waitForLoadState("networkidle");
      await page.context().setOffline(true);
      await page.getByRole("navigation", { name: "Pagination" }).getByRole("link", { name: "Next" }).click();
      await expect(page.getByRole("status")).toContainText("You're offline.");
      // The click leaves focus on Next, the page's last tab stop; start the
      // keyboard walk from the heading, as a route change would.
      await page.locator("#main h1").focus();
    },
  },
  { name: "save-signed-out", path: "/save", state: "signed-out", heading: "Save reading" },
  { name: "save-signed-in", essential: true, path: "/save", state: "signed-in", heading: "Save reading" },
  { name: "login", essential: true, path: "/login", state: "signed-out", heading: "Sign in" },

  // Reading detail (#370). Each heading is the page's own <h1>: the title for a
  // reading that has one, the URL for a failed manifest (which never got one),
  // and the state's sentence where there is no reading to show.
  {
    name: "reading-ready",
    essential: true,
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
  // The Summary view's own states (#370): the sparse-archive sentence, the
  // degraded-YouTube notice, and an old manifest with no novelty panel at all.
  {
    name: "reading-sparse-archive",
    path: "/readings/rd_FXSPARSE01",
    state: "signed-in",
    heading: "Against the endless queue",
    fixture: "sparse-archive",
  },
  {
    name: "reading-degraded-youtube",
    path: "/readings/rd_FXYTDEGRD1",
    state: "signed-in",
    heading: "Building a quiet reading app — chapter 4",
    fixture: "degraded-youtube",
  },
  {
    name: "reading-old-manifest",
    path: "/readings/rd_FXPAST0001",
    state: "signed-in",
    heading: "Before the archive",
    fixture: "old-manifest",
  },
  {
    name: "reading-pending",
    essential: true,
    path: "/readings/rd_FXPENDNG01",
    state: "signed-in",
    heading: "https://fieldnotes.example/making-room-for-slow-work",
    fixture: "pending",
  },
  {
    name: "reading-failed",
    essential: true,
    path: "/readings/rd_FXERR00001",
    state: "signed-in",
    heading: "https://registration-wall.example/members-only-report",
    fixture: "fail-source-unreachable",
  },
  // The pack's removed target: referenced by `attention` but never written, so
  // the route 404s (docs/design/connected/fixture-pack.md).
  {
    name: "reading-not-found",
    essential: true,
    path: "/readings/rd_FXVANSHD01",
    state: "signed-in",
    heading: "This reading isn't in your library.",
  },

  // Connections and tensions (#371). `attention` (reading-ready above) has
  // connections, a removed target, and a tension; `gardens` has a pending and
  // a failed target. The trail states are reached by following cards, so the
  // browser needs the readings served (serveReadingsInBrowser).
  {
    name: "reading-connections-non-ready",
    path: "/readings/rd_FXGARDEN01",
    state: "signed-in",
    heading: "Libraries are gardens, not warehouses",
    fixture: "gardens",
  },
  {
    name: "reading-trail-one-hop",
    essential: true,
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
    prepare: async (page) => {
      await serveReadingsInBrowser(page);
      await followCard(page, "Libraries are gardens, not warehouses");
    },
  },
  {
    name: "reading-trail-two-hops",
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
    prepare: async (page) => {
      await serveReadingsInBrowser(page);
      await followCard(page, "Libraries are gardens, not warehouses");
      await followCard(page, "A quieter internet is a choice we can make");
    },
  },
  // Arrived from a removed target: the target was in the map when its card
  // rendered and gone when followed. `attention` is served to the browser with
  // the removed id resolved, so its card links; the id itself still 404s.
  {
    name: "reading-not-found-from-trail",
    path: "/readings/rd_FXGARDEN01",
    state: "signed-in",
    heading: "Libraries are gardens, not warehouses",
    fixture: "gardens",
    prepare: async (page) => {
      const attention = pack.readings.rd_FXATTENT01;
      await serveReadingsInBrowser(page, {
        rd_FXATTENT01: {
          ...attention,
          relationship_targets: {
            ...attention.relationship_targets,
            [pack.removed_target_id]: { url: "https://feeds.example/infinite", title: "Infinite feeds", status: "ready" },
          },
        },
      });
      await followCard(page, "A quieter internet is a choice we can make");
      await followCard(page, "Infinite feeds", "This reading isn't in your library.");
    },
  },

  // The Source view (#372). `attention` selects Source from the Summary tab,
  // which proves the tab switch and the on-demand fetch; `imported-markdown`
  // deep-links to `?view=source` and carries the rich content the spec covers
  // (table, code block, image placeholder, raw HTML, an unbreakable link);
  // `unavailable-source` is the raw_only manifest, unavailable without a
  // request.
  {
    name: "reading-source",
    essential: true,
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
    prepare: async (page) => {
      await serveSourceInBrowser(page);
      await selectSourceView(page);
    },
  },
  {
    name: "reading-source-rich",
    path: "/readings/rd_FXMDPAGE01?view=source",
    state: "signed-in",
    heading: "Slow reading week",
    fixture: "imported-markdown",
    prepare: async (page) => {
      await serveSourceInBrowser(page);
      await page.reload();
      await expect(page.getByRole("tabpanel", { name: "Source" }).getByRole("table")).toBeVisible();
    },
  },
  {
    name: "reading-source-unavailable",
    path: "/readings/rd_FXRAWSRC01?view=source",
    state: "signed-in",
    heading: "The web we can no longer revisit",
    fixture: "unavailable-source",
  },

  // The Details disclosure (#373): collapsed is every reading case above.
  // Open on `attention` shows entities, similarity numbers, both files, and
  // loaded diagnostics with a succeeded attempt; the failed reading's open
  // section shows a failed attempt and only the raw file; and the diagnostics
  // loading and failed states are reached by holding and failing the request.
  {
    name: "reading-details-open",
    essential: true,
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
    prepare: async (page) => {
      await serveDiagnosticsInBrowser(page);
      await openDetails(page);
      await expect(page.getByText("Storage key")).toBeVisible();
    },
  },
  {
    name: "reading-details-failed-reading",
    path: "/readings/rd_FXERR00001",
    state: "signed-in",
    heading: "https://registration-wall.example/members-only-report",
    fixture: "fail-source-unreachable",
    prepare: async (page) => {
      await serveDiagnosticsInBrowser(page);
      await openDetails(page);
      await expect(page.getByRole("article", { name: "Saved attempt" })).toBeVisible();
    },
  },
  {
    name: "reading-details-diagnostics-loading",
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
    prepare: async (page) => {
      // Never answered: the section stays in its loading state.
      await serveDiagnosticsInBrowser(page, async () => undefined);
      await openDetails(page);
      await expect(page.getByText("Loading diagnostics…")).toBeVisible();
    },
  },
  {
    name: "reading-details-diagnostics-failed",
    path: "/readings/rd_FXATTENT01",
    state: "signed-in",
    heading: "A quieter internet is a choice we can make",
    fixture: "attention",
    prepare: async (page) => {
      await serveDiagnosticsInBrowser(page, (route) =>
        route.fulfill({ status: 503, json: { error: "storage unavailable" } }),
      );
      await openDetails(page);
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    },
  },
];

/** The cases this run covers: every case in full, the `essential` ones in CI. */
export const EVIDENCE_CASES: EvidenceCase[] =
  EVIDENCE_SCOPE === "full" ? ALL_EVIDENCE_CASES : ALL_EVIDENCE_CASES.filter((evidence) => evidence.essential);

/** Opens the Details disclosure. */
export async function openDetails(page: Page): Promise<void> {
  await page.locator("details.reading-details > summary").click();
  await expect(page.locator("details.reading-details[open]")).toBeVisible();
}

/** Selects the Source tab and waits for the source to render. */
export async function selectSourceView(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.getByRole("tabpanel", { name: "Source" }).locator(".reading-source")).toBeVisible();
}

/** Follows a relationship card by its title and waits for the destination's heading. */
export async function followCard(page: Page, title: string, heading = title): Promise<void> {
  await page.getByRole("complementary", { name: "Connections & tensions" }).getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}
