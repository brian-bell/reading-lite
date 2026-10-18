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
  it("redirects public http to the same https url and sends HSTS only on https", async () => {
    // The dev proxy rewrites a same-host Location back to the request scheme.
    // The runtime worker is the response a deployed Worker returns.
    const worker = server.getWorker("reading-lite-app-dev");
    const moved = await worker.fetch(new URL("http://readinglite.ai/login?next=%2Flibrary&x=1"), {
      redirect: "manual",
    });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe("https://readinglite.ai/login?next=%2Flibrary&x=1");

    const api = await worker.fetch(new URL("http://readinglite.ai/api/auth/login-options?x=1"), {
      redirect: "manual",
    });
    expect(api.status).toBe(301);
    expect(api.headers.get("Location")).toBe("https://readinglite.ai/api/auth/login-options?x=1");

    const secure = await worker.fetch(new URL("https://readinglite.ai/"));
    expect(secure.status).toBe(200);
    expect(secure.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");

    const local = await worker.fetch(new URL("http://127.0.0.1:5174/login?next=%2F"), { redirect: "manual" });
    expect(local.status).toBe(200);
    expect(local.headers.get("Location")).toBeNull();
    expect(local.headers.get("Strict-Transport-Security")).toBeNull();

    const dev = await worker.fetch(new URL("http://next.readinglite.test/"));
    expect(dev.status).toBe(200);
    expect(dev.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("sends HSTS on a public host's assets through the asset proxy", async () => {
    const page = await request("/");
    expect(page.status).toBe(200);
    const html = await page.text();
    const assetPath = html.match(/\/assets\/[A-Za-z0-9._-]+/)?.[0] ?? "";
    expect(assetPath).toMatch(/^\/assets\/[A-Za-z0-9._-]+$/);

    const secure = await server.fetch(new URL(assetPath, "https://readinglite.ai"), { redirect: "manual" });
    expect(secure.status).toBe(200);
    expect(secure.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(secure.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");

    const local = await server.fetch(new URL(assetPath, origin), { redirect: "manual" });
    expect(local.status).toBe(200);
    expect(local.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(local.headers.get("Strict-Transport-Security")).toBeNull();
  });

  // Rendered pages carry a session's identity and CSRF token, so no cache may
  // keep one; /api/* belongs to the backend's host (ADR 0003), never this one.
  it("renders private, uncacheable HTML and never serves or proxies backend paths", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe("img-src 'self' https: data:");
    expect(await response.text(), "signed out, the desk is the landing").toContain(
      heading("Reading Lite summarizes what you save and connects it to what you have already read."),
    );

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
    const library = await request("/library?tag=ai");
    expect([302, 307], "the library is signed-in only").toContain(library.status);
    expect(location(library)).toBe("/login?next=%2Flibrary%3Ftag%3Dai");

    for (const cookie of [undefined, A.cookie]) {
      const moved = await request("/?q=a+b&tag=ai&offset=20", cookie ? { headers: { Cookie: cookie } } : {});
      expect([301, 302, 307, 308], `the library's old address, ${cookie ? "signed in" : "signed out"}`).toContain(
        moved.status,
      );
      expect(location(moved)).toBe("/library?q=a+b&tag=ai&offset=20");
    }

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
    // The desk, the library and Threads each read the tenant's rows during the render.
    const paths = ["/", "/library", "/threads"];
    const order = Array.from({ length: 48 }, (_, i) => ({ tenant: i % 2 === 0 ? A : B, path: paths[Math.floor(i / 2) % 3]! }));
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
