// The suite's test object: theme as a project option, the harness URL as
// baseURL, the fixture pack's clock pinned in the browser, and one helper that
// loads a coverage case in its signed-in or signed-out state.

import { test as base, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import type { EvidenceCase } from "./coverage";
import pack from "./fixtures/fixture-pack.json" with { type: "json" };
import { harnessBaseUrl } from "./harness";
import { libraryItems, libraryPage, withReadingTerms } from "./library-page.js";
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
 * render's service binding. It serves the pack's relationship graph too, which
 * the reading page reads in the browser. `overrides` replaces a body, and an id absent from
 * both is a 404 — the removed target. `requests` records the id of each
 * reading the browser asked for, and `answer`, when given, replaces the answer
 * for a request with a canned one (#406): a reading's status checks. It may
 * change between calls.
 *
 * Meaning search (POST /api/readings/search) answers E2E_MEANING_RESULTS, one
 * reading in each closeness band, and More like this
 * (GET /api/readings/:id/similar) answers E2E_SIMILAR without the reading
 * itself (reading-lite-kl7y.5). Neither is recorded in `requests`.
 */
export const E2E_MEANING_RESULTS = {
  items: [
    {
      id: "rd_FXATTENT01",
      url: "https://fieldnotes.example/2026/a-quieter-internet",
      title: "A quieter internet is a choice we can make",
      score: 0.71,
    },
    {
      id: "rd_FXFRICTN01",
      url: "https://adjacent.example/the-case-for-a-little-friction",
      title: "The case for a little friction",
      score: 0.62,
    },
    {
      id: "rd_FXSPARSE01",
      url: "https://small-hours.example/against-the-endless-queue",
      title: "Against the endless queue",
      score: 0.56,
    },
  ],
};

export const E2E_SIMILAR = [
  {
    id: "rd_FXSPARSE01",
    url: "https://small-hours.example/against-the-endless-queue",
    title: "Against the endless queue",
    tldr: "A reading queue can become a list of obligations. Rivera proposes keeping a small set of active interests and allowing the rest to remain an archive.",
    score: 0.68,
  },
  {
    id: "rd_FXPAPER001",
    url: "https://small-hours.example/reading-on-paper-again",
    title: "Reading on paper, again",
    tldr: "A month of printing every long read. Rivera reports slower reading, fewer saves, and a surprising number of finished pieces.",
    score: 0.61,
  },
];

export async function serveReadingsInBrowser(
  page: Page,
  overrides: Record<string, unknown> = {},
  requests: string[] = [],
  answer?: (id: string) => { status: number; body: unknown } | undefined,
): Promise<void> {
  await page.route("**/api/readings/*/similar", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    await route.fulfill({ status: 200, json: { items: E2E_SIMILAR.filter((item) => item.id !== id) } });
  });
  await page.route("**/api/readings/*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    if (id === "terms") {
      await route.fulfill({ status: 200, json: pack.catalog_index });
      return;
    }
    if (id === "relationships") {
      await route.fulfill({ status: 200, json: pack.relationships });
      return;
    }
    if (id === "search" && route.request().method() === "POST") {
      await route.fulfill({ status: 200, json: E2E_MEANING_RESULTS });
      return;
    }
    requests.push(id);
    const canned = answer?.(id);
    if (canned) {
      await route.fulfill({ status: canned.status, json: canned.body });
      return;
    }
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
 * between calls, and it is given the request's URL to page by. `delayMs`
 * holds the answer back, so the page's loading state is on screen first.
 */
const FACET_PARAMS = [
  ["person", "people"],
  ["org", "orgs"],
  ["keyword", "keywords"],
  ["host", "hosts"],
] as const;

function facetFromSearch(
  params: URLSearchParams,
): { kind: "people" | "orgs" | "keywords" | "hosts"; term: string } | undefined {
  for (const [param, kind] of FACET_PARAMS) {
    const term = params.get(param)?.trim();
    if (term) return { kind, term };
  }
  return undefined;
}

export async function serveLibraryInBrowser(
  page: Page,
  requests: string[] = [],
  answer?: (url: URL) => { status: number; body: unknown; delayMs?: number },
): Promise<void> {
  await page.route(/\/api\/readings(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    if (answer) {
      const { status, body, delayMs } = answer(url);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ status, json: body });
      return;
    }
    const offset = url.searchParams.get("offset");
    const body = libraryPage(withReadingTerms(libraryItems(pack.list_index.items), pack.readings), {
      q: url.searchParams.get("q") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      offset: offset === null ? 0 : Number(offset),
      facet: facetFromSearch(url.searchParams),
    });
    await route.fulfill({ status: 200, json: body });
  });
}

