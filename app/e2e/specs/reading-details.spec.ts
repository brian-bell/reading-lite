// The Details section in a real browser (#373; design spec, Reading surface;
// acceptance: collapsed by default and operable by keyboard, diagnostics and
// attempts load only when opened, "Open as file" opens the extracted Markdown
// and the raw capture in a new tab). The component tests prove what renders;
// these prove what only a browser can: which requests the page makes and
// when, the native disclosure answering to Enter and Space, the new tab and
// its document type, and the open section at 390 px.

import { openDetails } from "../coverage";
import { expect, openCase, serveDiagnosticsInBrowser, serveFilesInBrowser, test } from "../test";

const ATTENTION = {
  path: "/readings/rd_FXATTENT01",
  heading: "A quieter internet is a choice we can make",
  state: "signed-in" as const,
};

test("diagnostics are requested only once Details is opened, and once", async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/diagnostics") || path.endsWith("/content") || path.endsWith("/content/raw")) requests.push(path);
  });
  await openCase(page, baseURL!, ATTENTION);
  await serveDiagnosticsInBrowser(page);
  await page.waitForLoadState("networkidle");
  expect(requests).toEqual([]);
  await expect(page.locator("details.reading-details")).not.toHaveAttribute("open");

  await openDetails(page);
  await expect(page.getByText("Storage key")).toBeVisible();
  expect(requests).toEqual(["/api/readings/rd_FXATTENT01/diagnostics"]);
  await expect(page).toHaveURL(/\/readings\/rd_FXATTENT01$/);

  await page.locator("details.reading-details > summary").click();
  await expect(page.locator("details.reading-details")).not.toHaveAttribute("open");
  await openDetails(page);
  expect(requests).toHaveLength(1);
});

test("the server render carries the entities but no diagnostics", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, { path: "/", heading: "Library", state: "signed-in" });
  const response = await page.goto(ATTENTION.path);
  const html = await response!.text();
  expect(html).toContain("<details class=\"reading-details\"");
  expect(html).not.toContain("<details class=\"reading-details\" open");
  expect(html).toContain("Keywords");
  expect(html).not.toContain("Storage key");
});

test("the disclosure opens and closes from the keyboard", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveDiagnosticsInBrowser(page);
  const summary = page.locator("details.reading-details > summary");
  await summary.focus();
  await expect(summary).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("details.reading-details")).toHaveAttribute("open");
  await expect(page.getByText("Storage key")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator("details.reading-details")).not.toHaveAttribute("open");

  // Closed, the body's controls are not tab stops: the next stop is past the section.
  await page.keyboard.press("Tab");
  await expect(page.locator("details.reading-details .reading-details-body :focus")).toHaveCount(0);
  await expect(page.locator(":focus")).toHaveCount(1);
});

test("a failed diagnostics request offers a Retry that asks again", async ({ page, baseURL }) => {
  let calls = 0;
  // The pack's handler first; the later-registered one runs first and falls
  // back to it after the failure.
  await serveDiagnosticsInBrowser(page);
  await serveDiagnosticsInBrowser(page, async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 503, json: { error: "storage unavailable" } });
      return;
    }
    await route.fallback();
  });
  await openCase(page, baseURL!, ATTENTION);
  await openDetails(page);
  await expect(page.getByText(/storage unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Storage key")).toBeVisible();
  expect(calls).toBe(2);
});

test("the files open in a new tab as plain text, whatever the capture was", async ({ page, baseURL, context }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveDiagnosticsInBrowser(page);
  await serveFilesInBrowser(page);
  await openDetails(page);

  // The tab opens on the click and is pointed at the blob once the bytes arrive.
  const [markdown] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Open extracted Markdown" }).click(),
  ]);
  await markdown.waitForURL(/^blob:/);
  expect(await markdown.evaluate(() => window.opener)).toBeNull();
  expect(await markdown.evaluate(() => document.contentType)).toBe("text/plain");
  expect(await markdown.locator("body").innerText()).toContain("## Somewhere to return");
  await markdown.close();

  const [raw] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Open raw capture" }).click(),
  ]);
  await raw.waitForURL(/^blob:/);
  // The HTML capture is shown as text, not rendered: nothing in it can run
  // in this app's origin.
  expect(await raw.evaluate(() => document.contentType)).toBe("text/plain");
  expect(await raw.locator("body").innerText()).toContain("<!doctype html>");
  expect(await raw.locator("article").count()).toBe(0);
  await raw.close();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a missing file says so in place, and the waiting tab is closed again", async ({ page, baseURL, context }) => {
  await openCase(page, baseURL!, { path: "/readings/rd_FXERR00001", heading: "https://registration-wall.example/members-only-report", state: "signed-in" });
  await serveDiagnosticsInBrowser(page);
  await serveFilesInBrowser(page);
  await openDetails(page);
  await expect(page.getByRole("button", { name: "Open extracted Markdown" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open raw capture" }).click();
  await expect(page.getByRole("alert")).toHaveText("That file isn't available for this reading.");
  await expect.poll(() => context.pages().length).toBe(1);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the open section never widens the page", async ({ page, baseURL }) => {
    await openCase(page, baseURL!, ATTENTION);
    await serveDiagnosticsInBrowser(page);
    await openDetails(page);
    await expect(page.getByText("Storage key")).toBeVisible();
    await page.getByText(/\d+ steps/).click();

    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(widths.page).toBe(widths.viewport);
  });
});
