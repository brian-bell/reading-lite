// Saving a URL in a real browser (#431). The component tests prove what
// renders; this proves what only a browser can: the request the form makes
// carries the URL, the CSRF token, and the tenant pin, and the reading it
// created is opened without a new document.
//
// Requests only, so one viewport and theme; the matrix screenshots the page
// and its rejected states in every project. It uses Playwright's own `test`,
// as library.spec.ts does, so a pinned clock cannot hide a request.

import { expect, test as base, type Page, type Request } from "@playwright/test";
import { harnessBaseUrl } from "../harness";
import { serveReadingsInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const PENDING = "rd_FXPENDNG01";
const URL_TO_SAVE = "https://fieldnotes.example/making-room-for-slow-work";

/** The `activated` body src/router.ts returns for a fresh claim. */
const ACCEPTED = {
  id: PENDING,
  status: "pending",
  poll: `/api/readings/${PENDING}`,
  attempt_id: "att_FX0001",
};

/**
 * Answers the save with a 202, and records the POSTs. Only POST is fulfilled:
 * the library's own GET /api/readings has to fall through, or a later slice's
 * read would be answered by this route.
 */
function acceptSaves(page: Page): Request[] {
  const saves: Request[] = [];
  void page.route("**/api/readings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    saves.push(route.request());
    await route.fulfill({ status: 202, json: ACCEPTED });
  });
  return saves;
}

function field(page: Page) {
  return page.getByRole("textbox", { name: "URL" });
}

test("saves a URL and opens the reading it created, without a new document", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const saves = acceptSaves(page);
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
