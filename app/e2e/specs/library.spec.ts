// The library in a real browser (#413, #414, #415, #416, #417). The component tests
// prove what renders; these prove what only a browser can: the page read on
// the server is not asked for again after hydration, a client-side visit or
// page change asks the same-origin API once and pinned to the account, a
// reload keeps the page, each card is one target from the pointer and the
// keyboard with or without a badge, at phone width a long title wraps whole
// while the summary clamps at three lines, the common states arrive on a
// page change with one request each, or none while offline, and a search or
// a tag is one request with the filter in it, while a filtered deep link and
// its reload make none.
//
// Requests only, so one viewport and theme; the matrix screenshots the page
// in every project. It uses Playwright's own `test` for the request tests, as
// reading-cache.spec.ts does, so a pinned clock cannot hide a refetch.

import { expect, test as base, type Page } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "../harness";
import { libraryBadge } from "../../src/library-card";
import { LibraryRowSchema } from "../../src/library";
import { LIBRARY_PAGE_SIZE, libraryItems, libraryPage } from "../library-page.js";
import { LIBRARY_STATE_SESSIONS, SESSION_EMAIL } from "../sessions";
import { serveLibraryInBrowser, serveReadingsInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const ITEMS = libraryItems(pack.list_index.items);
const FIRST_PAGE = libraryPage(ITEMS).readings;
const SECOND_PAGE = libraryPage(ITEMS, { offset: LIBRARY_PAGE_SIZE }).readings;
const TITLED = FIRST_PAGE.find((row): row is typeof row & { title: string } => "title" in row && !!row.title)!;
const READING = { path: "/readings/rd_FXATTENT01", heading: "A quieter internet is a choice we can make" };
const LONG_TITLE = FIRST_PAGE.find((row) => row.id === "rd_FXMAXNAME1")!;
const REPROCESS_FAILED = FIRST_PAGE.find((row) => row.id === "rd_FXREPROC01")!;
const PENDING = FIRST_PAGE.find((row) => row.id === "rd_FXPENDNG01")!;
const FAILED = FIRST_PAGE.find((row) => row.id === "rd_FXERR00001")!;
/** The page's badged rows, by the same rule the page applies. */
const BADGED = FIRST_PAGE.filter((row) => libraryBadge(LibraryRowSchema.parse(row)) !== undefined);
/** A lead long enough to overflow three lines at 390 px by a clear margin (200 characters). */
const LONG_LEAD = FIRST_PAGE.find((row) => row.id === "rd_FXATTENT01")!;

interface Recorded {
  lists: string[];
  documents: string[];
}

/** `GET /api/readings` (the list, not a reading) and document requests. */
function recordRequests(page: Page): Recorded {
  const recorded: Recorded = { lists: [], documents: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/readings") recorded.lists.push(`${url.pathname}${url.search}`);
    if (request.resourceType() === "document") recorded.documents.push(url.pathname);
  });
  return recorded;
}

function readings(page: Page) {
  return page.getByRole("list", { name: "Readings" });
}

function pager(page: Page) {
  return page.getByRole("navigation", { name: "Pagination" });
}

function titleOf(row: { url: string; title?: string }): string {
  return row.title || row.url;
}

async function openLibrary(page: Page, baseURL: string): Promise<Recorded> {
  await signIn(page.context(), baseURL);
  const recorded = recordRequests(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(readings(page).getByRole("listitem")).toHaveCount(FIRST_PAGE.length);
  await page.waitForLoadState("networkidle");
  return recorded;
}

test("hydrates the server-rendered first page without asking for it again", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  expect(recorded.documents).toEqual(["/"]);
  expect(recorded.lists).toEqual([]);
});

test("renders the pack's rows newest first, each title linking to its reading", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  const links = readings(page).getByRole("heading", { level: 2 }).getByRole("link");
  await expect(links).toHaveCount(FIRST_PAGE.length);
  for (const [index, row] of FIRST_PAGE.entries()) {
    await expect(links.nth(index)).toHaveAttribute("href", `/readings/${row.id}`);
  }
  await expect(readings(page).getByRole("link", { name: TITLED.title })).toBeVisible();
});

