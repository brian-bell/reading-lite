// The suite's test object: theme as a project option, the harness URL as
// baseURL, the fixture pack's clock pinned in the browser, and one helper that
// loads a coverage case in its signed-in or signed-out state.

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import type { EvidenceCase, SignedState } from "./coverage";
import pack from "./fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "./harness";
import { SESSION_COOKIE_VALUE, sessionCookieName } from "./sessions";

export type ThemeOption = "system" | "light" | "dark";

export interface EvidenceOptions {
  /** Theme preference cookie the context carries; "system" sets none. */
  theme: ThemeOption;
}

export const test = base.extend<EvidenceOptions>({
  theme: ["system", { option: true }],

  // The harness picks its port at startup, after this config is loaded.
  baseURL: async ({}, use) => {
    await use(harnessBaseUrl());
  },

  context: async ({ context, theme, baseURL }, use) => {
    if (theme !== "system") {
      await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
    }
    await use(context);
  },

  page: async ({ page }, use) => {
    // Relative times and the pending fixture's TTL are read against the same
    // instant the snapshot was generated at, so evidence is reproducible.
    await page.clock.setFixedTime(new Date(pack.generated_at));
    await use(page);
  },
});

export { expect };

/**
 * Serves `GET /api/readings/:id` in the browser from the fixture pack, so a
 * client-side navigation between readings has a backend to ask. The frontend
 * Worker under test answers `/api/*` with 404 by design (ADR 0003: the backend
 * owns those routes), and the harness binds the stub only as the server
 * render's service binding. `overrides` replaces a body, and an id absent from
 * both is a 404 — the removed target.
 */
export async function serveReadingsInBrowser(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await page.route("**/api/readings/*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const body = overrides[id] ?? pack.readings[id as keyof typeof pack.readings];
    if (!body) {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    await route.fulfill({ status: 200, json: body });
  });
}

/**
 * Serves `GET /api/readings/:id/content` in the browser from the pack's
 * extracted Markdown (#372). The Source view fetches it on demand and never
 * through the server render, so the stub entrypoint has no part in it. An id
 * without content is a 404 — the `unavailable-source` fixture.
 */
export async function serveSourceInBrowser(page: Page): Promise<void> {
  await page.route("**/api/readings/*/content", async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/");
    const id = decodeURIComponent(segments.at(-2) ?? "");
    const markdown = pack.contents[id as keyof typeof pack.contents];
    if (markdown === undefined) {
      await route.fulfill({ status: 404, json: { error: "extracted markdown not available" } });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: markdown });
  });
}

export async function signIn(context: BrowserContext, baseURL: string): Promise<void> {
  await context.addCookies([
    { name: sessionCookieName(baseURL), value: SESSION_COOKIE_VALUE, url: baseURL },
  ]);
}

/** Applies the case's state, loads it, and waits for its heading. */
export async function openCase(
  page: Page,
  baseURL: string,
  evidence: Pick<EvidenceCase, "path" | "state" | "heading" | "prepare">,
): Promise<void> {
  await applyState(page.context(), baseURL, evidence.state);
  await page.goto(evidence.path);
  await expect(page.getByRole("heading", { level: 1, name: evidence.heading })).toBeVisible();
  await evidence.prepare?.(page);
}

async function applyState(context: BrowserContext, baseURL: string, state: SignedState): Promise<void> {
  if (state === "signed-in") await signIn(context, baseURL);
}
