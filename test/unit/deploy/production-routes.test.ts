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

/**
 * Read a single `key = "value"` var out of one `[table]` section. Same reason
 * as the route parser above: no TOML dependency, and the assertion that matters
 * is the exact string a deploy would publish.
 */
function varFor(toml: string, table: string, key: string): string | null {
  let inTable = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable = new RegExp(`^\\[\\s*${table.replace(/\./g, "\\.")}\\s*\\]\\s*(?:#.*)?$`).test(line);
      continue;
    }
    if (!inTable) continue;
    const match = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*(?:#.*)?$`).exec(line);
    if (match) return match[1] ?? match[2] ?? null;
  }
  return null;
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

  it("serves the same three path sets on readinglite.ai and readinglite.app", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "readinglite.ai/api/*", zone_name: "readinglite.ai" },
        { pattern: "readinglite.ai/health", zone_name: "readinglite.ai" },
        { pattern: "readinglite.ai/mcp*", zone_name: "readinglite.ai" },
        { pattern: "readinglite.app/api/*", zone_name: "readinglite.app" },
        { pattern: "readinglite.app/health", zone_name: "readinglite.app" },
        { pattern: "readinglite.app/mcp*", zone_name: "readinglite.app" },
      ]),
    );
  });

  it("routes exactly those nine patterns and nothing else", () => {
    // `www` belongs to a Cloudflare redirect rule, never to a worker route.
    expect(routes).toHaveLength(9);
    expect(routes.every((route) => route !== null)).toBe(true);
    expect(routes.some((route) => route?.pattern.startsWith("www."))).toBe(false);
  });

  it("counts a route however its block is spelled", () => {
    // The assertions above are only as good as the parser's blind spots, so
    // prove the shapes that could smuggle a tenth route past them.
    const smuggled = [
      '[[env.production.routes]] # temporarily\npattern = "extra.example/api/*"\nzone_name = "example"',
      '[[ env.production.routes ]]\npattern = "extra.example/api/*"\nzone_name = "example"',
      "[[env.production.routes]]\npattern = 'extra.example/api/*' # note\nzone_name = 'example'",
    ];
    for (const block of smuggled) {
      expect(routesFor(`${wrangler}\n\n${block}\n`, "env.production.routes")).toHaveLength(10);
    }

    // A block that is not a plain (pattern, zone_name) route still has to be
    // counted — as null — so it cannot hide inside the length assertion.
    const notPlain = [
      '[[env.production.routes]]\npattern = "extra.example/api/*"\nzone_id = "abc123"',
      '[[env.production.routes]]\npattern = "extra.example"\nzone_name = "example"\ncustom_domain = true',
    ];
    for (const block of notPlain) {
      const parsed = routesFor(`${wrangler}\n\n${block}\n`, "env.production.routes");
      expect(parsed).toHaveLength(10);
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

describe("production link-emitting config", () => {
  it("emits links on readinglite.ai", () => {
    // Every queue-side link — digest, notification, MCP public_url — and the
    // magic-link fallback for a request whose host is not a known public origin
    // is built from this base. The trailing slash is the convention the other
    // environments use; publicWebBase/buildMagicLinkVerifyUrl strip it.
    expect(varFor(wrangler, "env.production.vars", "WEB_BASE_URL")).toBe("https://readinglite.ai/");
  });

  it("keeps the mail sender on bbell.dev", () => {
    // The sender move is a deliberately separate step: a host cutover and a
    // mail-deliverability change must not land together.
    expect(varFor(wrangler, "env.production.vars", "EMAIL_FROM")).toBe("reading-lite@bbell.dev");
  });

  it("keeps the old host and both public hosts on the MCP origin allowlist", () => {
    // The old host stays allowed for as long as it serves — it is the rollback path.
    expect(varFor(wrangler, "env.production.vars", "MCP_ALLOWED_ORIGINS")).toBe(
      "https://reading-lite.bbell.dev,https://readinglite.ai,https://readinglite.app",
    );
  });

  it("emits staging links on staging.readinglite.ai", () => {
    expect(varFor(wrangler, "env.staging.vars", "WEB_BASE_URL")).toBe("https://staging.readinglite.ai/");
  });

  it("keeps staging's mail sender on bbell.dev", () => {
    expect(varFor(wrangler, "env.staging.vars", "EMAIL_FROM")).toBe("reading-lite@bbell.dev");
  });

  it("allows the old staging host and both public staging hosts on MCP", () => {
    expect(varFor(wrangler, "env.staging.vars", "MCP_ALLOWED_ORIGINS")).toBe(
      "https://reading-lite-staging.bbell.dev,https://staging.readinglite.ai,https://staging.readinglite.app",
    );
  });
});

describe("staging worker routes", () => {
  const routes = routesFor(wrangler, "env.staging.routes");

  it("keeps the reading-lite-staging.bbell.dev routes while dual-serving", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "reading-lite-staging.bbell.dev/api/*", zone_name: "bbell.dev" },
        { pattern: "reading-lite-staging.bbell.dev/health", zone_name: "bbell.dev" },
        { pattern: "reading-lite-staging.bbell.dev/mcp*", zone_name: "bbell.dev" },
      ]),
    );
  });

  it("serves the same three path sets on staging.readinglite.ai and staging.readinglite.app", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { pattern: "staging.readinglite.ai/api/*", zone_name: "readinglite.ai" },
        { pattern: "staging.readinglite.ai/health", zone_name: "readinglite.ai" },
        { pattern: "staging.readinglite.ai/mcp*", zone_name: "readinglite.ai" },
        { pattern: "staging.readinglite.app/api/*", zone_name: "readinglite.app" },
        { pattern: "staging.readinglite.app/health", zone_name: "readinglite.app" },
        { pattern: "staging.readinglite.app/mcp*", zone_name: "readinglite.app" },
      ]),
    );
  });

  it("routes exactly those nine patterns and nothing else", () => {
    expect(routes).toHaveLength(9);
    expect(routes.every((route) => route !== null)).toBe(true);
    expect(routes.some((route) => route?.pattern.startsWith("www."))).toBe(false);
  });
});
