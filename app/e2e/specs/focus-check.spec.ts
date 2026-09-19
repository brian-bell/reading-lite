// The focus check, checked. `expectVisibleFocusOnEveryStop` is only worth
// running if it can still fail. The theme control is where a naive version
// stops working — the focused element is a transparent radio over its label,
// and the ring belongs to the label — and the substitutes below are rules that
// change a computed style while painting nothing, which a check reading
// computed styles would credit as an indicator.

import { expect, test, type Page } from "@playwright/test";
import {
  expectNoFocusTrap,
  expectVisibleFocusOnEveryStop,
  MAX_FIELD_PARTS,
  walkTabStops,
  type TabStop,
} from "../checks/keyboard";
import { harnessBaseUrl } from "../harness";

// Ways to lose the ring. All of them must fail the check.
const RING_SUPPRESSED = {
  removed: ".theme-option:has(input:focus-visible) { outline: none !important; outline-offset: 0 !important; }",
  "zero width": ".theme-option:has(input:focus-visible) { outline: 0 solid var(--accent) !important; }",
  transparent: ".theme-option:has(input:focus-visible) { outline: 3px solid transparent !important; }",
};

async function themeOptionStops(page: Page): Promise<{ all: TabStop[]; themeOptions: TabStop[] }> {
  const all = await walkTabStops(page);
  const themeOptions = all.filter((stop) => stop.proxy.includes("label.theme-option"));
  expect(themeOptions.length, "a theme option is a tab stop").toBeGreaterThan(0);
  return { all, themeOptions };
}

test("credits the theme option's ring, not its hidden radio's outline", async ({ page }) => {
  await page.goto(harnessBaseUrl());
  const { all, themeOptions } = await themeOptionStops(page);
  // The stop is the radio; the indicator is measured on the label.
  expect(themeOptions.every((stop) => stop.signature.startsWith("input"))).toBe(true);
  expect(themeOptions.every((stop) => stop.focusIndicator)).toBe(true);
  expectVisibleFocusOnEveryStop(all);
});

// `.nav-item` draws no border, so tinting one paints nothing.
const UNPAINTED_SUBSTITUTES = {
  "a border colour on a border-less item": ".nav-item:focus-visible { outline: none !important; border-color: red !important; }",
  "a transparent background": ".nav-item:focus-visible { outline: none !important; background-color: rgba(255, 0, 0, 0) !important; }",
  "a transparent shadow": ".nav-item:focus-visible { outline: none !important; box-shadow: 0 0 0 3px rgba(255, 0, 0, 0) !important; }",
  "a shadow with no extent": ".nav-item:focus-visible { outline: none !important; box-shadow: 0 0 0 0 red !important; }",
  // A focus ring layer added to a permanent elevation shadow, painting nothing.
  "a transparent ring beside a permanent shadow": [
    ".nav-item { box-shadow: 0 1px 2px black !important; }",
    ".nav-item:focus-visible { outline: none !important; box-shadow: 0 1px 2px black, 0 0 0 3px transparent !important; }",
  ].join("\n"),
};

for (const [how, css] of Object.entries(UNPAINTED_SUBSTITUTES)) {
  test(`rejects ${how}`, async ({ page }) => {
    await page.goto(harnessBaseUrl());
    await page.addStyleTag({ content: css });
    const stops = await walkTabStops(page);
    // The current page's item is skipped: it has a background at rest, so
    // painting over it really is a visible change.
    const navItems = stops.filter(
      (stop) => stop.proxy.includes("a.nav-item") && !stop.proxy.includes(".active"),
    );
    expect(navItems.length, "a navigation item is a tab stop").toBeGreaterThan(0);
    expect(navItems.map((stop) => stop.focusIndicator)).toEqual(navItems.map(() => false));
    expect(() => expectVisibleFocusOnEveryStop(stops)).toThrow(/a\.nav-item/);
  });
}

// A native date or time field takes one tab stop per part; anything else
// visited twice in a row, or a field that keeps focus past its parts, is stuck.
function stop(documentIndex: number, segmented = false): TabStop {
  const signature = segmented ? "input#expiry.text-input" : `button#b${documentIndex}`;
  return { signature, proxy: signature, focusIndicator: true, documentIndex, segmented };
}

test("lets a date field take one stop per part, and no more", () => {
  const parts = Array.from({ length: 6 }, () => stop(2, true));
  expectNoFocusTrap([stop(1), ...parts, stop(3)]);

  const held = Array.from({ length: MAX_FIELD_PARTS + 1 }, () => stop(2, true));
  expect(() => expectNoFocusTrap([stop(1), ...held, stop(3)])).toThrow(/focus never sticks/);
  expect(() => expectNoFocusTrap([stop(1), stop(2), stop(2), stop(3)])).toThrow(/focus never sticks/);
});

for (const [how, css] of Object.entries(RING_SUPPRESSED)) {
  test(`fails once that ring is ${how}`, async ({ page }) => {
    await page.goto(harnessBaseUrl());
    await page.addStyleTag({ content: css });
    const { all, themeOptions } = await themeOptionStops(page);
    expect(themeOptions.map((stop) => stop.focusIndicator)).toEqual(themeOptions.map(() => false));
    expect(() => expectVisibleFocusOnEveryStop(all)).toThrow(/label\.theme-option/);
  });
}
