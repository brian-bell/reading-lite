// Session management in a real browser (#340.1). The component tests own the
// list, revoke-one, revoke-all, and the common states; this proves what only
// a browser's modal `<dialog>` does: Escape and Cancel close it without a
// request and return focus.
//
// Account deletion (#340.8): the typed confirmation driven from the keyboard
// alone, with the request the browser actually sent, and Escape after typing
// sending nothing. The component tests own the outcomes.
//
// API token revoke (#340.7.2): the confirmation from the keyboard alone, the
// request the browser sent, and focus once the row's Revoke button is gone.

import { expect, test as base, type Page } from "@playwright/test";
import { harnessBaseUrl } from "../harness";
import {
  serveAccountDeleteInBrowser,
  serveSessionsInBrowser,
  serveSettingsInBrowser,
  serveTokensInBrowser,
  signIn,
} from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

async function openAccount(page: Page, baseURL: string) {
  await signIn(page.context(), baseURL);
  await serveSettingsInBrowser(page);
  await serveTokensInBrowser(page);
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

test("revokes an API token from the keyboard and keeps focus in the section", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  await serveSettingsInBrowser(page);
  const { revokes } = await serveTokensInBrowser(page);
  await serveSessionsInBrowser(page);
  await page.goto("/account/security");
  const tokens = page.getByRole("region", { name: "API tokens" });
  await expect(tokens.getByText("CI (standard) · usable")).toBeVisible();

  await tokens.getByRole("button", { name: "Revoke CI" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Revoke this API token?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Revoke token" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(tokens.getByText("CI (standard) · revoked")).toBeVisible();
  await expect(tokens.getByRole("heading", { name: "API tokens" })).toBeFocused();
  expect(revokes).toHaveLength(1);
  expect(new URL(revokes[0]!.url()).pathname).toBe("/api/auth/tokens/tok_ci");
  expect(await revokes[0]!.headerValue("x-csrf-token")).toBeTruthy();
});

function deleteDialog(page: Page) {
  return page.getByRole("dialog", { name: "Delete your account?" });
}

test("deletes the account from the keyboard after typing delete", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  await serveSettingsInBrowser(page);
  await serveTokensInBrowser(page);
  await serveSessionsInBrowser(page);
  const { deletes } = await serveAccountDeleteInBrowser(page);
  await page.goto("/account/security");
  await expect(page.getByText("Firefox (this device)")).toBeVisible();

  await page.getByRole("button", { name: "Delete account…" }).focus();
  await page.keyboard.press("Enter");
  const field = deleteDialog(page).getByLabel("Type delete to confirm");
  await expect(field).toBeFocused();
  await page.keyboard.type("delete");
  await page.keyboard.press("Tab");
  await expect(deleteDialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(deleteDialog(page).getByRole("button", { name: "Delete account" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 1, name: "Your account is being deleted." })).toBeFocused();
  await expect(page).toHaveURL(/\/account\/security$/);
  expect(deletes).toHaveLength(1);
  expect(deletes[0]!.postDataJSON()).toEqual({ confirm: "delete" });
  expect(await deletes[0]!.headerValue("x-csrf-token")).toBeTruthy();
});

test("Escape after typing delete closes the dialog without a request", async ({ page, baseURL }) => {
  await signIn(page.context(), baseURL!);
  await serveSettingsInBrowser(page);
  await serveTokensInBrowser(page);
  await serveSessionsInBrowser(page);
  const { deletes } = await serveAccountDeleteInBrowser(page);
  await page.goto("/account/security");
  await expect(page.getByText("Firefox (this device)")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Delete account…" });

  await trigger.click();
  await deleteDialog(page).getByLabel("Type delete to confirm").fill("delete");
  await page.keyboard.press("Escape");

  await expect(deleteDialog(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(deletes).toEqual([]);
});
