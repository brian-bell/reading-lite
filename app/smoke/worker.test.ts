import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Requests against the built Worker, including Workers Assets and _headers.
// The shell makes no backend reads, so BACKEND is replaced with an inert value:
// workerd refuses to start with a service binding to a Worker it isn't running.

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let origin: URL;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: "dist/server/wrangler.json",
    bindings: { BACKEND: { type: "plain_text", value: "unused by the shell" } },
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, logLevel: "error" },
  });
  await worker.ready;
  origin = await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function request(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, origin), { redirect: "manual", ...init });
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
    expect(html).toMatch(/<h1 class="page-title">Library<\/h1>/);
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
    expect(await response.text()).toMatch(/<h1 class="page-title">Save reading<\/h1>/);
  });

  it("redirects any other path to the library", async () => {
    const response = await request("/nowhere/at-all");
    expect([302, 307]).toContain(response.status);
    expect(new URL(response.headers.get("Location") ?? "", origin).pathname).toBe("/");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
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
