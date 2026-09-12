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

function heading(text: string): string {
  return `<h1 class="page-title" tabindex="-1">${text}</h1>`;
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
    const html = await response.text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).toContain("Skip to content");
    // Signed out, the library renders the sign-in form in place.
    expect(html).toContain(heading("Sign in"));
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

  it("renders the Save reading placeholder", async () => {
    const response = await request("/save");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toContain(heading("Save reading"));
  });

  it("redirects any other path to the library", async () => {
    const response = await request("/nowhere/at-all");
    expect([302, 307]).toContain(response.status);
    expect(new URL(response.headers.get("Location") ?? "", origin).pathname).toBe("/");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("signed-in identity", () => {
  const A = { cookie: "__Host-session=session-a", email: "reader-a@example.com", csrf: "csrf-token-for-a" };
  const B = { cookie: "__Host-session=session-b", email: "reader-b@example.com", csrf: "csrf-token-for-b" };

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

  it("renders a sign-in link back to the current URL without a session", async () => {
    for (const cookie of ["", "theme=light", "__Host-session=unknown"]) {
      const response = await request("/save", { headers: cookie ? { Cookie: cookie } : {} });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const html = await response.text();
      expect(html, cookie).toContain('href="/login?next=%2Fsave"');
      expect(html, cookie).not.toContain("Account menu");
      expect(html, cookie).not.toMatch(/reader-[ab]@example\.com|csrf-token-for/);
    }
  });

  it("renders neither account state when the backend is unavailable", async () => {
    const response = await request("/", { headers: { Cookie: "__Host-session=backend-down" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Sign in");
  });

  it("keeps identity and dehydrated state separate across concurrent renders for two tenants", async () => {
    // A answers slower than B, so renders overlap and finish out of order.
    const order = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? A : B));
    const pages = await Promise.all(
      order.map(async (tenant) => ({
        tenant,
        response: await request(tenant === A ? "/" : "/save", { headers: { Cookie: tenant.cookie } }),
      })),
    );
    for (const { tenant, response } of pages) {
      const other = tenant === A ? B : A;
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const html = await response.text();
      expect(html).toContain(tenant.email);
      expect(html).toContain(tenant.csrf);
      expect(html).not.toContain(other.email);
      expect(html).not.toContain(other.csrf);
    }
  });
});

describe("sign-in routes", () => {
  const A = { cookie: "__Host-session=session-a", email: "reader-a@example.com" };

  function location(response: { headers: { get(name: string): string | null } }): string {
    const url = new URL(response.headers.get("Location") ?? "", origin);
    return `${url.pathname}${url.search}`;
  }

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

  it("renders a reading page for a session", async () => {
    const response = await request("/readings/rd_0123456789", { headers: { Cookie: A.cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(heading("Reading"));
  });

  it("does not treat an unavailable backend as signed out", async () => {
    const response = await request("/readings/rd_0123456789", { headers: { Cookie: "__Host-session=backend-down" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(heading("Reading"));
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
