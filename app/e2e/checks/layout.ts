// Nothing the reader is meant to see may sit outside the viewport. Horizontal
// page scroll only catches overflow past the right edge; a popover anchored to
// the wrong side runs off the left instead, where the page never scrolls and
// the content is simply lost.

import { expect, type Page } from "@playwright/test";

export interface OffscreenElement {
  signature: string;
  left: number;
  right: number;
}

/**
 * Positioned elements (the panels and popovers that can escape their column)
 * and their visible text must stay inside the viewport.
 */
export async function expectNothingOffscreen(page: Page): Promise<void> {
  const offscreen = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const escaped: { signature: string; left: number; right: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(el);
      if (style.position !== "absolute" && style.position !== "fixed") continue;
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      // A closed disclosure still lays its panel out; the reader cannot see it.
      if (el.closest("details:not([open])")) continue;
      const rect = el.getBoundingClientRect();
      // Off-canvas until focused, like the skip link, or simply empty.
      if (rect.width === 0 || rect.height === 0 || rect.bottom < 0) continue;
      if (rect.left >= -1 && rect.right <= viewport + 1) continue;
      const classes = typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join(".")}`
        : "";
      escaped.push({
        signature: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
    }
    return escaped;
  });
  expect(offscreen, "positioned elements stay inside the viewport").toEqual([]);
}
