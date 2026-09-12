// Reduced motion and zoom, for the shell now and later pages as they land
// (design spec, Keyboard, focus, and motion).
//
// Browsers expose no zoom API to automation, so zoom is modelled the way WCAG
// reflow does: 200% of a 1440 px window is a 720 px CSS viewport, and the
// 320 px reflow floor is 400% of 1280 px. The check is the same either way —
// the page must not scroll horizontally.

import { expect, type Page } from "@playwright/test";

export async function expectReducedMotionHonoured(page: Page): Promise<void> {
  const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  expect(reduced, "the context asks for reduced motion").toBe(true);

  const moving = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")]
      .filter((el) => {
        const style = getComputedStyle(el);
        const duration = (value: string) =>
          value.split(",").some((part) => Number.parseFloat(part) > 0);
        return duration(style.transitionDuration) || duration(style.animationDuration);
      })
      .map((el) => el.tagName.toLowerCase() + (el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""))
      .slice(0, 10),
  );
  expect(moving, "nothing animates under prefers-reduced-motion: reduce").toEqual([]);
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `content is ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}
