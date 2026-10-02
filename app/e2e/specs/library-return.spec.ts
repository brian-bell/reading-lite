// The way back to the library in a real browser (#407; design spec, Routes and
// navigation state). The component tests prove which entry "Back to library"
// goes back to; these prove what only a browser can: the library comes back at
// the URL and scroll position the reader left, by that control and by browser
// Back, and a new reading starts at the top, at 390 px and 1440 px.
//
// The pack's tags are on a handful of rows, so a tag-filtered search has one
// page. The browser is served a larger library for the filtered pages instead,
// reached client-side from a server-rendered reading: its tag link, a search,
// then Next twice to page 3.

import { type Page } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { libraryPage } from "../library-page.js";
import { expect, openCase, serveLibraryInBrowser, serveReadingsInBrowser, test } from "../test";

const ATTENTION = {
  path: "/readings/rd_FXATTENT01",
  heading: "A quieter internet is a choice we can make",
  state: "signed-in" as const,
};
const LIBRARY_URL = "/?tag=attention&q=essay&offset=40";

// 55 rows tagged "attention" matching "essay": three pages, the last with 15.
const TAGGED = Array.from({ length: 55 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  const created_at = new Date(Date.parse(pack.generated_at) - (index + 1) * 3_600_000).toISOString();
  return {
    id: `rd_FXRETURN${n}`,
    url: `https://return.example/essays/${n}`,
    status: "ready" as const,
    created_at,
    updated_at: created_at,
    title: `Attention essay ${n}`,
    tldr: "A generated row, so a tag-filtered search has a third page.",
    tags: ["attention"],
    keywords: [],
  };
});
/** The row the reader opens: far enough down page 3 that the page is scrolled. */
const OPENED = TAGGED[52]!;

/** Each generated reading, as the attention reading with its own id and title. */
const TAGGED_READINGS = Object.fromEntries(
  TAGGED.map((row) => [row.id, { ...pack.readings.rd_FXATTENT01, id: row.id, url: row.url, title: row.title }]),
);

function readings(page: Page) {
  return page.getByRole("list", { name: "Readings" });
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

/** Page 3 of the tag-filtered search, reached as a reader would, scrolled down to the opened card. */
async function openFilteredPage(page: Page, baseURL: string, delayMs = 0): Promise<number> {
  await openCase(page, baseURL, ATTENTION);
  await serveReadingsInBrowser(page, TAGGED_READINGS);
  await serveLibraryInBrowser(page, [], (url) => ({
    delayMs,
    status: 200,
    body: libraryPage(TAGGED, {
      q: url.searchParams.get("q") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      offset: Number(url.searchParams.get("offset") ?? 0),
    }),
  }));

  // A click before hydration follows the link natively, and the server's
  // fixture-pack library answers instead of the browser stub.
  await page.waitForLoadState("networkidle");
  await page.getByRole("list", { name: "Tags" }).getByRole("link", { name: "attention" }).click();
  await expect(readings(page).getByRole("listitem")).toHaveCount(20);
  await page.getByRole("searchbox", { name: "Search" }).fill("essay");
  await page.getByRole("search", { name: "Filter readings" }).getByRole("button", { name: "Search" }).click();
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await pager.getByRole("link", { name: "Next" }).click();
  await expect(page.getByRole("link", { name: "Attention essay 21" })).toBeVisible();
  await pager.getByRole("link", { name: "Next" }).click();
  await expect(readings(page).getByRole("listitem")).toHaveCount(15);
  await expect(page).toHaveURL(LIBRARY_URL);

  await page.getByRole("link", { name: OPENED.title }).scrollIntoViewIfNeeded();
  const left = await scrollY(page);
  expect(left, "the library is scrolled before the reading opens").toBeGreaterThan(0);
  return left;
}

async function openReading(page: Page): Promise<void> {
  await page.getByRole("link", { name: OPENED.title }).click();
  await expect(page.getByRole("heading", { level: 1, name: OPENED.title })).toBeVisible();
}

async function expectLibraryAsLeft(page: Page, left: number): Promise<void> {
  await expect(page).toHaveURL(LIBRARY_URL);
  await expect(page.getByRole("link", { name: OPENED.title })).toBeVisible();
  await expect.poll(() => scrollY(page)).toBeCloseTo(left, 0);
}

for (const [size, viewport] of Object.entries({ phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 932 } })) {
  test.describe(`at ${viewport.width} px`, () => {
    test.use({ viewport });

    test(`${size}: a new reading starts at the top, and "Back to library" restores the page and its scroll`, async ({ page, baseURL }) => {
      const left = await openFilteredPage(page, baseURL!);
      await openReading(page);
      await expect.poll(() => scrollY(page)).toBe(0);

      await page.getByRole("button", { name: "Back to library" }).click();
      await expectLibraryAsLeft(page, left);
    });

    test(`${size}: browser Back restores the page and its scroll`, async ({ page, baseURL }) => {
      const left = await openFilteredPage(page, baseURL!);
      await openReading(page);

      await page.goBack();
      await expectLibraryAsLeft(page, left);
    });

    // Past the library query's cache time the page is read again on return, so
    // it renders loading first and the rows arrive after scroll restoration ran.
    test(`${size}: the scroll comes back after the page had to be read again`, async ({ page, baseURL }) => {
      await page.clock.install({ time: new Date(pack.generated_at) });
      const left = await openFilteredPage(page, baseURL!, 400);
      await openReading(page);
      await page.clock.runFor("31:00");

      await page.getByRole("button", { name: "Back to library" }).click();
      await expect(page.getByRole("list", { name: "Readings" })).toHaveCount(0);
      await expectLibraryAsLeft(page, left);
    });
  });
}
