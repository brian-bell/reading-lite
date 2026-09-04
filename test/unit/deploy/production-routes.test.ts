import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Route = { pattern: string; zone_name: string };

/**
 * Collect the `[[<table>]]` route blocks from wrangler.toml. Deliberately a
 * small hand parser: the repo has no TOML dependency, and the assertion we
 * care about is the exact set of (pattern, zone) pairs per environment.
 *
 * A block that does not resolve to a plain (pattern, zone_name) route — one
 * written with `zone_id`, or promoted to a `custom_domain`, which claims the
 * whole hostname instead — is reported as `null` rather than skipped. Dropping
 * it silently would let an extra route hide from the exact-set assertions.
 */
function routesFor(toml: string, table: string): (Route | null)[] {
  const lines = toml.split("\n");
  const routes: (Route | null)[] = [];
  let current: (Partial<Route> & { custom_domain?: boolean }) | null = null;
  const close = () => {
    if (!current) return;
    const plain = current.pattern && current.zone_name && !current.custom_domain;
    routes.push(plain ? { pattern: current.pattern!, zone_name: current.zone_name! } : null);
  };
  // Match the header however TOML allows it to be spelled — inner whitespace or
  // a trailing comment must not make a whole block invisible to the count.
  const header = new RegExp(`^\\[\\[\\s*${table.replace(/\./g, "\\.")}\\s*\\]\\]\\s*(?:#.*)?$`);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      close();
      current = header.test(line) ? {} : null;
      continue;
    }
    if (current && /^custom_domain\s*=\s*true\b/.test(line)) current.custom_domain = true;
    if (!current) continue;
    // Tolerate single quotes and a trailing comment, so a route written in
    // either form still counts against the exact-set assertions below.
    const match = /^(pattern|zone_name)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match) current[match[1] as keyof Route] = match[2] ?? match[3];
  }
  close();
  return routes;
}

const wrangler = readFileSync("wrangler.toml", "utf8");

describe("production worker routes", () => {
  const routes = routesFor(wrangler, "env.production.routes");

  it("keeps the reading-lite.bbell.dev routes while dual-serving", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "reading-lite.bbell.dev/api/*", zone_name: "bbell.dev" },
        { pattern: "reading-lite.bbell.dev/health", zone_name: "bbell.dev" },
        { pattern: "reading-lite.bbell.dev/mcp*", zone_name: "bbell.dev" },
      ]),
    );
  });

  it("serves the same three path sets on bbookmarks.com", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "bbookmarks.com/api/*", zone_name: "bbookmarks.com" },
        { pattern: "bbookmarks.com/health", zone_name: "bbookmarks.com" },
        { pattern: "bbookmarks.com/mcp*", zone_name: "bbookmarks.com" },
      ]),
    );
  });

  it("routes exactly those six patterns and nothing else", () => {
    // `www` is handled by a Cloudflare redirect rule, not by a worker route.
    expect(routes).toHaveLength(6);
    expect(routes.every((route) => route !== null)).toBe(true);
    expect(routes.some((route) => route?.pattern.startsWith("www."))).toBe(false);
  });

  it("counts a route however its block is spelled", () => {
    // The assertions above are only as good as the parser's blind spots, so
    // prove the shapes that could smuggle a seventh route past them.
    const smuggled = [
      '[[env.production.routes]] # temporarily\npattern = "extra.example/api/*"\nzone_name = "example"',
      '[[ env.production.routes ]]\npattern = "extra.example/api/*"\nzone_name = "example"',
      "[[env.production.routes]]\npattern = 'extra.example/api/*' # note\nzone_name = 'example'",
    ];
    for (const block of smuggled) {
      expect(routesFor(`${wrangler}\n\n${block}\n`, "env.production.routes")).toHaveLength(7);
    }

    // A block that is not a plain (pattern, zone_name) route still has to be
    // counted — as null — so it cannot hide inside the length assertion.
    const notPlain = [
      '[[env.production.routes]]\npattern = "extra.example/api/*"\nzone_id = "abc123"',
      '[[env.production.routes]]\npattern = "extra.example"\nzone_name = "example"\ncustom_domain = true',
    ];
    for (const block of notPlain) {
      const parsed = routesFor(`${wrangler}\n\n${block}\n`, "env.production.routes");
      expect(parsed).toHaveLength(7);
      expect(parsed.at(-1)).toBeNull();
    }
  });

  it("declares every route in the block form the assertions above count", () => {
    // The inline `routes = [...]` array and the singular `route = "..."` are the
    // forms the block parser cannot count, and a route hidden in either would
    // quietly weaken the exact-set assertions.
    expect(wrangler).not.toMatch(/^\s*routes\s*=\s*\[/m);
    expect(wrangler).not.toMatch(/^\s*route\s*=/m);
  });
});

describe("staging worker routes", () => {
  it("stays on bbell.dev, untouched by the production domain move", () => {
    expect(routesFor(wrangler, "env.staging.routes")).toEqual([
      { pattern: "reading-lite-staging.bbell.dev/api/*", zone_name: "bbell.dev" },
      { pattern: "reading-lite-staging.bbell.dev/health", zone_name: "bbell.dev" },
      { pattern: "reading-lite-staging.bbell.dev/mcp*", zone_name: "bbell.dev" },
    ]);
  });
});