test("asks the same-origin API once, pinned, on a client-side visit", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  const pins: (string | null)[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/readings") pins.push(request.headers()["x-expected-tenant"] ?? null);
  });
  await page.goto(READING.path);
  await expect(page.getByRole("heading", { level: 1, name: READING.heading })).toBeVisible();
  await serveLibraryInBrowser(page);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click();
  await expect(readings(page).getByRole("listitem")).toHaveCount(FIRST_PAGE.length);
  await page.waitForLoadState("networkidle");

  expect(recorded.documents).toEqual([READING.path]);
  expect(recorded.lists).toEqual(["/api/readings?offset=0"]);
  expect(pins).toEqual(["usr_aaaaaaaa"]);
});

test("the whole card opens its reading", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  await serveReadingsInBrowser(page);
  const card = readings(page).getByRole("listitem").filter({ hasText: TITLED.title });
  // Away from the title: the stretched link covers the card's own padding.
  // A raw pointer click does not scroll, and the card may be below the fold.
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 6);
  await expect(page).toHaveURL(new RegExp(`/readings/${TITLED.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: TITLED.title })).toBeVisible();
});

test("the space beside a card's tags is still the card", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  await serveReadingsInBrowser(page);
  const card = readings(page).getByRole("listitem").filter({ has: page.getByRole("link", { name: TAGGED.title }) });
  const tags = card.locator(".library-card-tags");
  await tags.scrollIntoViewIfNeeded();
  const row = (await tags.boundingBox())!;
  const last = (await card.getByRole("link", { name: TAG, exact: true }).boundingBox())!;
  // Just right of the last tag, on the tags' own row.
  await page.mouse.click(last.x + last.width + 12, row.y + row.height / 2);
  await expect(page).toHaveURL(new RegExp(`/readings/${TAGGED.id}$`));
});

test("badges the pending, failed, and reprocess-failed rows, and only those", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  const items = readings(page).getByRole("listitem");
  const pending = items.filter({ hasText: PENDING.url });
  await expect(pending.locator(".status-badge")).toHaveText("Processing");
  const failed = items.filter({ hasText: FAILED.url });
  await expect(failed.locator(".status-badge")).toHaveText("Failed");
  await expect(failed.getByText("The page couldn't be fetched.")).toBeVisible();
  const reprocessFailed = items.filter({ hasText: REPROCESS_FAILED.title! });
  await expect(reprocessFailed.locator(".status-badge")).toHaveText("Reprocess failed");
  await expect(reprocessFailed.getByText(REPROCESS_FAILED.tldr!)).toBeVisible();
  // Every other row on the page is plainly ready.
  expect(BADGED.length).toBeGreaterThan(2);
  await expect(readings(page).locator(".status-badge")).toHaveCount(BADGED.length);
});

test("a badge does not break the card's target", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  await serveReadingsInBrowser(page);
  const card = readings(page).getByRole("listitem").filter({ hasText: REPROCESS_FAILED.title! });
  // The badge is text under the stretched link, so a pointer click on it
  // reaches the link. A raw click, since locator.click would report the link
  // intercepting the badge, which is the point.
  const badge = card.locator(".status-badge");
  await badge.scrollIntoViewIfNeeded();
  const box = (await badge.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(new RegExp(`/readings/${REPROCESS_FAILED.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: REPROCESS_FAILED.title })).toBeVisible();
});

test("at phone width a long title wraps whole and a summary clamps at three lines", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLibrary(page, baseURL!);
  const card = readings(page).getByRole("listitem").filter({ has: page.getByRole("link", { name: LONG_TITLE.title }) });
  const title = card.getByRole("heading", { level: 2 });
  await expect(title).toHaveText(LONG_TITLE.title!);
  const titleBox = await title.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
  }));
  expect(titleBox.scrollWidth, "the title never overflows its card").toBeLessThanOrEqual(titleBox.clientWidth);
  expect(titleBox.lines, "130 characters wrap onto several lines at 390 px").toBeGreaterThan(2);

  const summary = readings(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: LONG_LEAD.title }) })
    .locator(".library-card-summary");
  const summaryBox = await summary.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(summaryBox.scrollHeight, "the lead is longer than three lines here").toBeGreaterThan(summaryBox.clientHeight);
  expect(Math.round(summaryBox.clientHeight / summaryBox.lineHeight)).toBe(3);
});

test("a card opens from the keyboard", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  await serveReadingsInBrowser(page);
  const link = readings(page).getByRole("link", { name: TITLED.title });
  for (let i = 0; i < 40 && !(await link.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: TITLED.title })).toBeFocused();
});

