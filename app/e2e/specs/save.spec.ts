// Saving a URL in a real browser (#431). The component tests prove what
// renders; this proves what only a browser can: the request the form makes
// carries the URL, the CSRF token, and the tenant pin, and the reading it
// created is opened without a new document.
//
// Requests only, so one viewport and theme; the matrix screenshots the page
// and its rejected states in every project. It uses Playwright's own `test`,
// as library.spec.ts does, so a pinned clock cannot hide a request.

import { expect, test as base, type Page } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "../harness";
import { serveReadingsInBrowser, serveSaveInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const PENDING = "rd_FXPENDNG01";
const READY = "rd_FXATTENT01";
const READY_TITLE = "A quieter internet is a choice we can make";
const URL_TO_SAVE = "https://fieldnotes.example/making-room-for-slow-work";

/** The `activated` body src/router.ts returns for a fresh claim. */
const ACCEPTED = {
  id: PENDING,
  status: "pending",
  poll: `/api/readings/${PENDING}`,
  attempt_id: "att_FX0001",
};

function field(page: Page) {
  return page.getByRole("textbox", { name: "URL" });
}

test("saves a URL and opens the reading it created, without a new document", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const saves = serveSaveInBrowser(page, { status: 202, json: ACCEPTED });
  // The reading the save opens is read in the browser: the frontend Worker
  // answers /api/* with 404 by design (ADR 0003).
  await serveReadingsInBrowser(page);

  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
  });

  await page.goto("/save");
  await expect(page.getByRole("heading", { level: 1, name: "Save reading" })).toBeVisible();
  // The capture surface: one tab, selected, with the field under it.
  await expect(page.getByRole("tab", { name: "URL" })).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toBeVisible();
  expect(documents).toEqual(["/save"]);

  await field(page).fill(URL_TO_SAVE);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`/readings/${PENDING}$`));
  await expect(page.getByText("This reading is still being processed.")).toBeVisible();

  expect(saves).toHaveLength(1);
  const save = saves[0]!;
  expect(save.postDataJSON()).toEqual({ url: URL_TO_SAVE });
  const headers = await save.allHeaders();
  expect(headers["content-type"]).toBe("application/json");
  // The session's CSRF token and the account the page was rendered for.
  expect(headers["x-csrf-token"]).toBeTruthy();
  expect(headers["x-expected-tenant"]).toBeTruthy();

  // Opening the reading was a client-side navigation.
  expect(documents).toEqual(["/save"]);
});

// A URL the reader already owns (#432). The notice belongs to the history
// entry the save wrote, which only a browser can prove: it is not in the URL,
// and a reload — a new document, with window.history.state still there — does
// not bring it back.
test("says a URL already in the library is, and forgets it on reload", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  await serveReadingsInBrowser(page);
  // 200 is the owning reading's manifest; this one is ready.
  serveSaveInBrowser(page, { status: 200, json: pack.readings[READY] });

  await page.goto("/save");
  await field(page).fill("https://quieter.example/a-quieter-internet");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`/readings/${READY}$`));
  // Exactly, because the novelty sentence on this reading says "readings
  // already in your library" and a substring match would find it too.
  const notice = page.getByText("Already in your library", { exact: true });
  await expect(notice).toHaveCount(1);
  // Above the reading it is about, and polite rather than focus-taking.
  await expect(notice).toHaveAttribute("role", "status");
  await expect(page.getByRole("heading", { level: 1, name: READY_TITLE })).toBeFocused();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: READY_TITLE })).toBeVisible();
  await expect(notice).toHaveCount(0);

  // A plain link to the same reading never carried it.
  await page.goto(`/readings/${READY}`);
  await expect(page.getByRole("heading", { level: 1, name: READY_TITLE })).toBeVisible();
  await expect(notice).toHaveCount(0);
});
