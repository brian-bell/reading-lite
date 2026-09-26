import { describe, expect, it, vi } from "vitest";
import { deployWorkerCommand, type DeployWorkerDeps } from "../../../scripts/ops-lib/commands/deploy-worker";
import { checkHyperdriveBinding } from "../../../scripts/ops-lib/hyperdrive-binding";

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
id = "00000000000000000000000000000003" # a placeholder
`;

function deps(check: DeployWorkerDeps["checkHyperdriveBinding"]) {
  const err: string[] = [];
  const runWrangler = vi.fn(async () => 0);
  const validateTenantActivation = vi.fn(async () => ({ ok: true, message: "already enabled" }));
  const connect = vi.fn(async () => ({ query: async () => ({ rows: [{ present: false }] }), end: async () => {} }));
  const built: DeployWorkerDeps = {
    io: { stdout: () => undefined, stderr: (text) => err.push(text) },
    runWrangler,
    validateTenantActivation,
    checkHyperdriveBinding: check,
    env: { STAGING_DATABASE_URL: "postgres://staging" },
    readMigrations: () => [],
    connect,
  };
  return { built, err, runWrangler, validateTenantActivation, connect };
}

describe("Hyperdrive binding check", () => {
  it("refuses a placeholder id on execute and tolerates it in a plan", () => {
    expect(checkHyperdriveBinding("production", { execute: true, toml: BOUND })).toMatchObject({
      ok: false,
      error: expect.stringContaining("placeholder id"),
    });
    expect(checkHyperdriveBinding("production", { execute: false, toml: BOUND })).toEqual({ ok: true, bound: true });
    expect(checkHyperdriveBinding("staging", { execute: true, toml: BOUND })).toEqual({ ok: true, bound: true });
  });

  it("leaves a config without the binding alone", () => {
    const toml = `[[env.production.r2_buckets]]\nbinding = "READINGS_BUCKET"\n`;
    expect(checkHyperdriveBinding("production", { execute: true, toml })).toEqual({ ok: true, bound: false });
  });

  it.each(["staging", "production"] as const)("admits %s in the checked-in config", (env) => {
    expect(checkHyperdriveBinding(env, { execute: true })).toEqual({ ok: true, bound: true });
  });
});

describe("ops deploy worker behind the binding check", () => {
  const refuse: DeployWorkerDeps["checkHyperdriveBinding"] = () => ({ ok: false, error: "placeholder id" });

  it("--execute exits 2 before the activation check, the migrations or the upload", async () => {
    const { built, err, runWrangler, validateTenantActivation, connect } = deps(refuse);
    expect(await deployWorkerCommand.run(["--env", "staging", "--execute", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(2);
    expect(runWrangler).not.toHaveBeenCalled();
    expect(validateTenantActivation).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("Hyperdrive binding check: REFUSED. placeholder id");
  });

  it("a plan reports the refusal and still dry-runs", async () => {
    const { built, err, runWrangler } = deps(refuse);
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], built)).toBe(0);
    expect(err.join("\n")).toContain("Hyperdrive binding check: REFUSED");
    expect(runWrangler).toHaveBeenCalledWith(["deploy", "--env", "staging", "--dry-run"]);
  });
});
