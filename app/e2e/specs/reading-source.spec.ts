// The Source view in a real browser (#372; design spec, Source content;
// Routes and navigation state; Keyboard, focus, and motion). The component
// tests prove what renders; these prove what only a browser can: the URL
// surviving a reload, Back leaving the reading after a switch, which requests
// the document and the view make and when, the image request carrying no
// referrer, the policy header on the page, and rich content at 390 px.

import { selectSourceView } from "../coverage";
import { expect, openCase, serveSourceInBrowser, test } from "../test";

const ATTENTION = {
  path: "/readings/rd_FXATTENT01",
  heading: "A quieter internet is a choice we can make",
  state: "signed-in" as const,
};
const RICH = {
  path: "/readings/rd_FXMDPAGE01?view=source",
  heading: "Slow reading week",
  state: "signed-in" as const,
};
const UNAVAILABLE = {
  path: "/readings/rd_FXRAWSRC01?view=source",
  heading: "The web we can no longer revisit",
  state: "signed-in" as const,
};

/** A 1×1 PNG, for the image host. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function sourcePanel(page: Parameters<typeof selectSourceView>[0]) {
  return page.getByRole("tabpanel", { name: "Source" });
}

test("the source is requested only once Source is selected", async ({ page, baseURL }) => {
  const contentRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/content")) contentRequests.push(request.method());
  });
  await openCase(page, baseURL!, ATTENTION);
  await serveSourceInBrowser(page);
  await page.waitForLoadState("networkidle");
  expect(contentRequests).toEqual([]);

  await selectSourceView(page);
  await expect(sourcePanel(page).getByRole("heading", { level: 3, name: "Somewhere to return" })).toBeVisible();
  expect(contentRequests).toEqual(["GET"]);
  await expect(page).toHaveURL(/\/readings\/rd_FXATTENT01\?view=source$/);
});

test("switching views replaces the history entry, so Back leaves the reading", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, { path: "/", heading: "Library", state: "signed-in" });
  await page.goto(ATTENTION.path);
  await expect(page.getByRole("heading", { level: 1, name: ATTENTION.heading })).toBeVisible();
  await serveSourceInBrowser(page);
  await selectSourceView(page);
  await page.getByRole("tab", { name: "Summary" }).click();
  await expect(page).toHaveURL(/\/readings\/rd_FXATTENT01$/);

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
});

test("a reload and a deep link keep the Source view", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, { ...ATTENTION, path: `${ATTENTION.path}?view=source` });
  await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");

  await serveSourceInBrowser(page);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
  await expect(sourcePanel(page).locator(".reading-source")).toBeVisible();
});

test("the server render carries no source and the page carries the image policy", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, { path: "/", heading: "Library", state: "signed-in" });
  const response = await page.goto(`${ATTENTION.path}?view=source`);
  expect(response?.headers()["content-security-policy"]).toBe("img-src 'self' https: data:");
  // The document has the tabs and the reading, not the article's text.
  const html = await response!.text();
  expect(html).toContain('role="tablist"');
  expect(html).not.toContain("On a Sunday morning, I opened a folder");
});

test("tabs answer to the arrow keys, Home, and End", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveSourceInBrowser(page);
  await page.getByRole("tab", { name: "Summary" }).focus();

  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Source" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Summary" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Source" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sourcePanel(page)).toBeFocused();
});

test("an image loads only on request, over https, without a referrer", async ({ page, baseURL }) => {
  const imageRequests: { url: string; referer: string | undefined }[] = [];
  await page.route("https://images.fieldnotes.example/**", async (route) => {
    const request = route.request();
    imageRequests.push({ url: request.url(), referer: await request.headerValue("referer") ?? undefined });
    await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
  });
  await serveSourceInBrowser(page);
  await openCase(page, baseURL!, RICH);
  const panel = sourcePanel(page);
  await expect(panel.getByText("The desk on Friday, three books and one notebook")).toBeVisible();
  await expect(panel.getByText("images.fieldnotes.example").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(imageRequests).toEqual([]);
  expect(await panel.locator("img").count()).toBe(0);

  await panel.getByRole("button", { name: "Load image" }).click();
  const image = panel.getByRole("img", { name: "The desk on Friday, three books and one notebook" });
  await expect(image).toBeVisible();
  await expect.poll(() => imageRequests.length).toBe(1);
  expect(imageRequests[0]!.url).toBe("https://images.fieldnotes.example/slow-reading-week/desk.jpg");
  expect(imageRequests[0]!.referer).toBeUndefined();
  // The raw <img onerror> in the same source never became an element.
  expect(await panel.locator("img").count()).toBe(1);
});

test("the unavailable source makes no request and hands back to the summary", async ({ page, baseURL }) => {
  const contentRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/content")) contentRequests.push(request.url());
  });
  await openCase(page, baseURL!, UNAVAILABLE);
  await expect(sourcePanel(page).getByRole("heading", { level: 2, name: "Source text is unavailable" })).toBeVisible();
  await expect(page.getByRole("region", { name: "What this adds" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(contentRequests).toEqual([]);

  await sourcePanel(page).getByRole("button", { name: "Read summary" }).click();
  await expect(page.getByRole("tab", { name: "Summary" })).toBeFocused();
  await expect(page).toHaveURL(/\/readings\/rd_FXRAWSRC01$/);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rich content scrolls inside its containers, never the page", async ({ page, baseURL }) => {
    await serveSourceInBrowser(page);
    await openCase(page, baseURL!, RICH);
    const panel = sourcePanel(page);
    await expect(panel.getByRole("table")).toBeVisible();

    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      pre: getComputedStyle(document.querySelector(".reading-source pre")!).overflowX,
      table: getComputedStyle(document.querySelector(".reading-source table")!).overflowX,
      link: document.querySelector(".reading-source a[href*='everything-i-wrote-down']")!.getBoundingClientRect().right,
    }));
    expect(widths.page).toBe(widths.viewport);
    expect(widths.pre).toBe("auto");
    expect(widths.table).toBe("auto");
    expect(widths.link).toBeLessThanOrEqual(widths.viewport);
  });
});
