// The keyboard pass the design spec requires (Keyboard, focus, and motion):
// the skip link comes first and lands on main, focus order follows the
// document, every tab stop shows a focus indicator, and nothing traps focus.

import { expect, type Page } from "@playwright/test";

export interface TabStop {
  /** `tag#id.class` plus the accessible-ish label, enough to read a diff. */
  signature: string;
  /** Whether :focus-visible draws an outline or a ring on it. */
  focusIndicator: boolean;
  /** Document order among focusable elements, or -1 when focus left the page. */
  documentIndex: number;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Tabs through the page once and reports what focus visited. Chromium keeps a
 * sequential-navigation starting point that blur() does not clear, so a walk
 * only starts at the top of a freshly loaded page.
 */
export async function walkTabStops(page: Page, limit = 40): Promise<TabStop[]> {
  const stops: TabStop[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await describeActiveElement(page);
    if (stop === null) break;
    stops.push(stop);
    // Focus left the page (the browser chrome took it) or came back round.
    if (stops.length > 1 && stop.signature === stops[0].signature) break;
  }
  return stops;
}

async function describeActiveElement(page: Page): Promise<TabStop | null> {
  return page.evaluate((focusable) => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const style = getComputedStyle(el);
    const outline =
      style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth || "0") > 0;
    const ring = style.boxShadow !== "none" && style.boxShadow !== "";
    const classes = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
    const order = [...document.querySelectorAll(focusable)].filter(
      (candidate) => (candidate as HTMLElement).offsetParent !== null || candidate === el,
    );
    return {
      signature: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}${label ? ` "${label}"` : ""}`,
      focusIndicator: outline || ring,
      documentIndex: order.indexOf(el),
    };
  }, FOCUSABLE);
}

/** The first tab from a freshly loaded page reaches the visible skip link. */
export async function expectSkipLinkFirst(page: Page): Promise<void> {
  const [first] = await walkTabStops(page, 1);
  expect(first?.signature, "the skip link is the first focusable element").toContain("a.skip-link");
  await expect(page.locator("a.skip-link")).toBeVisible();
}

/** Activating it moves focus into main, which route changes then announce. */
export async function expectSkipLinkReachesMain(page: Page): Promise<void> {
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
}

export function expectVisibleFocusOnEveryStop(stops: TabStop[]): void {
  expect(stops.length, "the page has tab stops").toBeGreaterThan(0);
  expect(stops.filter((stop) => !stop.focusIndicator).map((stop) => stop.signature)).toEqual([]);
}

/** Focus visits each stop once, in document order, and then moves on. */
export function expectNoFocusTrap(stops: TabStop[]): void {
  const inOrder = stops.map((stop) => stop.documentIndex).filter((index) => index >= 0);
  expect([...inOrder].sort((a, b) => a - b)).toEqual(inOrder);
  const repeated = stops.slice(0, -1).filter((stop, i) => stop.signature === stops[i + 1].signature);
  expect(repeated.map((stop) => stop.signature), "focus never sticks on one element").toEqual([]);
}
