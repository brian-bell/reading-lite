// The reading is read once, on the server (#370, "not refetched after
// hydration"). Every request for the reading or for identity is recorded, so
// the assertion is on what the browser did not do: neither is asked for after
// hydration, nor when the reader leaves for the library and comes back,
// because the router navigates in place and the query is served from the
// cache it hydrated. Other API traffic is not the test's concern: the library
// will ask for its rows once it reads them (#339), and that must not fail a
// test about the reading. A full document reload would also pass the API
// check, so the document requests are counted too: one, the first.
//
// Runs in its own project because it is about requests, not rendering, and
// one viewport and theme is enough to prove them. It uses Playwright's own
// `test`, not the suite's: that one pins the browser clock to the fixture
// pack's date, which is earlier than the hydrated data's timestamp, so no
// staleTime could ever expire and a query that refetched would pass here.
// The reading under test shows no relative time, so it needs no pinning.

import { expect, test as base, type Page } from "@playwright/test";
import { harnessBaseUrl } from "../harness";
import { signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const READING = { path: "/readings/rd_FXATTENT01", heading: "A quieter internet is a choice we can make" };

/** The two requests the server render already answered. */
const CRITICAL_API_PATHS = new Set(["/api/whoami", `/api${READING.path}`]);

interface Recorded {
  api: string[];
  documents: string[];
}

function recordRequests(page: Page): Recorded {
  const recorded: Recorded = { api: [], documents: [] };
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (CRITICAL_API_PATHS.has(pathname)) recorded.api.push(`${request.method()} ${pathname}`);
    if (request.resourceType() === "document") recorded.documents.push(pathname);
  });
  return recorded;
}

async function openReading(page: Page, baseURL: string): Promise<Recorded> {
  await signIn(page.context(), baseURL);
  const recorded = recordRequests(page);
  await page.goto(READING.path);
  await expect(page.getByRole("heading", { level: 1, name: READING.heading })).toBeVisible();
  // Hydration has run once the scripts are loaded and the page goes quiet.
  await page.waitForLoadState("networkidle");
  return recorded;
}

test("hydrates the server-rendered reading without asking for it again", async ({ page, baseURL }) => {
  const recorded = await openReading(page, baseURL!);
  expect(recorded.documents).toEqual([READING.path]);
  expect(recorded.api).toEqual([]);
});

test("reuses the cached reading when the reader comes back to it", async ({ page, baseURL }) => {
  const recorded = await openReading(page, baseURL!);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: READING.heading })).toBeVisible();
  // Focus lands on the heading after a route change (design spec, Keyboard,
  // focus, and motion), for the return trip as much as the outward one.
  await expect(page.getByRole("heading", { level: 1, name: READING.heading })).toBeFocused();
  await page.waitForLoadState("networkidle");

  expect(recorded.documents).toEqual([READING.path]);
  expect(recorded.api).toEqual([]);
});
