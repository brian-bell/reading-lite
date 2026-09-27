// Reprocess (#410) and Import a copy (#411) in a real browser. The component
// tests (test/reading-reprocess.test.tsx, test/reading-import.test.tsx) own
// Retry, the outcomes, and the guards, and test/reprocess-api.test.ts owns the
// request body (never `force`); this proves what only a browser's modal
// `<dialog>` does: Escape closes it without a request, the page behind it is
// out of reach, and focus comes back to the button that opened it however it
// closed.
//
// Requests and focus only, so one viewport and theme; the matrix screenshots
// the dialog and runs axe and the keyboard pass in every project.

import { expect, test as base, type Page, type Request } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "../harness";
import { runningOver } from "../running-over";
import { serveReadingsInBrowser, serveReprocessInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const READY = pack.readings.rd_FXATTENT01;
const FAILED = pack.readings.rd_FXERR00002;

/** Serves reads from the pack until a reprocess is accepted, then the running attempt. */
async function openWithReprocess(page: Page, baseURL: string, reading: { id: string; status: string }): Promise<Request[]> {
  await signIn(page.context(), baseURL);
  const reprocesses = serveReprocessInBrowser(page, (id) => ({
    status: 202,
    json: { id, status: "pending", poll: `/api/readings/${id}`, attempt_id: "at_NEW01" },
  }));
  await serveReadingsInBrowser(page, {}, [], (id) =>
    id === reading.id && reprocesses.length > 0 ? { status: 200, body: runningOver(reading) } : undefined,
  );
  await page.goto(`/readings/${reading.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return reprocesses;
}

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Reprocess this reading?" });
}

for (const close of ["Escape", "Cancel"] as const) {
  test(`${close} closes the confirmation without a request and returns focus to Reprocess`, async ({
    page,
    baseURL,
  }) => {
    const reprocesses = await openWithReprocess(page, baseURL!, READY);
    const reprocess = page.getByRole("button", { name: "Reprocess" });

    await reprocess.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    // A paid run is never one Enter away.
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();

    if (close === "Escape") await page.keyboard.press("Escape");
    else await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(reprocess).toBeFocused();
    // Cancel's "sends nothing" is the component test's; Escape is the browser's.
    if (close === "Escape") expect(reprocesses).toEqual([]);
  });
}

test("the page behind the confirmation cannot be reached while it is open", async ({ page, baseURL }) => {
  await openWithReprocess(page, baseURL!, READY);
  await page.getByRole("button", { name: "Reprocess" }).click();
  await expect(dialog(page)).toBeVisible();

  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab");
    const { inDialog, onPage } = await page.evaluate(() => ({
      inDialog: document.activeElement?.closest("dialog") !== null,
      onPage: document.activeElement !== document.body && document.activeElement !== null,
    }));
    // Focus stays in the dialog, or leaves for the browser's own chrome.
    expect(inDialog || !onPage).toBe(true);
  }
});

test("confirming returns focus to Reprocess, which stays while the attempt runs", async ({ page, baseURL }) => {
  await openWithReprocess(page, baseURL!, READY);
  const reprocess = page.getByRole("button", { name: "Reprocess" });

  await reprocess.click();
  await dialog(page).getByRole("button", { name: "Reprocess" }).click();

  await expect(page.getByLabel("Processing status")).toBeVisible();
  await expect(reprocess).toBeFocused();
});

function importDialog(page: Page) {
  return page.getByRole("dialog", { name: "Import a copy" });
}

test("Escape closes Import a copy without a request and returns focus to it", async ({ page, baseURL }) => {
  const reprocesses = await openWithReprocess(page, baseURL!, FAILED);
  const importCopy = page.getByRole("button", { name: "Import a copy" });

  await importCopy.click();
  await expect(importDialog(page).getByRole("textbox", { name: "Markdown" })).toBeFocused();
  await importDialog(page).getByRole("textbox", { name: "Markdown" }).fill("# A copy");
  await page.keyboard.press("Escape");

  await expect(importDialog(page)).toHaveCount(0);
  await expect(importCopy).toBeFocused();
  expect(reprocesses).toEqual([]);
});

// Import a copy goes with the failure once the attempt starts; the card's
// first control, Retry turned Check status, is where focus comes back to.
test("an import that starts closes the dialog and gives focus to the status card", async ({ page, baseURL }) => {
  const reprocesses = await openWithReprocess(page, baseURL!, FAILED);

  await page.getByRole("button", { name: "Import a copy" }).click();
  await importDialog(page).getByRole("textbox", { name: "Markdown" }).fill("# A copy\n\nThe whole article.");
  await importDialog(page).getByRole("button", { name: "Import" }).click();

  await expect(importDialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check status" })).toBeFocused();
  expect(reprocesses).toHaveLength(1);
});
