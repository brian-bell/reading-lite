import { describe, expect, it } from "vitest";
import { authenticateBearer } from "../../../src/control-plane/authenticate";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import {
  parseFounderBootstrapArgs,
  runFounderBootstrap,
} from "../../../scripts/lib/founder-bootstrap";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ROTATED_ROOT_HEX = "ff".repeat(32);

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

  it("refuses staging without a direct connection string, before opening anything", async () => {
    const logs: string[] = [];
    const result = await runFounderBootstrap(
      parseFounderBootstrapArgs(["--execute", "--env", "staging", "--email", "a@b.com", "--database-url-env", "STAGING_PG"]),
      {
        envVars: { AUTH_ROOT_SECRET: ROOT_HEX, READER_API_TOKEN: "test-token" },
        nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
        write: (line) => logs.push(line),
        openDb: async () => {
          throw new Error("should not open db");
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(logs.join("")).toMatch(/missing STAGING_PG/);
  });

  it("prints a dry-run plan and does not write", async () => {
    const { raw, db } = openControlPlane();
    const logs: string[] = [];

    const result = await runFounderBootstrap(parseFounderBootstrapArgs(["--email", "Founder@Example.com"]), {
      envVars: {
        AUTH_ROOT_SECRET: ROOT_HEX,
        READER_API_TOKEN: "test-token",
      },
      nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
      write: (line) => logs.push(line),
      openDb: async () => ({ db, close: async () => undefined }),
    });

    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toMatch(/DRY RUN/);
    expect(logs.join("")).toMatch(/f\*\*\*@example\.com/);
    expect(logs.join("")).not.toMatch(/founder@example.com/);
    expect(logs.join("")).not.toMatch(/test-token/);
    expect(withMs(await raw.first("SELECT COUNT(*) AS n FROM users")) as { n: number }).toEqual({ n: 0 });
  });

  it("writes the founder and imported token on --execute", async () => {
    const { raw, db } = openControlPlane();

    const result = await runFounderBootstrap(
      parseFounderBootstrapArgs(["--execute", "--email", "founder@example.com"]),
      {
        envVars: {
          AUTH_ROOT_SECRET: ROOT_HEX,
          READER_API_TOKEN: "test-token",
        },
        nowMs: Date.parse("2026-08-16T12:00:00.000Z"),
        write: () => undefined,
        openDb: async () => ({ db, close: async () => undefined }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(withMs(await raw.first("SELECT COUNT(*) AS n FROM users")) as { n: number }).toEqual({ n: 1 });
    expect(withMs(await raw.first("SELECT format FROM api_tokens")) as { format: string }).toEqual({
      format: "legacy",
    });
  });

  it("defaults previous auth-root version to 1 during secret-only rotation", async () => {
    const { raw, db } = openControlPlane();
    const nowMs = Date.parse("2026-08-16T12:00:00.000Z");
    const openDb = async () => ({ db, close: async () => undefined });

    const first = await runFounderBootstrap(
      parseFounderBootstrapArgs(["--execute", "--email", "founder@example.com"]),
      {
        envVars: {
          AUTH_ROOT_SECRET: ROOT_HEX,
          READER_API_TOKEN: "test-token",
        },
        nowMs,
        write: () => undefined,
        openDb,
      },
    );
    expect(first.exitCode).toBe(0);
    const tokenBefore = withMs(await raw.first("SELECT id, hash_key_version FROM api_tokens")) as { id: string; hash_key_version: number };
    expect(tokenBefore.hash_key_version).toBe(1);

    // Rotate the secret only — omit AUTH_PREVIOUS_ROOT_KEY_VERSION so the CLI
    // must default it to the same version founder tokens were minted with.
    const rotated = await runFounderBootstrap(
      parseFounderBootstrapArgs(["--execute", "--email", "founder@example.com"]),
      {
        envVars: {
          AUTH_ROOT_SECRET: ROTATED_ROOT_HEX,
          AUTH_PREVIOUS_ROOT_SECRET: ROOT_HEX,
          READER_API_TOKEN: "test-token",
        },
        nowMs,
        write: () => undefined,
        openDb,
      },
    );
    expect(rotated.exitCode).toBe(0);

    const tokenAfter = withMs(await raw.first("SELECT id, hash_key_version FROM api_tokens")) as { id: string; hash_key_version: number };
    expect(tokenAfter.id).toBe(tokenBefore.id);
    expect(tokenAfter.hash_key_version).toBe(1);
    expect(withMs(await raw.first("SELECT COUNT(*) AS n FROM api_tokens")) as { n: number }).toEqual({
      n: 1,
    });

    const auth = await authenticateBearer(db, {
      authorization: "Bearer test-token",
      authRoot: { secret: parseAuthRootSecret(ROTATED_ROOT_HEX), version: 1 },
      nowMs,
    });
    expect(auth.kind).toBe("ok");
  });
});
