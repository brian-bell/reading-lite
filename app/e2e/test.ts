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
