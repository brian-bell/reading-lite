import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Requests against the built Worker, including Workers Assets and _headers.
// smoke/backend-stub.js stands in for the backend. It runs under the local
// backend's Worker name, so the built config's BACKEND binding (service and
// FrontendReads entrypoint) resolves unchanged and server renders cross a real
// service binding. Requests use an absolute URL so the Worker sees the host the
// stub expects.

const HOST = "next.readinglite.test";
const origin = `http://${HOST}`;

const server = createTestHarness({
  workers: [
    { configPath: "dist/server/wrangler.json" },
    {
      config: {
        name: "reading-lite-dev",
        main: "smoke/backend-stub.js",
        compatibility_date: "2026-09-01",
      },
    },
  ],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return server.fetch(new URL(path, origin), { redirect: "manual", ...init });
}

/** Where a redirect points, as a path and query. */
function location(response: { headers: { get(name: string): string | null } }): string {
  const url = new URL(response.headers.get("Location") ?? "", origin);
  return `${url.pathname}${url.search}`;
}

function heading(text: string): string {
  return `<h1 class="page-title" tabindex="-1">${text}</h1>`;
}

/**
 * The query keys the server render dehydrated into the page. Data that travels
 * here is data the browser does not ask for again.
 */
function dehydratedQueryKeys(html: string): string[] {
  const match = /queryClientState:"((?:[^"\\]|\\.)*)"/.exec(html);
  if (!match) return [];
  const state = JSON.parse(JSON.parse(`"${match[1]}"`)) as { queries?: { queryHash: string }[] };
  return (state.queries ?? []).map((query) => query.queryHash);
}

function checkedTheme(html: string): string | undefined {
  const inputs = html.match(/<input type="radio" name="theme"[^>]*>/g) ?? [];
  const checked = inputs.filter((input) => /\schecked(="")?[\s/>]/.test(input));
  expect(checked).toHaveLength(1);
  return /value="([^"]+)"/.exec(checked[0])?.[1];
}

