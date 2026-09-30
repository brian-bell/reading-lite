// The public sample library (reading-lite-gh341.10) is bundled in the
// frontend: signed out, opening the list, a sample, and a sample its
// connection leads to asks the backend for nothing but the shell's identity
// read, which is answered once, and a followed connection is a client-side
// navigation, not a new document. The harness answers `/api/whoami` with 404
// rather than a signed-out 401, so it is routed as the backend would answer. The pages offer no control that writes. The matrix
// screenshots each state in every project.
//
// Playwright's own `test`, as reading-cache.spec.ts uses, since nothing here
// depends on the fixture pack's pinned clock.

import { expect, test as base, type Page } from "@playwright/test";
import { harnessBaseUrl } from "../harness";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

interface Recorded {
  api: string[];
  documents: string[];
}

function recordRequests(page: Page): Recorded {
  const recorded: Recorded = { api: [], documents: [] };
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/") || pathname.startsWith("/mcp")) recorded.api.push(`${request.method()} ${pathname}`);
    if (request.resourceType() === "document") recorded.documents.push(pathname);
  });
  return recorded;
}

test("reads nothing from the backend but identity, signed out, and follows samples in place", async ({ page }) => {
  await page.route("**/api/whoami", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  const recorded = recordRequests(page);
  await page.goto("/samples");
  await expect(page.getByRole("heading", { level: 1, name: "Sample library" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByRole("link", { name: "A quieter internet is a choice we can make" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeVisible();
  await page
    .getByRole("complementary", { name: "Connections & tensions" })
    .getByRole("link", { name: "The case for a little friction" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "The case for a little friction" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Return trail" })).toContainText("You followed a tension from");
  await page.waitForLoadState("networkidle");

  expect(recorded.documents).toEqual(["/samples"]);
  expect(recorded.api).toEqual(["GET /api/whoami"]);
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
});

test("offers no control that writes", async ({ page }) => {
  await page.goto("/samples/a-quieter-internet");
  await expect(page.getByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const main = page.getByRole("main");
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByRole("tab")).toHaveCount(0);
  await expect(main.getByRole("list", { name: "Tags" }).getByRole("link")).toHaveCount(0);
});
