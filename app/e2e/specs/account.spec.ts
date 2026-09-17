// Session management in a real browser (#340.1). The component tests own the
// list, revoke-one, revoke-all, and the common states; this proves what only
// a browser's modal `<dialog>` does: Escape and Cancel close it without a
// request and return focus.

import { expect, test as base, type Page } from "@playwright/test";
import { harnessBaseUrl } from "../harness";
import { serveSessionsInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

async function openAccount(page: Page, baseURL: string) {
  await signIn(page.context(), baseURL);
  const writes = await serveSessionsInBrowser(page);
  await page.goto("/account/security");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(page.getByText("Firefox (this device)")).toBeVisible();
  return writes;
}

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Revoke all browser sessions?" });
}

for (const close of ["Escape", "Cancel"] as const) {
  test(`${close} closes revoke-all without a request and returns focus`, async ({ page, baseURL }) => {
    const writes = await openAccount(page, baseURL!);
    const trigger = page.getByRole("button", { name: "Revoke all sessions" }).first();

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();

    if (close === "Escape") await page.keyboard.press("Escape");
    else await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(writes.revokeAll).toEqual([]);
  });
}
