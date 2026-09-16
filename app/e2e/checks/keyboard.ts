// The keyboard pass the design spec requires (Keyboard, focus, and motion):
// the skip link comes first and lands on main, focus order follows the
// document, every tab stop shows a focus indicator, and nothing traps focus.
//
// "Shows an indicator" is measured on the element the reader can actually see,
// and as a change in what that element paints when focus arrives. The theme
// options are why both halves matter. Their focused element is a transparent
// radio covering its label, and the ring is drawn on the label by
// `.theme-option:has(input:focus-visible)`, so reading the focused element's
// own outline would keep passing after that rule broke. And a rule can change a
// computed style while painting nothing — `outline: 0 solid`,
// `box-shadow: 0 0 0 0 red`, a colour with no alpha, a border colour on a
// border-less element — so the comparison counts only declarations that draw.
//
// e2e/specs/focus-check.spec.ts holds this check to both: it suppresses the
// theme ring each of those ways and fails if the check still passes.

import { expect, type Page } from "@playwright/test";

export interface TabStop {
  /** `tag#id.class` plus the accessible-ish label, enough to read a diff. */
  signature: string;
  /** The visible element carrying the indicator: the stop itself, or its label. */
  proxy: string;
  /** Whether that element paints differently while the stop has focus. */
  focusIndicator: boolean;
  /** Document order among focusable elements, or -1 when focus left the page. */
  documentIndex: number;
}