test("Next and Previous change page through the same-origin API, once each", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page);

  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/\/\?offset=20$/);
  await expect(pager(page).getByText("Page 2")).toBeVisible();
  await expect(readings(page).getByRole("link").first()).toHaveText(titleOf(SECOND_PAGE[0]!));
  await page.waitForLoadState("networkidle");

  await pager(page).getByRole("link", { name: "Previous" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(pager(page).getByText("Page 1")).toBeVisible();
  await expect(readings(page).getByRole("link").first()).toHaveText(titleOf(FIRST_PAGE[0]!));
  await page.waitForLoadState("networkidle");

  // The first page came with the document and was not asked for again.
  expect(recorded.documents).toEqual(["/"]);
  expect(recorded.lists).toEqual(["/api/readings?offset=20"]);
});

test("a deep link to a later page renders it on the server, and a reload keeps it", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  for (const load of [() => page.goto("/?offset=20"), () => page.reload()]) {
    await load();
    await expect(pager(page).getByText("Page 2")).toBeVisible();
    await expect(readings(page).getByRole("listitem")).toHaveCount(SECOND_PAGE.length);
    await expect(readings(page).getByRole("link").first()).toHaveText(titleOf(SECOND_PAGE[0]!));
    await page.waitForLoadState("networkidle");
  }
  expect(recorded.documents).toEqual(["/", "/"]);
  expect(recorded.lists).toEqual([]);
});

test("Next is unavailable on the last page and the keyboard skips it", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  await page.goto("/?offset=40");
  await expect(pager(page).getByText("Page 3")).toBeVisible();
  const next = pager(page).getByRole("link", { name: "Next" });
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(next).not.toHaveAttribute("href", /./);

  const previous = pager(page).getByRole("link", { name: "Previous" });
  await previous.focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("nav[aria-label='Pagination']"))).toBeNull();
});

test("keeps the reader's place when the step they used becomes unavailable", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  await page.goto("/?offset=20");
  await expect(pager(page).getByText("Page 2")).toBeVisible();
  await serveLibraryInBrowser(page);

  // Entering the last page leaves Next with nowhere to go, and the new page is
  // a new mount, so the focus it held is gone. The page number takes it,
  // naming where the reader landed, instead of leaving them at the top of the
  // document.
  await pager(page).getByRole("link", { name: "Next" }).focus();
  await page.keyboard.press("Enter");
  await expect(pager(page).getByText("Page 3")).toBeVisible();
  // The step is unavailable from the moment the page is asked for (#416), and
  // the browser drops its focus a frame after the href goes.
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe("Page 3");
  await expect(readings(page).getByRole("listitem")).toHaveCount(3);
  await expect(pager(page).getByRole("link", { name: "Next" })).toHaveAttribute("aria-disabled", "true");

  // Tab carries on from the pager rather than from the top of the page.
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Previous");
});

test("a page past the end offers the first page, from the keyboard", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  await page.goto("/?offset=100");
  await expect(page.getByText("No readings on page 6.")).toBeVisible();
  await serveLibraryInBrowser(page);

  const first = page.getByRole("link", { name: "First page" });
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await expect(readings(page).getByRole("listitem")).toHaveCount(FIRST_PAGE.length);
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=0"]);
});

test("signed out, the sign-in form renders in place and no library is read", async ({ page }) => {
  const recorded = recordRequests(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual([]);
  await expect(readings(page)).toHaveCount(0);
});

// The common states (#416) after a page change: each is the answer to the one
// request the change makes, rendered on the page the URL names, with the
// session left alone unless it really ended.

test("a page change answered 403 shows permission denied and keeps the session", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page, [], () => ({ status: 403, body: { error: "forbidden" } }));

  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "You don't have access to this." })).toBeVisible();
  await expect(page).toHaveURL(/\/\?offset=20$/);
  await expect(page.getByText(SESSION_EMAIL)).toBeAttached();
  await expect(page.getByRole("main").getByRole("link", { name: "Back to library" })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=20"]);
});

test("a page change answered 412 asks for a reload", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page, [], () => ({
    status: 412,
    body: { error: "expected tenant mismatch", acting_tenant: "usr_bbbbbbbb" },
  }));

  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "This tab is signed in to a different account than the page expects." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByText("Signed in as usr_bbbbbbbb.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=20"]);
});

