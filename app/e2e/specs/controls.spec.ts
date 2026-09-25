// Button hover (reading-lite-hb8o): the pointer over a `.button` changes it, in
// both themes, for the quiet and primary variants. An unavailable button
// (disabled or aria-disabled) stays as it is, and a touch device, which has no
// hover, keeps no hover state after a tap.
//
// Computed styles, not screenshots: the matrix screenshots every page at rest,
// and this is the one state it never reaches.

import type { Locator, Page } from "@playwright/test";
import { expect, signIn, test } from "../test";

/** What a hover may change on a button. */
async function paint(button: Locator): Promise<string> {
  return button.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.backgroundColor} ${style.borderColor} ${style.color}`;
  });
}

/** The paint at rest, then with the pointer over the button. */
async function paintOnHover(page: Page, button: Locator): Promise<{ rest: string; hover: string }> {
  await page.mouse.move(0, 0);
  const rest = await paint(button);
  await button.hover({ force: true });
  return { rest, hover: await paint(button) };
}

async function openLibrary(page: Page, baseURL: string) {
  await signIn(page.context(), baseURL);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  return {
    search: page.getByRole("button", { name: "Search" }),
    previous: page.getByRole("navigation", { name: "Pagination" }).getByRole("link", { name: "Previous" }),
  };
}

async function openSave(page: Page, baseURL: string) {
  await signIn(page.context(), baseURL);
  await page.goto("/save");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeVisible();
  return save;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.use({ theme, colorScheme: theme });

    test("a quiet button changes under the pointer", async ({ page, baseURL }) => {
      const { search } = await openLibrary(page, baseURL!);
      const { rest, hover } = await paintOnHover(page, search);
      expect(hover).not.toBe(rest);
    });

    test("a primary button changes under the pointer", async ({ page, baseURL }) => {
      const save = await openSave(page, baseURL!);
      const { rest, hover } = await paintOnHover(page, save);
      expect(hover).not.toBe(rest);
    });

    test("an aria-disabled button does not change under the pointer", async ({ page, baseURL }) => {
      const { previous } = await openLibrary(page, baseURL!);
      await expect(previous).toHaveAttribute("aria-disabled", "true");
      const { rest, hover } = await paintOnHover(page, previous);
      expect(hover).toBe(rest);
    });

    test("a disabled button does not change under the pointer", async ({ page, baseURL }) => {
      const save = await openSave(page, baseURL!);
      // The stylesheet is under test, not the form: disable the real control.
      await save.evaluate((el) => el.setAttribute("disabled", ""));
      const { rest, hover } = await paintOnHover(page, save);
      expect(hover).toBe(rest);
    });
  });
}

test.describe("touch", () => {
  // No hover on this device: (hover: hover) does not match.
  test.use({ hasTouch: true, isMobile: true });

  test("a tapped button keeps no hover state", async ({ page, baseURL }) => {
    const { search } = await openLibrary(page, baseURL!);
    await page.mouse.move(0, 0);
    const rest = await paint(search);
    // A tap leaves the emulated pointer over the button, which is what makes
    // a hover stick on a phone.
    await search.hover();
    expect(await paint(search)).toBe(rest);
  });
});
