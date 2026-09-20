import { describe, expect, it, vi } from "vitest";
import { runDevSetup } from "../../../scripts/dev-setup";

describe("dev-setup", () => {
  it("migrates local Postgres, then bootstraps the founder principal there", async () => {
    const migrated: string[] = [];
    const bootstrap = vi.fn().mockResolvedValue({ exitCode: 0 });
    const run = vi.fn().mockResolvedValue(0);

    const code = await runDevSetup({
      run,
      bootstrap,
      envVars: { READING_LITE_DATABASE_URL: "postgres://self-managed" },
      migratePostgres: async (url) => void migrated.push(url),
    });

    expect(code).toBe(0);
    // No D1: the control plane is on PostgreSQL (ADR 0005), so a self-managed
    // database means there is no subprocess to run at all.
    expect(run).not.toHaveBeenCalled();
    expect(migrated).toEqual(["postgres://self-managed"]);
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("starts the compose Postgres and migrates it before the founder bootstrap", async () => {
    const order: string[] = [];
    const code = await runDevSetup({
      run: async (command: string, args: string[]) => {
        order.push(`${command} ${args.join(" ")}`);
        return 0;
      },
      bootstrap: vi.fn().mockImplementation(async () => {
        order.push("bootstrap");
        return { exitCode: 0 };
      }),
      envVars: {},
      migratePostgres: async (url) => {
        order.push(`migrate ${url}`);
      },
    });
    expect(code).toBe(0);
    expect(order).toEqual([
      "docker compose up -d --wait postgres",
      "migrate postgres://reading_lite:reading_lite@127.0.0.1:54329/reading_lite",
      "bootstrap",
    ]);
  });

  it("returns 1 with a message, before the bootstrap, when the Postgres migration fails", async () => {
    const bootstrap = vi.fn();
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => void errors.push(line);
    try {
      const code = await runDevSetup({
        run: vi.fn().mockResolvedValue(0),
        bootstrap,
        envVars: { READING_LITE_DATABASE_URL: "postgres://self-managed" },
        migratePostgres: async () => {
          throw new Error("Migration drift");
        },
      });
      expect(code).toBe(1);
    } finally {
      console.error = original;
    }
    expect(bootstrap).not.toHaveBeenCalled();
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