test("a page change answered 5xx offers Retry, which asks for that page again", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  let failing = true;
  await serveLibraryInBrowser(page, [], () =>
    failing
      ? { status: 503, body: { error: "backend unavailable" } }
      : { status: 200, body: libraryPage(ITEMS, { offset: LIBRARY_PAGE_SIZE }) },
  );

  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Something went wrong on our side." })).toBeVisible();
  await expect(page.getByText("backend unavailable")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=20"]);

  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(readings(page).getByRole("link").first()).toHaveText(titleOf(SECOND_PAGE[0]!));
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=20", "/api/readings?offset=20"]);
});

test("a page change answered 401 shows the expired session at that page's URL", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page, [], () => ({ status: 401, body: { error: "unauthorized" } }));

  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your session ended." })).toBeVisible();
  await expect(page).toHaveURL(/\/\?offset=20$/);
  await expect(page.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login?next=%2F%3Foffset%3D20",
  );
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=20"]);
});

test("offline, a page change says so without a request, and the page arrives once the network is back", async ({
  page,
  baseURL,
}) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page);

  await page.context().setOffline(true);
  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  const notice = page.getByRole("status");
  await expect(notice).toContainText("You're offline.");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page).toHaveURL(/\/\?offset=20$/);
  await expect(readings(page)).toHaveCount(0);
  expect(recorded.lists).toEqual([]);

  await page.context().setOffline(false);
  await expect(readings(page).getByRole("link").first()).toHaveText(titleOf(SECOND_PAGE[0]!));
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?offset=20"]);
});

test("a server-rendered permission denied keeps the account menu", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!, LIBRARY_STATE_SESSIONS.forbidden);
  const recorded = recordRequests(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "You don't have access to this." })).toBeVisible();
  await expect(page.getByText(SESSION_EMAIL)).toBeAttached();
  await page.waitForLoadState("networkidle");
  // A value, dehydrated with the page: nothing to ask again.
  expect(recorded.lists).toEqual([]);
});

// Search and tags (#417): each filter change is one same-origin request with
// the filter in it and the offset back at the first page; a filtered deep
// link renders on the server and a reload keeps it.

const SEARCH = "quiet";
const SEARCH_PAGE = libraryPage(ITEMS, { q: SEARCH }).readings;
const TAG = "design";
const TAG_PAGE = libraryPage(ITEMS, { tag: TAG }).readings;
/** A first-page row carrying TAG, whose card the tests click. */
const TAGGED = FIRST_PAGE.find((row) => row.id === "rd_FXATTENT01")!;

function searchField(page: Page) {
  return page.getByRole("searchbox", { name: "Search" });
}

function filterBar(page: Page) {
  return page.getByRole("search", { name: "Filter readings" });
}

test("a search is one request with q, from the first page, and the field keeps focus", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page);
  expect(SEARCH_PAGE.length).toBeGreaterThan(0);
  expect(SEARCH_PAGE.length).toBeLessThan(FIRST_PAGE.length);

  await searchField(page).fill(`  ${SEARCH} `);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/\\?q=${SEARCH}$`));
  await expect(readings(page).getByRole("listitem")).toHaveCount(SEARCH_PAGE.length);
  await expect(readings(page).getByRole("heading", { level: 2 }).first()).toHaveText(titleOf(SEARCH_PAGE[0]!));
  await expect(searchField(page)).toHaveValue(SEARCH);
  await expect(searchField(page)).toBeFocused();
  await expect(filterBar(page).getByRole("link", { name: `Clear search “${SEARCH}”` })).toHaveAttribute("href", "/");
  await page.waitForLoadState("networkidle");
  expect(recorded.documents).toEqual(["/"]);
  expect(recorded.lists).toEqual([`/api/readings?q=${SEARCH}&offset=0`]);
});

test("a search from a later page starts again from the first", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  await page.goto("/?offset=20");
  await expect(pager(page).getByText("Page 2")).toBeVisible();
  await serveLibraryInBrowser(page);

  await searchField(page).fill(SEARCH);
  await filterBar(page).getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?q=${SEARCH}$`));
  await expect(pager(page).getByText("Page 1")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual([`/api/readings?q=${SEARCH}&offset=0`]);
});