/**
 * Serves `GET /api/desk` in the browser from the pack's first-visit desk, the
 * body the stub entrypoint gives the server render. The desk page reads it
 * on the server, so only its status refresh and a client-side navigation to
 * it ask here, as do the desk toggles and the session bar on other pages.
 * `requests` records each request's path and query.
 */
export async function serveDeskInBrowser(page: Page, requests: string[] = []): Promise<void> {
  await page.route(/\/api\/desk(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    await route.fulfill({ status: 200, json: pack.desk });
  });
}

/**
 * Answers `POST /api/readings` in the browser with one canned response, and
 * records the saves made (#431, #432, #433): an accepted save, an owner the
 * reader already has, or a refusal the page renders, from a 400 to a 503.
 *
 * POST only: `GET /api/readings` is the library's own read, which has to fall
 * through to the Worker (or to a `serveLibraryInBrowser` route), or a page's
 * list would be answered by the save stub.
 */
export async function serveSaveInBrowser(
  page: Page,
  answer: { status: number; json: unknown },
): Promise<Request[]> {
  const saves: Request[] = [];
  await page.route("**/api/readings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    saves.push(route.request());
    await route.fulfill(answer);
  });
  return saves;
}

/**
 * Serves `/api/auth/sessions` in the browser (#340.1). Account pages fetch
 * the list on demand and never through the server render, so the stub
 * entrypoint has no part in it. Writes are recorded so a spec can prove CSRF
 * and that cancel sent nothing.
 */
export const E2E_SESSIONS = {
  sessions: [
    {
      id: "ses_this_device",
      current: true,
      created_at_ms: 1,
      authenticated_at_ms: 1,
      last_seen_at_ms: 2,
      idle_expires_at_ms: 3,
      absolute_expires_at_ms: 4,
      revoked_at_ms: null,
      revocation_reason: null,
      user_agent_label: "Firefox",
      usable: true,
    },
    {
      id: "ses_phone",
      current: false,
      created_at_ms: 1,
      authenticated_at_ms: 1,
      last_seen_at_ms: 2,
      idle_expires_at_ms: 3,
      absolute_expires_at_ms: 4,
      revoked_at_ms: null,
      revocation_reason: null,
      user_agent_label: "Phone",
      usable: true,
    },
    {
      id: "ses_expired",
      current: false,
      created_at_ms: 1,
      authenticated_at_ms: 1,
      last_seen_at_ms: 1,
      idle_expires_at_ms: 1,
      absolute_expires_at_ms: 4,
      revoked_at_ms: null,
      revocation_reason: null,
      user_agent_label: "Old laptop",
      usable: false,
    },
  ],
  session_cap_warning: "This account is at the 10-session limit.",
};

