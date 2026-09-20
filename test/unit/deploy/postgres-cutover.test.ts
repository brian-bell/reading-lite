import { describe, expect, it, vi } from "vitest";
import { deployWorkerCommand, type DeployWorkerDeps } from "../../../scripts/ops-lib/commands/deploy-worker";
import { checkPostgresCutover } from "../../../scripts/ops-lib/postgres-cutover";

const BOUND = `
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "00000000000000000000000000000001"
localConnectionString = "postgres://local"

[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[[env.production.hyperdrive]]
binding = "HYPERDRIVE"
id = "00000000000000000000000000000003" # placeholder until #350
`;
const OFF = { staging: false, production: false };

function deps(check: DeployWorkerDeps["checkPostgresCutover"]) {
  const err: string[] = [];
  const runWrangler = vi.fn(async () => 0);
  const validateTenantActivation = vi.fn(async () => ({ ok: true, message: "already enabled" }));
  const connect = vi.fn(async () => ({ query: async () => ({ rows: [{ present: false }] }), end: async () => {} }));
  const built: DeployWorkerDeps = {
    io: { stdout: () => undefined, stderr: (text) => err.push(text) },
    runWrangler,
    validateTenantActivation,
    checkPostgresCutover: check,
    env: { STAGING_DATABASE_URL: "postgres://staging" },
    readMigrations: () => [],
    connect,
  };
  return { built, err, runWrangler, validateTenantActivation, connect };
}

describe("PostgreSQL cutover guard", () => {
  it("refuses a bound environment while its flag is off", () => {
    for (const env of ["staging", "production"] as const) {
      const result = checkPostgresCutover(env, { execute: true, toml: BOUND, flags: OFF });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`POSTGRES_CUTOVER_ENABLED.${env}`) });
    }
  });

  it("does not let the staging flag unlock production", () => {
    const flags = { staging: true, production: false };
    expect(checkPostgresCutover("staging", { execute: true, toml: BOUND, flags })).toEqual({ ok: true, bound: true });
    expect(checkPostgresCutover("production", { execute: true, toml: BOUND, flags }).ok).toBe(false);
  });

  it("with the flag on, refuses a placeholder Hyperdrive id on execute and tolerates it in a plan", () => {
    const flags = { staging: true, production: true };
    expect(checkPostgresCutover("production", { execute: true, toml: BOUND, flags })).toMatchObject({
      ok: false,
      error: expect.stringContaining("placeholder id"),
    });
    expect(checkPostgresCutover("production", { execute: false, toml: BOUND, flags })).toEqual({ ok: true, bound: true });
  });

  it("leaves a config without the binding alone, whatever the flags say", () => {
    const toml = `[[env.production.r2_buckets]]\nbinding = "READINGS_BUCKET"\n`;
    expect(checkPostgresCutover("production", { execute: true, toml, flags: OFF })).toEqual({ ok: true, bound: false });
  });

  it("refuses the checked-in config for both environments today", () => {
    // Real wrangler.toml, real flags: the state this branch must hold until #349/#350.
    expect(checkPostgresCutover("staging", { execute: true }).ok).toBe(false);
    expect(checkPostgresCutover("production", { execute: true }).ok).toBe(false);
  });
});

describe("ops deploy worker behind the cutover guard", () => {
  const refuse: DeployWorkerDeps["checkPostgresCutover"] = () => ({ ok: false, error: "not cut over" });

  it("--execute exits 2 before the activation check, the migrations or the upload", async () => {
    const { built, err, runWrangler, validateTenantActivation, connect } = deps(refuse);
    expect(await deployWorkerCommand.run(["--env", "staging", "--execute", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(2);
    expect(runWrangler).not.toHaveBeenCalled();
    expect(validateTenantActivation).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("PostgreSQL cutover guard: REFUSED. not cut over");
  });

  it("a plan reports the refusal and still dry-runs", async () => {
    const { built, err, runWrangler } = deps(refuse);
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(0);
    expect(err.join("\n")).toContain("PostgreSQL cutover guard: REFUSED");
    expect(runWrangler).toHaveBeenCalledWith(["deploy", "--env", "staging", "--dry-run"]);
  });
});