test("a tag on a card filters by it without opening the reading, and the chip takes focus", async ({ page, baseURL }) => {
  const recorded = await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page);
  await serveReadingsInBrowser(page);
  const card = readings(page).getByRole("listitem").filter({ has: page.getByRole("link", { name: TAGGED.title }) });
  const tag = card.getByRole("link", { name: TAG, exact: true });
  await expect(tag).toHaveAttribute("href", `/?tag=${TAG}`);

  await tag.click();
  await expect(page).toHaveURL(new RegExp(`/\\?tag=${TAG}$`));
  await expect(readings(page).getByRole("listitem")).toHaveCount(TAG_PAGE.length);
  // The active tag is text on every card, so none claims to be the current page.
  await expect(readings(page).getByRole("link", { name: TAG, exact: true })).toHaveCount(0);
  await expect(readings(page).locator(".tag-current")).toHaveCount(TAG_PAGE.length);
  const chip = filterBar(page).getByRole("link", { name: `Clear tag ${TAG}` });
  await expect(chip).toHaveText(new RegExp(`^${TAG}`));
  await expect(chip).toBeFocused();
  await page.waitForLoadState("networkidle");
  expect(recorded.documents).toEqual(["/"]);
  expect(recorded.lists).toEqual([`/api/readings?tag=${TAG}&offset=0`]);
});

test("a tag is its own target from the keyboard, after the card's title", async ({ page, baseURL }) => {
  await openLibrary(page, baseURL!);
  await serveLibraryInBrowser(page);
  const card = readings(page).getByRole("listitem").filter({ has: page.getByRole("link", { name: TAGGED.title }) });
  const title = card.getByRole("link", { name: TAGGED.title });
  await title.focus();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("link", { name: TAGGED.tags![0]!, exact: true })).toBeFocused();
  for (let i = 1; i < TAGGED.tags!.length; i += 1) await page.keyboard.press("Tab");
  await expect(card.getByRole("link", { name: TAG, exact: true })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/\\?tag=${TAG}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(readings(page).getByRole("listitem")).toHaveCount(TAG_PAGE.length);
});

test("the chip clears the tag, keeping the search, and the field takes focus", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  await page.goto(`/?q=a&tag=${TAG}&offset=20`);
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await serveLibraryInBrowser(page);

  await filterBar(page).getByRole("link", { name: `Clear tag ${TAG}` }).click();
  await expect(page).toHaveURL(/\/\?q=a$/);
  await expect(filterBar(page).getByRole("link", { name: /^Clear tag/ })).toHaveCount(0);
  await expect(searchField(page)).toHaveValue("a");
  await expect(searchField(page)).toBeFocused();
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual(["/api/readings?q=a&offset=0"]);
});

test("a filtered deep link renders on the server, and a reload keeps it", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  const both = libraryPage(ITEMS, { q: "a", tag: TAG }).readings;
  expect(both.length).toBeGreaterThan(0);
  for (const load of [() => page.goto(`/?q=a&tag=${TAG}`), () => page.reload()]) {
    await load();
    await expect(page).toHaveURL(new RegExp(`/\\?q=a&tag=${TAG}$`));
    await expect(readings(page).getByRole("listitem")).toHaveCount(both.length);
    await expect(searchField(page)).toHaveValue("a");
    await expect(filterBar(page).getByRole("link", { name: `Clear tag ${TAG}` })).toHaveAttribute("href", "/?q=a");
    await page.waitForLoadState("networkidle");
  }
  expect(recorded.documents).toEqual(["/", "/"]);
  expect(recorded.lists).toEqual([]);
});

test("no results name the search and the tag, and each clear control is one request", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const recorded = recordRequests(page);
  await page.goto(`/?q=zzzz&tag=${TAG}`);
  const message = page.getByText(`No readings match “zzzz” tagged ${TAG}.`);
  await expect(message).toBeVisible();
  await expect(readings(page)).toHaveCount(0);
  await expect(pager(page)).toHaveCount(0);
  await serveLibraryInBrowser(page);

  const actions = message.locator("xpath=..").getByRole("link");
  await expect(actions).toHaveText(["Clear search", "Clear tag"]);
  await actions.filter({ hasText: "Clear search" }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?tag=${TAG}$`));
  await expect(readings(page).getByRole("listitem")).toHaveCount(TAG_PAGE.length);
  await expect(searchField(page)).toBeFocused();
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual([`/api/readings?tag=${TAG}&offset=0`]);
});

test("an empty library offers to save a reading", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!, LIBRARY_STATE_SESSIONS.empty);
  await page.goto("/");
  await expect(page.getByText("No readings yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Save a reading" })).toHaveAttribute("href", "/save");
  await expect(page.getByRole("link", { name: /^Clear/ })).toHaveCount(0);
  await expect(pager(page)).toHaveCount(0);
});