describe("rendered pages", () => {
  it("server-renders the shell as private, uncacheable HTML", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    // The Source view's image policy (#372) rides on every rendered page.
    expect(response.headers.get("Content-Security-Policy")).toBe("img-src 'self' https: data:");
    const html = await response.text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).toContain("Skip to content");
    expect(html).toMatch(/<nav aria-label="Legal">/);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/dmca"');
    // Signed out, the library renders the sign-in form in place, and reads no rows.
    expect(html).toContain(heading("Sign in"));
    expect(dehydratedQueryKeys(html).filter((key) => key.startsWith('["library"'))).toEqual([]);
    // The skip link precedes every other focusable element.
    expect(html.match(/<(?:a|button|input|select|textarea)\b[^>]*>/)?.[0]).toBe(
      '<a class="skip-link" href="#main">',
    );
  });

  it.each(["dark", "light"])("applies theme=%s during the server render", async (theme) => {
    const html = await (await request("/", { headers: { Cookie: `theme=${theme}` } })).text();
    expect(html).toContain(`<html lang="en" data-theme="${theme}">`);
    expect(checkedTheme(html)).toBe(theme);
  });

  it.each(["theme=system", "theme=purple", ""])("leaves %j to the system preference", async (cookie) => {
    const html = await (await request("/", { headers: cookie ? { Cookie: cookie } : {} })).text();
    expect(html).toContain('<html lang="en">');
    expect(checkedTheme(html)).toBe("system");
  });

  it("redirects any other path to the library", async () => {
    const response = await request("/nowhere/at-all");
    expect([302, 307]).toContain(response.status);
    expect(new URL(response.headers.get("Location") ?? "", origin).pathname).toBe("/");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("public legal pages", () => {
  const PAGES = [
    ["/terms", "Terms of Service", "About these terms"],
    ["/privacy", "Privacy Policy", "Who is responsible"],
    ["/dmca", "Copyright Complaints", "Report a copyright concern"],
  ] as const;

  it.each(PAGES)("server-renders %s signed out, without private no-store or identity", async (path, title, section) => {
    const response = await request(path, { headers: { Cookie: "__Host-session=session-a" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(response.headers.get("Cache-Control")).not.toBe("private, no-store");
    expect(response.headers.get("Cache-Control") ?? "").not.toMatch(/no-store/);
    expect(response.headers.get("Content-Security-Policy")).toBe("img-src 'self' https: data:");
    const html = await response.text();
    expect(html).toContain(heading(title));
    expect(html).toContain(section);
    expect(html).toContain("Last updated: September 5, 2026");
    expect(html).toContain('href="mailto:operator@readinglite.app"');
    // Reachable with a session cookie, but the HTML carries no identity.
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("reader-a@example.com");
    expect(html).not.toContain("csrf-token-for-a");
    expect(dehydratedQueryKeys(html)).not.toContain('["whoami"]');
    expect(html).toContain("account-sign-in");
    const footer = /<footer class="site-footer">[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "";
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/dmca"');
  });
});

describe("signed-in identity", () => {
  const A = {
    cookie: "__Host-session=session-a",
    email: "reader-a@example.com",
    csrf: "csrf-token-for-a",
    row: "rd_A000000001",
  };
  const B = {
    cookie: "__Host-session=session-b",
    email: "reader-b@example.com",
    csrf: "csrf-token-for-b",
    row: "rd_B000000001",
  };

  it("server-renders the account menu for a session, as private, uncacheable HTML", async () => {
    const response = await request("/", { headers: { Cookie: `theme=dark; ${A.cookie}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain(`aria-label="Account menu, signed in as ${A.email}"`);
    expect(html).toContain('href="/account/security"');
    expect(html).toContain(`<html lang="en" data-theme="dark">`);
    // Dehydrated whoami, CSRF token included, for this response only.
    expect(html).toContain(A.csrf);
    expect(html).not.toContain("Sign in");
    expect(html).toContain(heading("Library"));
  });

  // The first page is read during the server render, through the binding, and
  // is in the HTML before any script runs (#413).
  it("server-renders the library's first page for a session", async () => {
    const response = await request("/", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(heading("Library"));
    expect(html).toContain('aria-label="Readings"');
    expect(html).toContain('href="/readings/rd_A000000001"');
    expect(html).toContain("Reader A&#x27;s quiet internet");
    // An untitled row is named by its URL.
    expect(html).toContain('href="/readings/rd_A000000002"');
    expect(html).toContain("https://fieldnotes.example/pending");
    // It travels with the page, so the browser does not ask for it again.
    expect(dehydratedQueryKeys(html)).toContain('["library",{"offset":0}]');
  });

  // A reload or a deep link renders the page the URL names (#414), with the
  // offset snapped as the current SPA snaps it and the URL left as it came.
  it.each([
    ["/?offset=20", 20],
    ["/?offset=25", 20],
    ["/?offset=abc", 0],
  ])("server-renders %s as the page it names, without a redirect", async (path, offset) => {
    const response = await request(path, { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    const html = await response.text();
    expect(dehydratedQueryKeys(html)).toEqual(expect.arrayContaining([`["library",{"offset":${offset}}]`]));
    expect(dehydratedQueryKeys(html).filter((key) => key.startsWith('["library"'))).toHaveLength(1);
    const pager = /<nav class="library-pager" aria-label="Pagination">.*?<\/nav>/.exec(html)?.[0] ?? "";
    if (offset === 20) {
      expect(html).toContain("Reader A&#x27;s second page");
      expect(pager).toContain("Page <!-- -->2");
      expect(pager).toContain('href="/"');
      expect(pager).not.toMatch(/href="\/\?offset=40"/);
    } else {
      expect(html).toContain("Reader A&#x27;s quiet internet");
      expect(pager).toContain("Page <!-- -->1");
      expect(pager).toContain('href="/?offset=20"');
    }
  });

  // As in the current SPA, a parameter the library doesn't read neither
  // redirects nor is dropped from the pages it links to.
  it("keeps an unknown parameter without redirecting", async () => {
    const response = await request("/?offset=20&utm_source=feed", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Reader A&#x27;s second page");
    expect(html).toMatch(/<a[^>]*href="\/\?utm_source=feed"[^>]*>Previous<\/a>/);
    expect(html).not.toContain('aria-current="page">Previous');
  });

  // A filtered deep link (#417): the filters cross the binding as the URL
  // spells them, the field shows the search, and the query key carries both.
  it("server-renders a search and a tag as the page they name, without a redirect", async () => {
    const response = await request("/?q=second&tag=none", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    const html = await response.text();
    expect(html).toContain(heading("Library"));
    expect(html).toMatch(/<input[^>]*id="library-search"[^>]*value="second"/);
    const chip = /<a[^>]*aria-label="Clear tag none"[^>]*>/.exec(html)?.[0] ?? "";
    expect(chip).toContain('href="/?q=second"');
    expect(html).toMatch(/No readings match “second” tagged none\./);
    expect(html).not.toContain("Reader A&#x27;s second page");
    // The hash sorts the key's fields.
    expect(dehydratedQueryKeys(html)).toContain('["library",{"offset":0,"q":"second","tag":"none"}]');

    const searched = await (await request("/?q=second", { headers: { Cookie: A.cookie } })).text();
    expect(searched).toContain("Reader A&#x27;s second page");
    expect(searched).not.toContain("Reader A&#x27;s quiet internet");
    const searchChip = /<a[^>]*aria-label="Clear search “second”"[^>]*>/.exec(searched)?.[0] ?? "";
    expect(searchChip).toContain('href="/"');
  });

  it("server-renders an offset past the end with its page number and the first page", async () => {
    const response = await request("/?offset=100", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(heading("Library"));
    expect(html).toMatch(/No readings on page (<!-- -->)?6(<!-- -->)?\./);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>First page<\/a>/);
    expect(dehydratedQueryKeys(html)).toContain('["library",{"offset":100}]');
  });

  // /save is a write, so it is under the signed-in guard (#431): without a
  // session it never renders, it sends the reader to sign in and back.
  it("sends /save to sign-in and back without a session", async () => {
    for (const cookie of ["", "theme=light", "__Host-session=unknown"]) {
      const response = await request("/save", { headers: cookie ? { Cookie: cookie } : {} });
      expect([302, 307], cookie).toContain(response.status);
      expect(location(response), cookie).toBe("/login?next=%2Fsave");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const html = await response.text();
      expect(html, cookie).not.toContain("Account menu");
      expect(html, cookie).not.toMatch(/reader-[ab]@example\.com|csrf-token-for/);
    }
  });

  it("server-renders the save form for a session", async () => {
    const response = await request("/save", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(heading("Save reading"));
    expect(html).toContain('role="tab"');
    expect(html).toContain('<button type="submit" class="button button-primary">Save</button>');
    expect(html).toContain('name="url"');
  });

  it("server-renders the account page's frame without the sessions list or settings", async () => {
    const response = await request("/account/security", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(heading("Account"));
    expect(html).toContain("Revoke all sessions");
    expect(html).toContain("Delete account…");
    expect(html).toContain('aria-busy="true"');
    expect(
      dehydratedQueryKeys(html).filter((key) => key.startsWith('["sessions"') || key.startsWith('["settings"')),
    ).toEqual([]);
  });

  // The common states on the library (#416), in the HTML before any script
  // runs: the state page with its own heading, the account menu still there.
  // 403 and 412 are values and travel with the page.
  it.each([
    ["session-a-forbidden", "You don&#x27;t have access to this.", "forbidden"],
    ["session-a-mismatch", "This tab is signed in to a different account than the page expects.", "usr_bbbbbbbb"],
  ])("server-renders the library's state for %s", async (session, text, detail) => {
    const response = await request("/", { headers: { Cookie: `__Host-session=${session}` } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(heading(text));
    expect(html).toContain(detail);
    expect(html).toContain(`aria-label="Account menu, signed in as ${A.email}"`);
    expect(html).not.toContain('aria-label="Readings"');
    expect(dehydratedQueryKeys(html)).toContain('["library",{"offset":0}]');
  });

  // A list that fails is the one state the server render does not settle, as
  // for a reading: the failure is not dehydrated, the page goes out busy
  // under its own heading, and the browser asks again and shows the outcome.
  it("server-renders a failed list as the busy library, for the browser to ask again", async () => {
    const response = await request("/", { headers: { Cookie: "__Host-session=session-a-outage" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(heading("Library"));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`aria-label="Account menu, signed in as ${A.email}"`);
    expect(dehydratedQueryKeys(html).filter((key) => key.startsWith('["library"'))).toEqual([]);
  });

  it("renders neither account state when the backend is unavailable", async () => {
    const response = await request("/", { headers: { Cookie: "__Host-session=backend-down" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Sign in");
  });

  it("keeps identity, library rows, and dehydrated state separate across concurrent renders for two tenants", async () => {
    // A answers slower than B, so renders overlap and finish out of order.
    const order = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? A : B));
    const pages = await Promise.all(
      order.map(async (tenant) => ({
        tenant,
        response: await request("/", { headers: { Cookie: tenant.cookie } }),
      })),
    );
    for (const { tenant, response } of pages) {
      const other = tenant === A ? B : A;
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const html = await response.text();
      expect(html).toContain(tenant.email);
      expect(html).toContain(tenant.csrf);
      expect(html).toContain(tenant.row);
      expect(html).not.toContain(other.email);
      expect(html).not.toContain(other.csrf);
      expect(html).not.toContain(other.row);
    }
  });
});

describe("sign-in routes", () => {
  const A = { cookie: "__Host-session=session-a", email: "reader-a@example.com" };

  it("renders the sign-in form on /login, with submit held until the browser loads options", async () => {
    const response = await request("/login?next=%2Freadings%2Frd_0123456789");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(heading("Sign in"));
    expect(html).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"|<input[^>]*autocomplete="email"[^>]*type="email"/i);
    expect(html).toMatch(/<button type="submit" class="button button-primary" disabled="">Email me a link<\/button>/);
    // No sign-in link to the page itself.
    expect(html).not.toContain("account-sign-in");
  });

  it("sends a signed-in reader from /login straight to a safe next", async () => {
    const response = await request("/login?next=%2Freadings%2Frd_0123456789%3Fview%3Dsource%26x%3D1", {
      headers: { Cookie: A.cookie },
    });
    expect([302, 307]).toContain(response.status);
    expect(location(response)).toBe("/readings/rd_0123456789?view=source");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each(["https://evil.example/", "//evil.example", "/login"])(
    "sends a signed-in reader home for next=%s",
    async (next) => {
      const response = await request(`/login?next=${encodeURIComponent(next)}`, { headers: { Cookie: A.cookie } });
      expect([302, 307]).toContain(response.status);
      expect(location(response)).toBe("/");
    },
  );

  it("keeps a signed-in reader on /login for step-up, with the email locked", async () => {
    const response = await request("/login?step_up=1&next=%2Faccount%2Fsecurity", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(heading("Sign in"));
    expect(html).toMatch(new RegExp(`<input[^>]*value="${A.email}"[^>]*readOnly|<input[^>]*readOnly[^>]*value="${A.email}"`, "i"));
  });

  it.each(["/auth/verify", "/login/verify"])("renders %s with Continue held until the browser reads the link", async (path) => {
    const response = await request(`${path}?next=%2Fsave`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(heading("Complete sign-in"));
    expect(html).toMatch(/<button type="button" class="button button-primary" disabled="">Continue<\/button>/);
    expect(html).not.toContain("account-sign-in");
  });

  it.each([
    ["/readings/rd_0123456789", "/login?next=%2Freadings%2Frd_0123456789"],
    ["/readings/rd_0123456789?view=source", "/login?next=%2Freadings%2Frd_0123456789%3Fview%3Dsource"],
    ["/account/security", "/login?next=%2Faccount%2Fsecurity"],
  ])("redirects a signed-out %s to sign-in with its return path", async (path, expected) => {
    const response = await request(path);
    expect([302, 307]).toContain(response.status);
    expect(location(response)).toBe(expected);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  // The reading is read during the server render, through the binding, and is
  // in the HTML before any script runs.
  it("server-renders a reading for a session", async () => {
    const response = await request("/readings/rd_0123456789", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(heading("A quieter internet is a choice we can make"));
    expect(html).toContain("fieldnotes.example");
    expect(html).toContain("Saved 7 September 2026");
    // It travels with the page, so the browser does not ask for it again.
    expect(dehydratedQueryKeys(html)).toContain('["reading","rd_0123456789"]');
  });

  // The Summary view itself, in the HTML: the lead, the summary below it, the
  // tags, and the novelty panel, all before any script runs (#370 AC 1).
  it("server-renders the Summary view, not just the reading's frame", async () => {
    const response = await request("/readings/rd_0123456789", { headers: { Cookie: A.cookie } });
    const html = await response.text();

    expect(html).toContain("A personal library can turn the internet into a place for deliberate reading.");
    expect(html).toContain("Saving is only the beginning.");
    expect(html).toContain('href="/?tag=attention"');
    expect(html).toContain("What this adds");
    expect(html).toContain("Overlaps with readings already in your library.");
  });

  // The summarizer opens summary_markdown with the tldr, so the lead would
  // otherwise be printed twice on almost every reading. Counted in the markup
  // only: the dehydrated cache carries both fields, which is correct.
  it("prints the lead once in the server-rendered markup", async () => {
    const response = await request("/readings/rd_0123456789", { headers: { Cookie: A.cookie } });
    const markup = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "");

    const lead = "A personal library can turn the internet into a place for deliberate reading.";
    expect(markup.split(lead).length - 1).toBe(1);
  });

  it("server-renders the not-found state for a reading the tenant does not have", async () => {
    const response = await request("/readings/rd_9999999999", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    // React escapes the apostrophe on the way into the document.
    expect(await response.text()).toContain(heading("This reading isn&#x27;t in your library."));
  });

  /**
   * Unavailable is not signed out: the reader stays on the reading's URL rather
   * than being sent to sign-in.
   *
   * A read that throws is the one case the server render does not settle. React
   * Query dehydrates successful queries only, so the failure does not travel in
   * the page, and the browser asks again on its own — which is the right
   * outcome for a backend that was briefly unreachable. What must not happen is
   * a redirect, or the sign-in form appearing over a live session.
   */
  it("does not treat an unavailable backend as signed out", async () => {
    const response = await request("/readings/rd_0123456789", { headers: { Cookie: "__Host-session=backend-down" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(heading("Sign in"));
    expect(html).toContain('aria-busy="true"');
    expect(dehydratedQueryKeys(html)).not.toContain('["reading","rd_0123456789"]');
  });
});

describe("backend paths", () => {
  it.each([
    ["GET", "/api"],
    ["GET", "/api/whoami"],
    ["GET", "/api/readings/rd_1"],
    ["POST", "/api/readings"],
    ["GET", "/health"],
    ["GET", "/mcp"],
    ["POST", "/mcp"],
    ["GET", "/mcp/sse"],
  ])("%s %s returns 404 without rendering or proxying", async (method, path) => {
    const response = await request(path, { method });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("Not found");
  });
});

describe("static assets", () => {
  it("serves hashed assets as publicly cacheable", async () => {
    const html = await (await request("/")).text();
    const assets = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+\.(?:css|js))"/g)].map((match) => match[1]);
    expect(assets.some((path) => path.endsWith(".css"))).toBe(true);
    expect(assets.some((path) => path.endsWith(".js"))).toBe(true);
    for (const path of new Set(assets)) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Cache-Control"), path).toBe("public, max-age=31536000, immutable");
    }
  });
});