export async function serveSessionsInBrowser(
  page: Page,
  answer: { status?: number; json?: unknown } = {},
): Promise<{ revokeAll: Request[] }> {
  const revokeAll: Request[] = [];
  const listed = answer.json ?? E2E_SESSIONS;
  const status = answer.status ?? 200;
  // Await the route: account pages fetch GET /api/auth/sessions on mount, so
  // a fire-and-forget install can miss the first request (Worker 404).
  await page.route("**/api/auth/sessions**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/auth/sessions") {
      await route.fulfill({ status, json: listed });
      return;
    }
    if (request.method() === "POST" && path === "/api/auth/sessions/revoke-all") {
      revokeAll.push(request);
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }
    if (request.method() === "DELETE" && path.startsWith("/api/auth/sessions/")) {
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }
    await route.fallback();
  });
  return { revokeAll };
}

export const E2E_TOKENS = {
  tokens: [
    {
      id: "tok_ci",
      name: "CI",
      format: "standard",
      scopes: ["readings:read", "readings:write"],
      created_at_ms: 1,
      expires_at_ms: 4_102_444_800_000,
      revoked_at_ms: null,
      last_used_at_ms: null,
      user_agent_label: "Firefox",
      usable: true,
    },
    {
      id: "tok_old",
      name: "Old script",
      format: "standard",
      scopes: ["readings:read"],
      created_at_ms: 1,
      expires_at_ms: 2,
      revoked_at_ms: 2,
      last_used_at_ms: 2,
      user_agent_label: null,
      usable: false,
    },
  ],
};

/**
 * GET /api/auth/tokens and DELETE /api/auth/tokens/:id (#340.7). Awaited for
 * the same reason as the sessions route: the account page reads the tokens on
 * mount. A revoke is recorded and answered 200, and the list shows that token
 * revoked from then on, unless `revoke` gives the answer instead. A create is
 * recorded and answered 201 with E2E_TOKEN_SECRET, and the list shows the new
 * token, unless `create` gives the answer instead.
 */
export async function serveTokensInBrowser(
  page: Page,
  answer: {
    status?: number;
    json?: unknown;
    revoke?: { status: number; json: unknown };
    create?: { status: number; json: unknown };
  } = {},
): Promise<{ revokes: Request[]; creates: Request[] }> {
  const revokes: Request[] = [];
  const creates: Request[] = [];
  const revoked = new Set<string>();
  const minted: (typeof E2E_TOKENS.tokens)[number][] = [];
  await page.route("**/api/auth/tokens**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/auth/tokens") {
      const listed = answer.json ?? {
        tokens: [...E2E_TOKENS.tokens, ...minted].map((token) =>
          revoked.has(token.id) ? { ...token, usable: false, revoked_at_ms: token.revoked_at_ms ?? 3 } : token,
        ),
      };
      await route.fulfill({ status: answer.status ?? 200, json: listed });
      return;
    }
    if (request.method() === "POST" && path === "/api/auth/tokens") {
      creates.push(request);
      if (answer.create) {
        await route.fulfill(answer.create);
        return;
      }
      const body = request.postDataJSON() as { name: string; scopes: string[] };
      const token = { ...E2E_TOKENS.tokens[0]!, id: `tok_${minted.length + 1}`, name: body.name, scopes: body.scopes };
      minted.push(token);
      await route.fulfill({ status: 201, json: { ...token, token: E2E_TOKEN_SECRET } });
      return;
    }
    if (request.method() === "DELETE" && path.startsWith("/api/auth/tokens/")) {
      revokes.push(request);
      if (answer.revoke) {
        await route.fulfill(answer.revoke);
        return;
      }
      revoked.add(decodeURIComponent(path.slice("/api/auth/tokens/".length)));
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }
    await route.fallback();
  });
  return { revokes, creates };
}

/** The value a stubbed create answers with: a real token's length, unbroken. */
export const E2E_TOKEN_SECRET = `tok_0b9e3c1a-5d2f-4e7a-9c8b-6f1d2e3a4b5c.${"7f".repeat(32)}`;

export const E2E_SETTINGS = {
  schema_version: 1,
  notify_immediate: true,
  digest_cadence: "off",
  time_zone: "UTC",
  digest_hour_local: 8,
  digest_weekday: 1,
  created_at_ms: 1,
  updated_at_ms: 2,
};

