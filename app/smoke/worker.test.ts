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

describe("built Worker", () => {
  // Rendered pages carry a session's identity and CSRF token, so no cache may
  // keep one; /api/* belongs to the backend's host (ADR 0003), never this one.
  it("renders private, uncacheable HTML and never serves or proxies backend paths", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe("img-src 'self' https: data:");
    expect(await response.text(), "signed out, the library is the sign-in form").toContain(heading("Sign in"));

    for (const [method, path] of [
      ["GET", "/api/whoami"],
      ["GET", "/api/readings/rd_1"],
      ["POST", "/api/readings"],
      ["GET", "/health"],
      ["POST", "/mcp"],
    ]) {
      const backend = await request(path, { method, headers: { Cookie: A.cookie } });
      expect(backend.status, `${method} ${path}`).toBe(404);
      expect(backend.headers.get("Cache-Control"), `${method} ${path}`).toBe("no-store");
      expect(await backend.text(), `${method} ${path}`).toBe("Not found");
    }
  });

  it("sends readers to sign-in and back by safe paths only, and never signs out on an outage", async () => {
    const signedOut = await request("/readings/rd_0123456789?view=source");
    expect([302, 307], "a signed-out deep link").toContain(signedOut.status);
    expect(location(signedOut)).toBe("/login?next=%2Freadings%2Frd_0123456789%3Fview%3Dsource");

    for (const [next, expected] of [
      ["/readings/rd_0123456789?view=source&x=1", "/readings/rd_0123456789?view=source"],
      ["https://evil.example/", "/"],
      ["//evil.example", "/"],
      ["/login", "/"],
    ]) {
      const response = await request(`/login?next=${encodeURIComponent(next)}`, { headers: { Cookie: A.cookie } });
      expect([302, 307], `signed in, next=${next}`).toContain(response.status);
      expect(location(response), `signed in, next=${next}`).toBe(expected);
    }

    const outage = await request("/readings/rd_0123456789", { headers: { Cookie: "__Host-session=backend-down" } });
    expect(outage.status, "an unavailable backend").toBe(200);
    expect(await outage.text(), "an unavailable backend").not.toContain(heading("Sign in"));
  });

  it("keeps identity, CSRF tokens, and library rows apart across concurrent renders for two tenants", async () => {
    // A answers slower than B, so renders overlap and finish out of order.
    // The library and Threads each read the tenant's rows during the render.
    const order = Array.from({ length: 40 }, (_, i) => ({ tenant: i % 2 === 0 ? A : B, path: i % 4 < 2 ? "/" : "/threads" }));
    const pages = await Promise.all(
      order.map(async ({ tenant, path }) => ({
        tenant,
        response: await request(path, { headers: { Cookie: tenant.cookie } }),
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
