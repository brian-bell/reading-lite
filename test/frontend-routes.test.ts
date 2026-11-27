import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const OAUTH_DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
] as const;

const ENVS = ["staging", "production"] as const;

function backendPatterns(toml: string, env: (typeof ENVS)[number]): string[] {
  const patterns: string[] = [];
  let section = "";
  for (const line of toml.split("\n")) {
    const header = /^\[\[(.+)\]\]$/.exec(line);
    if (header?.[1]) {
      section = header[1];
      continue;
    }
    if (section !== `env.${env}.routes`) continue;
    const pattern = /^pattern = "(.+)"$/.exec(line);
    if (pattern?.[1]) patterns.push(pattern[1]);
  }
  return patterns;
}

function frontendHosts(jsonc: string, env: (typeof ENVS)[number]): string[] {
  const stripped = jsonc.replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(stripped) as {
    env?: Record<string, { routes?: Array<{ pattern: string }> }>;
  };
  const hosts: string[] = [];
  for (const route of config.env?.[env]?.routes ?? []) {
    const host = /^([^/]+)\/\*$/.exec(route.pattern);
    if (host?.[1]) hosts.push(host[1]);
  }
  return hosts;
}

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const jsonc = readFileSync(new URL("../app/wrangler.jsonc", import.meta.url), "utf8");

it.each(ENVS)("routes API, health, MCP, and OAuth discovery on every %s frontend host", (env) => {
  const hosts = frontendHosts(jsonc, env);
  expect(hosts.length).toBeGreaterThan(0);
  const patterns = backendPatterns(toml, env);
  for (const host of hosts) {
    const required = [
      `${host}/api/*`,
      `${host}/health`,
      `${host}/mcp*`,
      ...OAUTH_DISCOVERY_PATHS.map((path) => `${host}${path}`),
    ];
    for (const pattern of required) {
      expect(patterns, pattern).toContain(pattern);
    }
  }
});
