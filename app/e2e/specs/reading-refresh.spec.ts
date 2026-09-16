// The status refresh in a real browser (#406). The component tests own the
// schedule, the cap, and the stop rules with fake timers; this proves what
// only a browser can: the page hydrated from the server render starts checking
// on its own and announces the outcome in its live region, and a 401 from a
// check hands the page to the shell's expired-session page, which unmounts the
// page and so stops the checks — the shell does not re-render that way under
// the component tests' fake timers. Playwright's clock is installed rather
// than pinned, so the checks' timers can be run forward.

import { expect, test as base, type Page } from "@playwright/test";
import pack from "../fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "../harness";
import { serveReadingsInBrowser, signIn } from "../test";

const test = base.extend({
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },
});

const PENDING = pack.readings.rd_FXPENDNG01;

/** The pending reading's checks, answered in order with the last repeating. */
async function checksAnswered(page: Page, answers: { status: number; body: unknown }[]): Promise<string[]> {
  const requests: string[] = [];
  await serveReadingsInBrowser(page, {}, requests, (id) =>
    id === PENDING.id ? answers[Math.min(requests.length - 1, answers.length - 1)] : undefined,
  );
  return requests;
}

async function openPending(page: Page, baseURL: string) {
  await signIn(page.context(), baseURL);
  await page.clock.install({ time: new Date(pack.generated_at) });
  await page.goto(`/readings/${PENDING.id}`);
  await expect(page.getByRole("heading", { level: 1, name: PENDING.url })).toBeVisible();
  await expect(page.getByLabel("Processing status")).toContainText("Fetching.");
}

test("checks a pending reading and announces when it is ready", async ({ page, baseURL }) => {
  const ready = { ...PENDING, status: "ready", active_attempt: null, title: "Making room for slow work" };
  const requests = await checksAnswered(page, [
    { status: 200, body: PENDING },
    { status: 200, body: ready },
  ]);
  await openPending(page, baseURL!);
  expect(requests).toEqual([]);

  await page.clock.runFor(3_000);
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.runFor(3_000);

  await expect(page.getByRole("status").filter({ hasText: "Processing finished." })).toHaveText(
    "Processing finished. This reading is ready.",
  );
  await expect(page.getByLabel("Processing status")).toHaveCount(0);
  await page.clock.runFor(60_000);
  expect(requests).toHaveLength(2);
});

test("stops checking when a check finds the session ended", async ({ page, baseURL }) => {
  const requests = await checksAnswered(page, [{ status: 401, body: { error: "unauthorized" } }]);
  await openPending(page, baseURL!);

  await page.clock.runFor(3_000);
  await expect(page.getByRole("heading", { level: 1, name: "Your session ended." })).toBeVisible();
  await page.clock.runFor(60_000);
  expect(requests).toHaveLength(1);
});
