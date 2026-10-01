// A new reader's way in, end to end (reading-lite-gh341.11): the signed-out
// front door, the sample library, a sign-in link, connecting the OpenAI key
// saving needs, and the first save landing on its pending reading.
//
// The magic link itself is mail, so the spec requests one and then holds the
// session the link would have started: the stub's new reader, whose library is
// empty and who has no key. Every write after that is answered in the browser.
// Requests and the path through the pages, so one viewport and theme; the
// matrix screenshots each state on the way in every project.

import { expect, test as base } from "@playwright/test";
import { harnessBaseUrl } from "../harness";
import { NEW_READER_SESSION } from "../sessions";
import {
  E2E_PROVIDER_API_KEY,
  serveProviderInBrowser,
  serveReadingsInBrowser,
  serveSaveInBrowser,
  signIn,
} from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const PENDING = "rd_FXPENDNG01";
const FIRST_URL = "https://fieldnotes.example/making-room-for-slow-work";

test("goes from the front door through the samples and a key to the first save", async ({ page, baseURL }) => {
  // Signed out: the frontend Worker answers /api/* with 404 (ADR 0003), so
  // the browser's own reads are answered as the backend would.
  await page.route("**/api/whoami", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.route("**/api/auth/login-options", (route) => route.fulfill({ json: { turnstile_site_key: null } }));
  const challenges: string[] = [];
  await page.route("**/api/auth/challenge", async (route) => {
    challenges.push((route.request().postDataJSON() as { email: string }).email);
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("complementary", { name: "About Reading Lite" }).getByRole("link", { name: "Browse samples" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sample library" })).toBeVisible();
  await page.getByRole("link", { name: "A quieter internet is a choice we can make" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeVisible();

  await page.getByRole("complementary", { name: "About the samples" }).getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("textbox", { name: "Email" }).fill("new-reader@example.com");
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "we sent a short-lived link" })).toBeVisible();
  expect(challenges).toEqual(["new-reader@example.com"]);

  // The link signs the reader in and lands on the library.
  await page.unroute("**/api/whoami");
  await signIn(page.context(), baseURL!, NEW_READER_SESSION);
  const saves = await serveSaveInBrowser(page, {
    status: 202,
    json: { id: PENDING, status: "pending", poll: `/api/readings/${PENDING}`, attempt_id: "att_FX0001" },
  });
  await serveReadingsInBrowser(page);
  const provider = await serveProviderInBrowser(page);
  await page.goto("/");
  await expect(page.getByText("No readings yet. Connect your OpenAI key, then save your first reading.")).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByRole("link", { name: "Connect a key" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Provider" })).toBeVisible();
  const key = page.getByRole("region", { name: "OpenAI" });
  await key.getByLabel("API key").fill(E2E_PROVIDER_API_KEY);
  await key.getByRole("button", { name: "Connect key" }).click();
  await expect(key.getByText("Connected", { exact: true })).toBeVisible();
  expect(provider.connects).toHaveLength(1);

  await page.getByRole("complementary", { name: "Next step" }).getByRole("link", { name: "Save a reading" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Save reading" })).toBeVisible();
  // The key is connected, so /save no longer asks for one.
  await expect(page.getByRole("link", { name: "Connect a key" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "URL" }).fill(FIRST_URL);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`/readings/${PENDING}$`));
  await expect(page.getByText("This reading is still being processed.")).toBeVisible();
  expect(saves.map((save) => save.postDataJSON())).toEqual([{ url: FIRST_URL }]);
});
