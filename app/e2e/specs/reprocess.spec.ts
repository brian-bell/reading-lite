// Retry and Reprocess in a real browser (#410). The component tests own the
// outcomes and the guards; this proves what only a browser can: the modal
// `<dialog>` closes on Escape and on Cancel without a request, focus returns
// to the button that opened it, and the requests the page sends carry an empty
// body — never `force`.
//
// Requests and focus only, so one viewport and theme; the matrix screenshots
// the dialog and runs axe and the keyboard pass in every project.

import { expect, test as base, type Page, type Request } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "../harness";
import { serveReadingsInBrowser, serveReprocessInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const READY = pack.readings.rd_FXATTENT01;
const FAILED = pack.readings.rd_FXERR00001;

/** The reading with a reprocess running over it, as the backend writes it. */
function runningOver<T extends { status: string }>(reading: T) {
  return {
    ...reading,
    ...(reading.status === "failed" ? { status: "pending", error: null } : {}),
    active_attempt: { id: "at_NEW01", trigger: "reprocess", status: "running", stage: "fetch_source", started_at: pack.generated_at },
  };
}

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

test("Retry on a failed reading sends an empty reprocess at once and starts watching", async ({ page, baseURL }) => {
  const reprocesses = await openWithReprocess(page, baseURL!, FAILED);

  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByLabel("Processing status")).toContainText("This reading is still being processed.");
  await expect(page.getByRole("button", { name: "Check status" })).toBeFocused();
  await expect(dialog(page)).toHaveCount(0);
  expect(reprocesses).toHaveLength(1);
  expect(reprocesses[0]!.postDataJSON()).toEqual({});
});

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
    expect(reprocesses).toEqual([]);
  });
}

test("the page behind the confirmation cannot be reached while it is open", async ({ page, baseURL }) => {
  await openWithReprocess(page, baseURL!, READY);
  await page.getByRole("button", { name: "Reprocess" }).click();
  await expect(dialog(page)).toBeVisible();

  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab");
    const inDialog = await page.evaluate(() => document.activeElement?.closest("dialog") !== null);
    const onPage = await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null);
    // Focus stays in the dialog, or leaves for the browser's own chrome.
    expect(inDialog || !onPage).toBe(true);
  }
});

test("confirming sends an empty reprocess, keeps the summary, and returns focus", async ({ page, baseURL }) => {
  const reprocesses = await openWithReprocess(page, baseURL!, READY);
  const reprocess = page.getByRole("button", { name: "Reprocess" });

  await reprocess.click();
  await dialog(page).getByRole("button", { name: "Reprocess" }).click();

  await expect(page.getByLabel("Processing status")).toContainText("This reading is being processed again.");
  await expect(page.getByText(READY.tldr!)).toBeVisible();
  await expect(reprocess).toBeFocused();
  await expect(reprocess).toHaveAttribute("aria-disabled", "true");
  expect(reprocesses).toHaveLength(1);
  expect(reprocesses[0]!.postDataJSON()).toEqual({});
});