/**
 * GET and POST /api/auth/settings (#340.6). Awaited for the same reason as the
 * sessions route: the account page reads the settings on mount. A save
 * answers with the stored row changed by the body.
 */
export async function serveSettingsInBrowser(
  page: Page,
  answer: { status?: number; json?: unknown } = {},
): Promise<{ saves: Request[] }> {
  const saves: Request[] = [];
  let stored: Record<string, unknown> = { ...E2E_SETTINGS };
  await page.route("**/api/auth/settings", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: answer.status ?? 200, json: answer.json ?? stored });
      return;
    }
    if (request.method() === "POST") {
      saves.push(request);
      stored = { ...stored, ...(request.postDataJSON() as Record<string, unknown>) };
      await route.fulfill({ status: 200, json: stored });
      return;
    }
    await route.fallback();
  });
  return { saves };
}

const HOUR_MS = 60 * 60 * 1000;
/** The browser's pinned clock (the `page` fixture above): every export time is read against it. */
const PACK_NOW_MS = Date.parse(pack.generated_at);
const E2E_EXPORT = {
  id: "exp_e2e",
  requested_at: new Date(PACK_NOW_MS - HOUR_MS).toISOString(),
  started_at: new Date(PACK_NOW_MS - HOUR_MS + 4_000).toISOString(),
  completed_at: new Date(PACK_NOW_MS - HOUR_MS + 120_000).toISOString(),
  expires_at: new Date(PACK_NOW_MS + 7 * 24 * HOUR_MS - HOUR_MS + 120_000).toISOString(),
  error: null,
};
/** A request is allowed now: nothing counted is inside the rolling day. */
const EXPORT_ALLOWED = new Date(PACK_NOW_MS - 30 * 24 * HOUR_MS).toISOString();
/** A counted export an hour old holds the day's slot for 23 hours more. */
const EXPORT_HELD = new Date(PACK_NOW_MS + 23 * HOUR_MS).toISOString();

/** GET /api/exports/latest bodies, one per state (reading-lite-mxwx.5). */
export const E2E_EXPORTS = {
  none: { export: null, next_allowed_at: EXPORT_ALLOWED },
  queued: {
    export: { ...E2E_EXPORT, status: "queued", started_at: null, completed_at: null, expires_at: null },
    next_allowed_at: EXPORT_HELD,
  },
  building: {
    export: { ...E2E_EXPORT, status: "building", completed_at: null, expires_at: null },
    next_allowed_at: EXPORT_HELD,
  },
  ready: { export: { ...E2E_EXPORT, status: "ready" }, next_allowed_at: EXPORT_HELD },
  failed: {
    export: { ...E2E_EXPORT, status: "failed", expires_at: null, error: { code: "dead_letter" } },
    next_allowed_at: EXPORT_ALLOWED,
  },
  expired: {
    export: {
      ...E2E_EXPORT,
      status: "expired",
      requested_at: new Date(PACK_NOW_MS - 9 * 24 * HOUR_MS).toISOString(),
      started_at: new Date(PACK_NOW_MS - 9 * 24 * HOUR_MS + 4_000).toISOString(),
      completed_at: new Date(PACK_NOW_MS - 9 * 24 * HOUR_MS + 120_000).toISOString(),
      expires_at: new Date(PACK_NOW_MS - 2 * 24 * HOUR_MS + 120_000).toISOString(),
    },
    next_allowed_at: EXPORT_ALLOWED,
  },
};

/** The 429 another tab's export earns: the next request is an hour away. */
export const E2E_EXPORT_DAILY_LIMIT = {
  status: 429,
  json: { limit: "daily_export", reset_at: new Date(PACK_NOW_MS + HOUR_MS).toISOString() },
};

