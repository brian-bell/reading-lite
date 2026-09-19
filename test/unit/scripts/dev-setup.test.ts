import { describe, expect, it, vi } from "vitest";
import { runDevSetup } from "../../../scripts/dev-setup";

describe("dev-setup", () => {
  it("applies local D1 migrations then bootstraps the founder principal", async () => {
    const calls: string[][] = [];
    const bootstrap = vi.fn().mockResolvedValue({ exitCode: 0 });

    const code = await runDevSetup({
      run: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return 0;
      },
      bootstrap,
      envVars: { READING_LITE_DATABASE_URL: "postgres://self-managed" },
      migratePostgres: async () => undefined,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(process.execPath);
    expect(calls[0]!.slice(1, 3)).toEqual(["--no-warnings", "--experimental-vm-modules"]);
    expect(calls[0]![3]).toMatch(/wrangler-dist[/\\]cli\.js$/);
    expect(calls[0]!.slice(4)).toEqual([
      "d1",
      "migrations",
      "apply",
      "reading-lite-control-dev",
      "--local",
    ]);
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("stops when migrations fail", async () => {
    const bootstrap = vi.fn();

    const code = await runDevSetup({
      run: async () => 1,
      bootstrap,
      envVars: { READING_LITE_DATABASE_URL: "postgres://self-managed" },
      migratePostgres: async () => undefined,
    });

    expect(code).toBe(1);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("starts the compose Postgres and migrates it before the D1 steps", async () => {
    const order: string[] = [];
    const code = await runDevSetup({
      run: async (command: string, args: string[]) => {
        order.push(command === "docker" ? `docker ${args.join(" ")}` : "wrangler d1");
        return 0;
      },
      bootstrap: vi.fn().mockResolvedValue({ exitCode: 0 }),
      envVars: {},
      migratePostgres: async (url) => {
        order.push(`migrate ${url}`);
      },
    });
    expect(code).toBe(0);
    expect(order).toEqual([
      "docker compose up -d --wait postgres",
      "migrate postgres://reading_lite:reading_lite@127.0.0.1:54329/reading_lite",
      "wrangler d1",
    ]);
  });

  it("returns 1 with a message, before any D1 step, when the Postgres migration fails", async () => {
    const run = vi.fn().mockResolvedValue(0);
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => void errors.push(line);
    try {
      const code = await runDevSetup({
        run,
        bootstrap: vi.fn(),
        envVars: { READING_LITE_DATABASE_URL: "postgres://self-managed" },
        migratePostgres: async () => {
          throw new Error("Migration drift");
        },
      });
      expect(code).toBe(1);
    } finally {
      console.error = original;
    }
    expect(run).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("Local Postgres migration failed: Migration drift");
  });

  it("leaves a self-managed READING_LITE_DATABASE_URL alone, and stops when Docker cannot start Postgres", async () => {
    const migratePostgres = vi.fn();
    const run = vi.fn().mockResolvedValue(0);
    await runDevSetup({
      run, migratePostgres, bootstrap: vi.fn().mockResolvedValue({ exitCode: 0 }),
      envVars: { READING_LITE_DATABASE_URL: "postgres://self-managed" },
    });
    expect(run).not.toHaveBeenCalledWith("docker", expect.anything());
    expect(migratePostgres).toHaveBeenCalledWith("postgres://self-managed");

    const blocked = vi.fn();
    const code = await runDevSetup({ run: async () => 7, migratePostgres: blocked, bootstrap: vi.fn(), envVars: {} });
    expect(code).toBe(7);
    expect(blocked).not.toHaveBeenCalled();
  });
});
