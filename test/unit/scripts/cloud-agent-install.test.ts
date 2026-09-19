import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BEADS_VERSION,
  renderStgVars,
  resolveFounderEmail,
  runCloudAgentInstall,
} from "../../../scripts/cloud-agent-install";

describe("cloud-agent-install", () => {
  it("renders .stg.vars when staging secrets are present", () => {
    expect(
      renderStgVars({
        AUTH_ROOT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        READER_API_TOKEN: "stg-token",
        FOUNDER_EMAIL: "founder@example.com",
      }),
    ).toBe(
      [
        "AUTH_ROOT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "FOUNDER_EMAIL=founder@example.com",
        "READER_API_TOKEN=stg-token",
        "",
      ].join("\n"),
    );
  });

  it("defaults founder email when FOUNDER_EMAIL is unset", () => {
    expect(
      renderStgVars({
        AUTH_ROOT_SECRET: "aa",
        READER_API_TOKEN: "tok",
      }),
    ).toContain("FOUNDER_EMAIL=bellbm@gmail.com");
  });

  it("returns null when required secrets are missing", () => {
    expect(renderStgVars({ AUTH_ROOT_SECRET: "aa" })).toBeNull();
    expect(renderStgVars({ READER_API_TOKEN: "tok" })).toBeNull();
  });

  it("writes .stg.vars and checks wrangler auth when CLOUDFLARE_API_TOKEN is set", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const chmods: Array<{ path: string; mode: number }> = [];
    const logs: string[] = [];
    const runs: string[] = [];
    const founderBootstrap = vi.fn();

    const code = await runCloudAgentInstall({
      cwd: "/tmp/reading-lite",
      envVars: {
        AUTH_ROOT_SECRET: "aa",
        READER_API_TOKEN: "tok",
        CLOUDFLARE_API_TOKEN: "cf-token",
        CLOUDFLARE_ACCOUNT_ID: "acct",
      },
      writeFile: (filePath, content) => {
        writes.push({ path: filePath, content });
      },
      chmod: (filePath, mode) => {
        chmods.push({ path: filePath, mode });
      },
      log: (line) => logs.push(line),
      run: async (command, args) => {
        runs.push([command, ...args].join(" "));
        return 0;
      },
      founderBootstrap,
    });

    expect(code).toBe(0);
    expect(runs).toContain("npx wrangler whoami");
    expect(writes).toEqual([
      {
        path: "/tmp/reading-lite/.stg.vars",
        content: "AUTH_ROOT_SECRET=aa\nFOUNDER_EMAIL=bellbm@gmail.com\nREADER_API_TOKEN=tok\n",
      },
    ]);
    expect(chmods).toEqual([{ path: "/tmp/reading-lite/.stg.vars", mode: 0o600 }]);
    expect(logs.some((line) => line.includes("wrote .stg.vars"))).toBe(true);
    expect(founderBootstrap).not.toHaveBeenCalled();
  });

  it("runs founder-bootstrap when CLOUD_AGENT_FOUNDER_BOOTSTRAP=1", async () => {
    const founderBootstrap = vi.fn().mockResolvedValue({ exitCode: 0 });

    const code = await runCloudAgentInstall({
      envVars: {
        AUTH_ROOT_SECRET: "aa",
        READER_API_TOKEN: "tok",
        CLOUD_AGENT_FOUNDER_BOOTSTRAP: "1",
      },
      writeFile: () => {},
      chmod: () => {},
      log: () => {},
      run: async () => 0,
      founderBootstrap,
    });

    expect(code).toBe(0);
    expect(founderBootstrap).toHaveBeenCalledOnce();
    const [, deps] = founderBootstrap.mock.calls[0] as [
      unknown,
      { envVars: Record<string, string | undefined> },
    ];
    expect(deps.envVars.FOUNDER_EMAIL).toBe(resolveFounderEmail({}));
  });

  it("passes an explicit FOUNDER_EMAIL through to founder-bootstrap", async () => {
    const founderBootstrap = vi.fn().mockResolvedValue({ exitCode: 0 });

    await runCloudAgentInstall({
      envVars: {
        AUTH_ROOT_SECRET: "aa",
        READER_API_TOKEN: "tok",
        FOUNDER_EMAIL: "founder@example.com",
        CLOUD_AGENT_FOUNDER_BOOTSTRAP: "1",
      },
      writeFile: () => {},
      chmod: () => {},
      log: () => {},
      run: async () => 0,
      founderBootstrap,
    });

    const [, deps] = founderBootstrap.mock.calls[0] as [
      unknown,
      { envVars: Record<string, string | undefined> },
    ];
    expect(deps.envVars.FOUNDER_EMAIL).toBe("founder@example.com");
  });

  it.each<[string, Record<string, number | "missing">, string[], boolean]>([
    ["bootstraps an installed bd", {}, ["bd version", "bd bootstrap --yes"], false],
    [
      "installs a missing bd first",
      { "bd version": "missing" },
      ["bd version", `npm install -g @beads/bd@${BEADS_VERSION}`, "bd bootstrap --yes"],
      false,
    ],
    [
      "warns without failing when the install fails",
      { "bd version": "missing", [`npm install -g @beads/bd@${BEADS_VERSION}`]: 1 },
      ["bd version", `npm install -g @beads/bd@${BEADS_VERSION}`],
      true,
    ],
    ["warns without failing when bootstrap fails", { "bd bootstrap --yes": 1 }, ["bd version", "bd bootstrap --yes"], true],
  ])("beads setup %s", async (_name, outcomes, expectedRuns, warns) => {
    const runs: string[] = [];
    const logs: string[] = [];

    const code = await runCloudAgentInstall({
      envVars: {},
      writeFile: () => {},
      chmod: () => {},
      log: (line) => logs.push(line),
      run: async (command, args) => {
        const call = [command, ...args].join(" ");
        runs.push(call);
        const outcome = outcomes[call] ?? 0;
        if (outcome === "missing") throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
        return outcome;
      },
    });

    expect(code).toBe(0);
    expect(runs.filter((call) => call.startsWith("bd ") || call.startsWith("npm "))).toEqual(expectedRuns);
    expect(logs.some((line) => line.includes("warning: beads"))).toBe(warns);
  });

  it.each([
    ["starts the compose Postgres", {}, 0, ["docker compose up -d --wait postgres"], "Postgres ready"],
    ["warns without failing when Docker cannot start it", {}, 1, ["docker compose up -d --wait postgres"], "warning: could not start Postgres"],
    ["leaves a supplied TEST_DATABASE_URL alone", { TEST_DATABASE_URL: "postgres://ci" }, 0, [], "not starting Postgres"],
  ])("postgres setup %s", async (_name, envVars, dockerCode, expectedRuns, logged) => {
    const runs: string[] = [];
    const logs: string[] = [];
    const code = await runCloudAgentInstall({
      envVars,
      writeFile: () => {},
      chmod: () => {},
      log: (line) => logs.push(line),
      run: async (command, args) => {
        const call = [command, ...args].join(" ");
        runs.push(call);
        return command === "docker" ? dockerCode : 0;
      },
    });
    expect(code).toBe(0);
    expect(runs.filter((call) => call.startsWith("docker "))).toEqual(expectedRuns);
    expect(logs.some((line) => line.includes(logged))).toBe(true);
  });

  it("installs the SPA without leaving cwd in web/", () => {
    const env = JSON.parse(readFileSync(path.join(".cursor", "environment.json"), "utf8")) as {
      install: string;
    };
    expect(env.install).toMatch(/\(cd web && npm ci\)|npm ci --prefix web|npm --prefix web ci/);
    expect(env.install).toContain("scripts/cloud-agent-install.ts");
    expect(env.install).not.toMatch(/cd web && npm ci && /);
  });
});