/**
 * GET /api/exports/latest, POST /api/exports, and the download
 * (reading-lite-mxwx.5). Awaited for the same reason as the sessions route:
 * the account page reads the status on mount. Each status read answers the
 * next body of `latest` and then repeats the last, so a spec can walk an
 * export from none through queued and building to ready. A request is
 * recorded and answered 202, unless `request` gives the answer instead. A
 * download is recorded and answered with a small zip as an attachment.
 */
export async function serveExportInBrowser(
  page: Page,
  answer: { latest?: unknown[]; request?: { status: number; json: unknown } } = {},
): Promise<{ requests: Request[]; downloads: Request[] }> {
  const requests: Request[] = [];
  const downloads: Request[] = [];
  const latest = [...(answer.latest ?? [E2E_EXPORTS.none])];
  await page.route("**/api/exports**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/exports/latest") {
      const body = latest.length > 1 ? latest.shift() : latest[0];
      await route.fulfill({ status: 200, json: body });
      return;
    }
    if (request.method() === "POST" && path === "/api/exports") {
      requests.push(request);
      await route.fulfill(answer.request ?? { status: 202, json: { id: E2E_EXPORT.id, status: "queued" } });
      return;
    }
    if (request.method() === "GET" && /^\/api\/exports\/[^/]+\/download$/.test(path)) {
      downloads.push(request);
      // An empty zip: the end-of-central-directory record alone.
      const body = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
      await route.fulfill({
        status: 200,
        body,
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="reading-lite-archive.zip"',
        },
      });
      return;
    }
    await route.fallback();
  });
  return { requests, downloads };
}

const E2E_PROVIDER_KEY = { provider: "openai", last_four: "c0de", status: "active", validated_at_ms: PACK_NOW_MS - HOUR_MS };
const E2E_PROVIDER_LIMITS = {
  effort: "high",
  daily_spend_cap_microdollars: null,
  effective_daily_spend_microdollars: 2_000_000,
  operator_daily_spend_microdollars: 2_000_000,
};

/** GET /api/auth/provider bodies, one per key state the backend has (reading-lite-gh341.8). */
export const E2E_PROVIDER = {
  missing: { ...E2E_PROVIDER_LIMITS, credential: null },
  connected: { ...E2E_PROVIDER_LIMITS, credential: E2E_PROVIDER_KEY },
  invalid: { ...E2E_PROVIDER_LIMITS, credential: { ...E2E_PROVIDER_KEY, status: "invalid" } },
};

/** A key the connect form can be given: never sent anywhere but the stub. */
export const E2E_PROVIDER_API_KEY = "sk-proj-e2e0000000000000000c0de";

/**
 * GET, POST, and DELETE /api/auth/provider, POST .../preferences, and GET
 * .../usage (reading-lite-gh341.8). Awaited for the same reason as the
 * sessions route: the provider page reads the settings and usage on mount.
 * A connect stores the key's last four and a removal clears it, unless
 * `connect` or `remove` gives the answer instead; a preferences save answers
 * with the settings changed by the body. Usage answers today's charges
 * against the effective limit, unless `usage` gives the answer instead.
 */
