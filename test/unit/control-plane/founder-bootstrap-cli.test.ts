import { describe, expect, it } from "vitest";
import {
  parseFounderBootstrapArgs,
  runFounderBootstrap,
} from "../../../scripts/founder-bootstrap";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("founder-bootstrap CLI", () => {
  it("is dry-run by default and accepts --execute", () => {
    expect(parseFounderBootstrapArgs([])).toMatchObject({
      execute: false,
      env: "local",
      confirmProduction: false,
    });
    expect(parseFounderBootstrapArgs(["--execute", "--email", "a@b.com", "--env", "staging"])).toMatchObject({
      execute: true,
      email: "a@b.com",
      env: "staging",
    });
  });

  it("refuses a production write without --confirm-production", async () => {
    const logs: string[] = [];
    const result = await runFounderBootstrap(
      parseFounderBootstrapArgs(["--execute", "--env", "production", "--email", "a@b.com"]),
      {
        envVars: {
          AUTH_ROOT_SECRET: ROOT_HEX,
          READER_API_TOKEN: "test-token",
        },
        nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
        write: (line) => logs.push(line),
        openDb: async () => {
          throw new Error("should not open db");
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(logs.join("")).toMatch(/confirm-production/);
  });

  it("prints a dry-run plan and does not write", async () => {
    const { sqlite, db } = openMigratedControlPlane();
    const logs: string[] = [];

    const result = await runFounderBootstrap(parseFounderBootstrapArgs(["--email", "Founder@Example.com"]), {
      envVars: {
        AUTH_ROOT_SECRET: ROOT_HEX,
        READER_API_TOKEN: "test-token",
      },
      nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
      write: (line) => logs.push(line),
      openDb: async () => db,
    });

    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toMatch(/DRY RUN/);
    expect(logs.join("")).toMatch(/f\*\*\*@example\.com/);
    expect(logs.join("")).not.toMatch(/founder@example.com/);
    expect(logs.join("")).not.toMatch(/test-token/);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).toEqual({ n: 0 });
  });

  it("writes the founder and imported token on --execute", async () => {
    const { sqlite, db } = openMigratedControlPlane();

    const result = await runFounderBootstrap(
      parseFounderBootstrapArgs(["--execute", "--email", "founder@example.com"]),
      {
        envVars: {
          AUTH_ROOT_SECRET: ROOT_HEX,
          READER_API_TOKEN: "test-token",
        },
        nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
        write: () => undefined,
        openDb: async () => db,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT format FROM api_tokens").get() as { format: string }).toEqual({
      format: "legacy",
    });
  });
});
