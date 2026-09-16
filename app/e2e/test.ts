// The suite's test object: theme as a project option, the harness URL as
// baseURL, the fixture pack's clock pinned in the browser, and one helper that
// loads a coverage case in its signed-in or signed-out state.

import { test as base, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import type { EvidenceCase, SignedState } from "./coverage";
import pack from "./fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "./harness";
import { libraryItems, libraryPage } from "./library-page.js";
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
 * Serves `GET /api/readings` in the browser from the pack's list index (#413)
 * and the generated rows past it (#414), the same page the stub entrypoint
 * gives the server render. The library reads its first page on the server,
 * so only a client-side navigation to it asks here. `requests` records each
 * list request the browser made. `answer`, when given, replaces the page with
 * one canned answer (#416): what a page change, or the request after a
 * server render that could not read the list, gets back. It may change
 * between calls.
 */
export async function serveLibraryInBrowser(
  page: Page,
  requests: string[] = [],
  answer?: () => { status: number; body: unknown },
): Promise<void> {
  await page.route(/\/api\/readings(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    if (answer) {
      const { status, body } = answer();
      await route.fulfill({ status, json: body });
      return;
    }
    const offset = url.searchParams.get("offset");
    const body = libraryPage(libraryItems(pack.list_index.items), {
      q: url.searchParams.get("q") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      offset: offset === null ? 0 : Number(offset),
    });
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

/**
 * Serves `GET /api/readings/:id/diagnostics` in the browser from the pack
 * (#373). The Details section fetches it once opened, never through the
 * server render. `answer` replaces the fulfilment for the failure and
 * still-loading states.
 */
export async function serveDiagnosticsInBrowser(
  page: Page,
  answer?: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route("**/api/readings/*/diagnostics", async (route) => {
    if (answer) {
      await answer(route);
      return;
    }
    const segments = new URL(route.request().url()).pathname.split("/");
    const id = decodeURIComponent(segments.at(-2) ?? "");
    const body = pack.diagnostics[id as keyof typeof pack.diagnostics];
    if (!body) {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    await route.fulfill({ status: 200, json: body });
  });
}

/**
 * Serves the two files "Open as file" fetches (#373): the extracted Markdown
 * as serveSourceInBrowser does, and `GET /api/readings/:id/content/raw` from
 * the pack's raw captures with their stored content type. An id without one
 * is a 404, as for a pending or failed reading.
 */
export async function serveFilesInBrowser(page: Page): Promise<void> {
  await serveSourceInBrowser(page);
  await page.route("**/api/readings/*/content/raw", async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/");
    const id = decodeURIComponent(segments.at(-3) ?? "");
    const raw = pack.raws[id as keyof typeof pack.raws];
    if (!raw) {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    await route.fulfill({ status: 200, contentType: raw.content_type, body: raw.body });
  });
}

export async function signIn(context: BrowserContext, baseURL: string, session = SESSION_COOKIE_VALUE): Promise<void> {
  await context.addCookies([{ name: sessionCookieName(baseURL), value: session, url: baseURL }]);
}

/**
 * Applies the case's state, installs its `stub` routes, loads it, and waits
 * for its heading. A case's `prepare` may take the browser offline (#416);
 * the next load puts it back.
 */
export async function openCase(
  page: Page,
  baseURL: string,
  evidence: Pick<EvidenceCase, "path" | "state" | "heading" | "prepare" | "session" | "stub">,
): Promise<void> {
  await page.context().setOffline(false);
  await applyState(page.context(), baseURL, evidence.state, evidence.session);
  await evidence.stub?.(page);
  await page.goto(evidence.path);
  await expect(page.getByRole("heading", { level: 1, name: evidence.heading })).toBeVisible();
  await evidence.prepare?.(page);
}

async function applyState(
  context: BrowserContext,
  baseURL: string,
  state: SignedState,
  session: string | undefined,
): Promise<void> {
  if (session !== undefined) await signIn(context, baseURL, session);
  else if (state === "signed-in") await signIn(context, baseURL);
}
