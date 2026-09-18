// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BACKEND_BINDING,
  BACKEND_ENTRYPOINT,
  ENVIRONMENTS,
  checkBackendBindings,
  checkBuiltConfig,
  readEnvironment,
  readEnvironments,
  type BuiltConfigView,
  type DeployedConfigView,
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

describe("checkBuiltConfig", () => {
  const source: DeployedConfigView = {
    ...frontendBinding("production", "reading-lite"),
    routes: [{ pattern: "next.readinglite.ai/*", zone_name: "readinglite.ai" }],
    workers_dev: false,
    preview_urls: false,
  };
  const built: BuiltConfigView = { ...source, targetEnvironment: "production" };

  it("accepts a build of the environment it was checked against", () => {
    expect(checkBuiltConfig("production", built, source, backend)).toEqual([]);
  });

  it.each<[string, BuiltConfigView, RegExp]>([
    ["built for another environment", { ...built, targetEnvironment: "staging" }, /production.*targets.*staging/],
    ["built from the top-level config", { ...built, targetEnvironment: undefined }, /production.*targets.*top level/],
    ["renamed", { ...built, name: "reading-lite-app-staging" }, /production.*built name/],
    ["routed to another host", { ...built, routes: [{ pattern: "readinglite.ai/*", zone_name: "readinglite.ai" }] }, /production.*built routes/],
    ["published on workers.dev", { ...built, workers_dev: true }, /production.*built workers_dev/],
    [
      "bound to another environment's backend",
      { ...built, services: frontendBinding("production", "reading-lite-staging").services },
      /production: BACKEND binds "reading-lite-staging", expected "reading-lite"/,
    ],
  ])("rejects a build %s", (_label, candidate, error) => {
    expect(checkBuiltConfig("production", candidate, source, backend).join("\n")).toMatch(error);
  });
});

describe("checked-in Wrangler configs", () => {
  it("bind every frontend environment to the backend of the same environment", () => {
    const backendViews = readEnvironments("../wrangler.toml");
    expect(backendViews.staging.name).toBe("reading-lite-staging");
    expect(backendViews.production.name).toBe("reading-lite");
    expect(checkBackendBindings(readEnvironments("wrangler.jsonc"), backendViews)).toEqual([]);
  });

  // Wrangler defaults workers_dev to true, so an environment that omits it
  // (including a bare deploy of the local config) would be publicly reachable
  // before any route is added deliberately.
  it.each(ENVIRONMENTS)("keep the $label frontend off workers.dev and preview URLs", ({ env }) => {
    const config = readEnvironment("wrangler.jsonc", env);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
});
