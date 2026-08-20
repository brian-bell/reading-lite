import { describe, expect, it, vi } from "vitest";
import { renderStgVars, runCloudAgentInstall } from "../../../scripts/cloud-agent-install";

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
        expect(command).toBe("npx");
        expect(args).toEqual(["wrangler", "whoami"]);
        return 0;
      },
      founderBootstrap,
    });

    expect(code).toBe(0);
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
  });
});
