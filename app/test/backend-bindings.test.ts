// @vitest-environment node
import { unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";
import {
  BACKEND_BINDING,
  BACKEND_ENTRYPOINT,
  ENVIRONMENTS,
  checkBackendBindings,
  type EnvironmentLabel,
  type WorkerConfigView,
} from "../config/backend-bindings";

const backend: Record<EnvironmentLabel, WorkerConfigView> = {
  local: { name: "reading-lite-dev", services: [] },
  staging: { name: "reading-lite-staging", services: [] },
  production: { name: "reading-lite", services: [] },
};

function frontendBinding(label: EnvironmentLabel, service: string): WorkerConfigView {
  const names = { local: "reading-lite-app-dev", staging: "reading-lite-app-staging", production: "reading-lite-app" };
  return { name: names[label], services: [{ binding: BACKEND_BINDING, service, entrypoint: BACKEND_ENTRYPOINT }] };
}

const correct: Record<EnvironmentLabel, WorkerConfigView> = {
  local: frontendBinding("local", "reading-lite-dev"),
  staging: frontendBinding("staging", "reading-lite-staging"),
  production: frontendBinding("production", "reading-lite"),
};

describe("checkBackendBindings", () => {
  it("accepts each environment binding its own backend", () => {
    expect(checkBackendBindings(correct, backend)).toEqual([]);
  });

  it("rejects production bound to the staging backend", () => {
    const errors = checkBackendBindings(
      { ...correct, production: frontendBinding("production", "reading-lite-staging") },
      backend,
    );
    expect(errors.join("\n")).toMatch(/production.*reading-lite-staging/);
  });

  it("rejects staging bound to the production backend", () => {
    const errors = checkBackendBindings(
      { ...correct, staging: frontendBinding("staging", "reading-lite") },
      backend,
    );
    expect(errors.join("\n")).toMatch(/staging.*reading-lite\b/);
  });

  it("rejects an extra binding that names another environment's backend", () => {
    const staging = frontendBinding("staging", "reading-lite-staging");
    staging.services.push({ binding: "OTHER", service: "reading-lite" });
    const errors = checkBackendBindings({ ...correct, staging }, backend);
    expect(errors.join("\n")).toMatch(/staging.*OTHER.*reading-lite\b/);
  });

  it("rejects a missing backend binding", () => {
    const errors = checkBackendBindings(
      { ...correct, staging: { name: "reading-lite-app-staging", services: [] } },
      backend,
    );
    expect(errors.join("\n")).toMatch(/staging.*BACKEND/);
  });

  it.each([
    ["missing", undefined],
    ["the default export", "default"],
    ["another class", "OperatorStatus"],
  ])("rejects a backend binding whose entrypoint is %s", (_label, entrypoint) => {
    const production = frontendBinding("production", "reading-lite");
    production.services[0] = { binding: BACKEND_BINDING, service: "reading-lite", entrypoint };
    const errors = checkBackendBindings({ ...correct, production }, backend);
    expect(errors.join("\n")).toMatch(/production.*entrypoint.*FrontendReads/);
  });

  it("rejects a frontend Worker named like a backend Worker", () => {
    const errors = checkBackendBindings(
      { ...correct, production: { ...correct.production, name: "reading-lite" } },
      backend,
    );
    expect(errors.join("\n")).toMatch(/production.*name/);
  });
});

describe("checked-in Wrangler configs", () => {
  function read(configPath: string): Record<EnvironmentLabel, WorkerConfigView> {
    const views = {} as Record<EnvironmentLabel, WorkerConfigView>;
    for (const { label, env } of ENVIRONMENTS) {
      // Wrangler's published Config type references a package it doesn't ship,
      // so narrow the two fields read here explicitly.
      const config: { name?: string; services?: WorkerConfigView["services"] } = unstable_readConfig(
        { config: configPath, env },
        { hideWarnings: true },
      );
      views[label] = {
        name: config.name ?? "",
        services: (config.services ?? []).map(({ binding, service, entrypoint }) => ({
          binding,
          service,
          ...(entrypoint === undefined ? {} : { entrypoint }),
        })),
      };
    }
    return views;
  }

  it("bind every frontend environment to the backend of the same environment", () => {
    const backendViews = read("../wrangler.toml");
    expect(backendViews.staging.name).toBe("reading-lite-staging");
    expect(backendViews.production.name).toBe("reading-lite");
    expect(checkBackendBindings(read("wrangler.jsonc"), backendViews)).toEqual([]);
  });

  // Wrangler defaults workers_dev to true, so an environment that omits it
  // (including a bare deploy of the local config) would be publicly reachable
  // before any route is added deliberately.
  it.each(ENVIRONMENTS)("keep the $label frontend off workers.dev and preview URLs", ({ env }) => {
    const config: { workers_dev?: boolean; preview_urls?: boolean } = unstable_readConfig(
      { config: "wrangler.jsonc", env },
      { hideWarnings: true },
    );
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
});
