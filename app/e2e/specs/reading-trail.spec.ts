// The return trail and the phone jump in a real browser (#371; design spec,
// Routes and navigation state; Keyboard, focus, and motion). The component
// tests prove the trail's contents; these prove what only a browser can:
// history state surviving Back, a reload dropping it, focus moving across a
// stacked layout, and smooth scrolling deferring to the motion preference.

import { followCard } from "../coverage";
import { expectReducedMotionHonoured } from "../checks/motion";
import { expect, openCase, serveReadingsInBrowser, test } from "../test";

const ATTENTION = {
  path: "/readings/rd_FXATTENT01",
  heading: "A quieter internet is a choice we can make",
  state: "signed-in" as const,
};
const GARDENS_TITLE = "Libraries are gardens, not warehouses";

function trail(page: Parameters<typeof followCard>[0]) {
  return page.getByRole("navigation", { name: "Return trail" });
}

test("browser Back restores each reading's own trail", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveReadingsInBrowser(page);
  await followCard(page, GARDENS_TITLE);
  await followCard(page, ATTENTION.heading);
  await expect(trail(page)).toContainText(`You followed a connection from ${GARDENS_TITLE}`);

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: GARDENS_TITLE })).toBeVisible();
  await expect(trail(page)).toContainText(`You followed a connection from ${ATTENTION.heading}`);

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: ATTENTION.heading })).toBeVisible();
  await expect(trail(page)).toHaveCount(0);
});

test("the trail's own Back goes back through history", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveReadingsInBrowser(page);
  await followCard(page, GARDENS_TITLE);

  await trail(page).getByRole("button", { name: `Back to ${ATTENTION.heading}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: ATTENTION.heading })).toBeVisible();
  await expect(trail(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/readings\/rd_FXATTENT01$/);
});

// window.history.state survives a reload, so the trail it holds would come
// back with the page unless the page knows it was written by an earlier load.
test("a reload keeps the reading and drops the trail", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveReadingsInBrowser(page);
  await followCard(page, GARDENS_TITLE);
  await expect(trail(page)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: GARDENS_TITLE })).toBeVisible();
  await expect(trail(page)).toHaveCount(0);
});

test("the trail never writes anything into the URL", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await serveReadingsInBrowser(page);
  await followCard(page, GARDENS_TITLE);
  await expect(page).toHaveURL(/\/readings\/rd_FXGARDEN01$/);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the jump moves focus to the context heading and back to the jump link", async ({ page, baseURL }) => {
    await openCase(page, baseURL!, ATTENTION);
    const jump = page.getByRole("link", { name: "Connections & tensions" });
    await expect(jump).toBeVisible();

    await jump.click();
    const heading = page.getByRole("heading", { level: 2, name: "Connections & tensions" });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await expect(page).toHaveURL(/\/readings\/rd_FXATTENT01$/);

    await page.getByRole("link", { name: "Back to the reading" }).click();
    await expect(jump).toBeFocused();
    await expect(jump).toBeInViewport();
    await expect(page).toHaveURL(/\/readings\/rd_FXATTENT01$/);
  });

  // The jump asks for smooth scrolling itself rather than through a page-wide
  // scroll-behavior rule, which would also animate the router's scroll-to-top
  // on every route change.
  test("scrolls smoothly only when motion is welcome", async ({ page, baseURL }) => {
    await openCase(page, baseURL!, ATTENTION);
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      (window as unknown as { __scrolls: unknown[] }).__scrolls = [];
      Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
        (window as unknown as { __scrolls: unknown[] }).__scrolls.push(options);
        return original.call(this, options);
      };
    });
    const behaviours = () =>
      page.evaluate(() =>
        (window as unknown as { __scrolls: (ScrollIntoViewOptions | undefined)[] }).__scrolls.map((o) => o?.behavior),
      );
    const jump = page.getByRole("link", { name: "Connections & tensions" });

    await jump.click();
    await expect.poll(behaviours).toEqual(["smooth"]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("link", { name: "Back to the reading" }).click();
    await expect.poll(behaviours).toEqual(["smooth", "auto"]);
  });

  test.describe("with reduced motion", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the jump still lands focus on the heading", async ({ page, baseURL }) => {
      await openCase(page, baseURL!, ATTENTION);
      await expectReducedMotionHonoured(page);
      await page.getByRole("link", { name: "Connections & tensions" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "Connections & tensions" })).toBeFocused();
    });
  });
});

test("the context column is beside the reading on desktop, without a jump link", async ({ page, baseURL }) => {
  await openCase(page, baseURL!, ATTENTION);
  await expect(page.getByRole("link", { name: "Connections & tensions" })).toBeHidden();
  const article = await page.locator(".reading-column").boundingBox();
  const context = await page.getByRole("complementary", { name: "Connections & tensions" }).boundingBox();
  expect(context!.x).toBeGreaterThan(article!.x + article!.width - 1);
});