export async function serveProviderInBrowser(
  page: Page,
  answer: {
    json?: unknown;
    connect?: { status: number; json: unknown };
    remove?: { status: number; json: unknown };
    usage?: { status: number; json: unknown };
  } = {},
): Promise<{ connects: Request[]; removes: Request[]; saves: Request[] }> {
  const connects: Request[] = [];
  const removes: Request[] = [];
  const saves: Request[] = [];
  let stored = { ...((answer.json ?? E2E_PROVIDER.missing) as typeof E2E_PROVIDER.missing) } as Record<string, unknown>;
  await page.route("**/api/auth/provider**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/provider/usage" && request.method() === "GET") {
      await route.fulfill(
        answer.usage ?? {
          status: 200,
          json: {
            day_key: pack.generated_at.slice(0, 10),
            charged_microdollars: 120_000,
            effective_daily_spend_microdollars: stored.effective_daily_spend_microdollars,
            reset_at_ms: Date.parse(`${pack.generated_at.slice(0, 10)}T00:00:00Z`) + 24 * HOUR_MS,
            observed_at_ms: PACK_NOW_MS,
          },
        },
      );
      return;
    }
    if (path === "/api/auth/provider/preferences" && request.method() === "POST") {
      saves.push(request);
      const body = request.postDataJSON() as { effort?: string; daily_spend_cap_microdollars?: number | null };
      if (body.effort !== undefined) stored = { ...stored, effort: body.effort };
      if (body.daily_spend_cap_microdollars !== undefined) {
        const cap = body.daily_spend_cap_microdollars;
        stored = {
          ...stored,
          daily_spend_cap_microdollars: cap,
          effective_daily_spend_microdollars: cap ?? stored.operator_daily_spend_microdollars,
        };
      }
      await route.fulfill({ status: 200, json: stored });
      return;
    }
    if (path !== "/api/auth/provider") {
      await route.fallback();
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, json: stored });
      return;
    }
    if (request.method() === "POST") {
      connects.push(request);
      if (answer.connect) {
        await route.fulfill(answer.connect);
        return;
      }
      const key = String((request.postDataJSON() as { api_key: string }).api_key);
      stored = { ...stored, credential: { ...E2E_PROVIDER_KEY, last_four: key.slice(-4), validated_at_ms: PACK_NOW_MS } };
      await route.fulfill({ status: 200, json: stored });
      return;
    }
    if (request.method() === "DELETE") {
      removes.push(request);
      if (answer.remove) {
        await route.fulfill(answer.remove);
        return;
      }
      stored = { ...stored, credential: null };
      await route.fulfill({ status: 200, json: stored });
      return;
    }
    await route.fallback();
  });
  return { connects, removes, saves };
}

export async function serveInboxInBrowser(
  page: Page,
  items: readonly ServedInboxItem[] = pack.inbox,
): Promise<void> {
  const byId = new Map(items.map((item) => [item.id, item]));
  await page.route("**/api/inbox**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const match = /^\/api\/inbox(?:\/([^/]+))?$/.exec(path);
    if (request.method() !== "GET" || !match) {
      await route.fallback();
      return;
    }
    const id = match[1];
    if (id === undefined) {
      await route.fulfill({ status: 200, json: { items: items.map(inboxMeta) } });
      return;
    }
    const item = byId.get(decodeURIComponent(id));
    if (!item) {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    await route.fulfill({ status: 200, json: item });
  });
}

interface ServedInboxItem {
  id: string;
  markdown: string;
}

function inboxMeta(item: ServedInboxItem): Omit<ServedInboxItem, "markdown"> {
  const { markdown: _markdown, ...meta } = item;
  return meta;
}

/**
 * Sets the session cookie with the backend's attributes (HttpOnly,
 * SameSite=Lax; `url` supplies Path=/ and, on https, Secure), so a real
 * session an external run supplies is no more exposed to page script than in
 * production.
 */
export async function signIn(context: BrowserContext, baseURL: string, session = SESSION_COOKIE_VALUE): Promise<void> {
  await context.addCookies([
    { name: sessionCookieName(baseURL), value: session, url: baseURL, httpOnly: true, sameSite: "Lax" },
  ]);
}

/**
 * Signs the context in if the case says so, installs its `stub` routes, loads
 * it, and waits for its heading.
 */
export async function openCase(
  page: Page,
  baseURL: string,
  evidence: Pick<EvidenceCase, "path" | "state" | "heading" | "prepare" | "stub">,
): Promise<void> {
  if (evidence.state === "signed-in") await signIn(page.context(), baseURL);
  await evidence.stub?.(page);
  await page.goto(evidence.path);
  await expect(page.getByRole("heading", { level: 1, name: evidence.heading })).toBeVisible();
  await evidence.prepare?.(page);
}
