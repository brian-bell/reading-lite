// The Markdown inbox (reading-lite-fy8t) in a real browser. The component
// tests prove what renders for each answer; this proves what only a browser
// can: the writes carry the CSRF token and the tenant pin, adding an item
// opens the reading without a new document, and the discard dialog closes on
// Escape without sending anything and gives focus back.
//
// Requests only, so one viewport and theme; the matrix screenshots the pages
// and their states in every project. It uses Playwright's own `test`, as
// save.spec.ts does, so a pinned clock cannot hide a request.

import { expect, test as base } from "@playwright/test";
import { harnessBaseUrl } from "../harness";
import { serveInboxInBrowser, serveReadingsInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const PENDING = "rd_FXPENDNG01";
const TITLE = "Slow reading week";

test("adds an item to the library and opens the reading, without a new document", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const { promotes } = await serveInboxInBrowser(page);
  // The reading the add opens is read in the browser: the frontend Worker
  // answers /api/* with 404 by design (ADR 0003).
  await serveReadingsInBrowser(page);

  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
  });

  await page.goto("/inbox");
  await page.getByRole("link", { name: TITLE }).click();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByRole("region", { name: "Preview" })).toBeVisible();

  await page.getByRole("button", { name: "Add to library" }).click();
  await expect(page).toHaveURL(new RegExp(`/readings/${PENDING}$`));
  await expect(page.getByText("This reading is still being processed.")).toBeVisible();

  expect(promotes).toHaveLength(1);
  const promote = promotes[0]!;
  expect(promote.postDataJSON()).toEqual({});
  const headers = await promote.allHeaders();
  expect(headers["x-csrf-token"]).toBeTruthy();
  expect(headers["x-expected-tenant"]).toBeTruthy();
  expect(documents).toEqual(["/inbox"]);
});

test("discards only once confirmed, and returns to an inbox without the item", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  const { discards } = await serveInboxInBrowser(page);

  await page.goto(`/inbox/in_FXSLOW0001`);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const discard = page.getByRole("button", { name: "Discard…" });
  await discard.click();
  const dialog = page.getByRole("dialog", { name: "Discard this item?" });
  await expect(dialog).toBeVisible();
  // Cancel is where focus starts: nothing is deleted on one Enter.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(discard).toBeFocused();
  expect(discards).toHaveLength(0);

  await discard.click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeFocused();
  const list = page.getByRole("list", { name: "Inbox items" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("link", { name: TITLE })).toHaveCount(0);

  expect(discards).toHaveLength(1);
  const headers = await discards[0]!.allHeaders();
  expect(headers["x-csrf-token"]).toBeTruthy();
  expect(headers["x-expected-tenant"]).toBeTruthy();
});
