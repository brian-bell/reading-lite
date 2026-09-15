// The library's first page in a real browser (#413). The component tests prove
// what renders; these prove what only a browser can: the page read on the
// server is not asked for again after hydration, a client-side visit asks the
// same-origin API once and pinned to the account, and each card is one target
// from the pointer and the keyboard.
//
// Requests only, so one viewport and theme; the matrix screenshots the page
// in every project. It uses Playwright's own `test` for the request tests, as
// reading-cache.spec.ts does, so a pinned clock cannot hide a refetch.

import { expect, test as base, type Page } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "../harness";
import { libraryPage } from "../library-page.js";
import { serveLibraryInBrowser, serveReadingsInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const FIRST_PAGE = libraryPage(pack.list_index.items).readings;
const TITLED = FIRST_PAGE.find((row): row is typeof row & { title: string } => "title" in row && !!row.title)!;
const READING = { path: "/readings/rd_FXATTENT01", heading: "A quieter internet is a choice we can make" };

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
  const links = readings(page).getByRole("link");
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
  const box = (await card.boundingBox())!;
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 6);
  await expect(page).toHaveURL(new RegExp(`/readings/${TITLED.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: TITLED.title })).toBeVisible();
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

test("signed out, the sign-in form renders in place and no library is read", async ({ page }) => {
  const recorded = recordRequests(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.waitForLoadState("networkidle");
  expect(recorded.lists).toEqual([]);
  await expect(readings(page)).toHaveCount(0);
});