interface ProbedStop {
  signature: string;
  proxy: string;
  focusedStyle: string;
  documentIndex: number;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Tabs through the page once and reports what focus visited. Chromium keeps a
 * sequential-navigation starting point that blur() does not clear, so a walk
 * only starts at the top of a freshly loaded page.
 */
export async function walkTabStops(page: Page, limit = 100): Promise<TabStop[]> {
  await installFocusProbe(page);
  const probed: ProbedStop[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await probeActiveElement(page);
    if (stop === null) break;
    probed.push(stop);
    // Focus left the page (the browser chrome took it) or came back round.
    if (probed.length > 1 && stop.signature === probed[0].signature) break;
  }
  // Read the same elements once focus has gone, so each stop is judged by what
  // arriving changed rather than by decoration it carries all the time.
  const resting = await readRestingStyles(page);
  return probed.map((stop, index) => ({
    signature: stop.signature,
    proxy: stop.proxy,
    focusIndicator: stop.focusedStyle !== resting[index],
    documentIndex: stop.documentIndex,
  }));
}

/** Shape of the helper installFocusProbe leaves on the page's window. */
interface FocusProbe {
  stops: Element[];
  visibleProxy(el: Element): Element;
  styleSignature(el: Element): string;
  describe(el: Element): string;
  order(focusable: string, el: Element): number;
}

async function installFocusProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    // An element the reader cannot see, standing in for the one they can: the
    // transparent radio over a theme option, a visually hidden control.
    function isInvisible(el: Element): boolean {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        Number.parseFloat(style.opacity) < 0.05 ||
        style.visibility === "hidden" ||
        style.clipPath.startsWith("inset(50%") ||
        rect.width < 3 ||
        rect.height < 3
      );
    }

    /** Splits a box-shadow value on its top-level commas, not colour commas. */
    function layersOf(value: string): string[] {
      if (value === "none" || value === "") return [];
      const layers: string[] = [];
      let depth = 0;
      let current = "";
      for (const character of value) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        if (character === "," && depth === 0) {
          layers.push(current.trim());
          current = "";
          continue;
        }
        current += character;
      }
      if (current.trim()) layers.push(current.trim());
      return layers;
    }

    const probe = {
      stops: [] as Element[],

      visibleProxy(el: Element): Element {
        let node: Element | null = el;
        while (node && node !== document.body && isInvisible(node)) {
          node = node.parentElement;
        }
        return node && node !== document.body ? node : el;
      },

      /**
       * What the browser actually paints for this element right now. A
       * declaration that draws nothing — no width, no extent, `none`, or a
       * fully transparent colour — collapses to one value, so a focus rule that
       * leaves the reader with no indicator cannot pass for one.
       */
      styleSignature(el: Element): string {
        const style = getComputedStyle(el);
        const length = (value: string) => Number.parseFloat(value) || 0;
        const opaque = (color: string) => color !== "transparent" && !/^rgba\(.*,\s*0\s*\)$/.test(color);

        const outline =
          style.outlineStyle !== "none" && length(style.outlineWidth) > 0 && opaque(style.outlineColor)
            ? `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`
            : "no outline";

        const borders = (["Top", "Right", "Bottom", "Left"] as const)
          .map((side) => {
            const lineStyle = style[`border${side}Style`];
            const lineWidth = style[`border${side}Width`];
            const color = style[`border${side}Color`];
            return lineStyle !== "none" && length(lineWidth) > 0 && opaque(color)
              ? `${lineStyle} ${lineWidth} ${color}`
              : "no border";
          })
          .join(",");

        const background = opaque(style.backgroundColor) ? style.backgroundColor : "no background";

        // Shadows are judged layer by layer, because a focus ring is often one
        // layer added to a permanent elevation shadow: a layer paints only with
        // a visible colour and some extent, and one that paints nothing must
        // not ride along on a sibling that does.
        const painting = layersOf(style.boxShadow).filter((layer) => {
          const colors = layer.match(/rgba?\([^)]*\)/g) ?? [];
          const lengths = layer.replace(/rgba?\([^)]*\)/g, "").match(/-?\d*\.?\d+/g) ?? [];
          return colors.some(opaque) && lengths.some((value) => Number.parseFloat(value) !== 0);
        });
        const shadow = painting.length > 0 ? painting.join(", ") : "no shadow";

        return [
          outline,
          borders,
          background,
          shadow,
          style.color,
          style.textDecorationLine,
          style.transform,
        ].join("|");
      },

      describe(el: Element): string {
        const classes =
          typeof el.className === "string" && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).join(".")}`
            : "";
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
        return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}${label ? ` "${label}"` : ""}`;
      },

      order(focusable: string, el: Element): number {
        const visible = [...document.querySelectorAll(focusable)].filter(
          (candidate) => (candidate as HTMLElement).offsetParent !== null || candidate === el,
        );
        return visible.indexOf(el);
      },
    };
    (window as unknown as { __focusProbe: unknown }).__focusProbe = probe;
  });
}

async function probeActiveElement(page: Page): Promise<ProbedStop | null> {
  return page.evaluate((focusable) => {
    const probe = (window as unknown as { __focusProbe: FocusProbe }).__focusProbe;
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const proxy = probe.visibleProxy(el);
    probe.stops.push(proxy);
    return {
      signature: probe.describe(el),
      proxy: probe.describe(proxy),
      focusedStyle: probe.styleSignature(proxy),
      documentIndex: probe.order(focusable, el),
    };
  }, FOCUSABLE);
}

async function readRestingStyles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __focusProbe: FocusProbe }).__focusProbe;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return probe.stops.map((el) => probe.styleSignature(el));
  });
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
  expect(
    stops.filter((stop) => !stop.focusIndicator).map((stop) => `${stop.signature} → ${stop.proxy}`),
    "focus visibly changes what the reader sees",
  ).toEqual([]);
}

/** Focus visits each stop once, in document order, and then moves on. */
export function expectNoFocusTrap(stops: TabStop[]): void {
  const inOrder = stops.map((stop) => stop.documentIndex).filter((index) => index >= 0);
  expect([...inOrder].sort((a, b) => a - b)).toEqual(inOrder);
  const repeated = stops.slice(0, -1).filter((stop, i) => stop.signature === stops[i + 1].signature);
  expect(repeated.map((stop) => stop.signature), "focus never sticks on one element").toEqual([]);
}
