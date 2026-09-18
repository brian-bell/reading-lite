// Guard for ADR 0003: each frontend environment binds only the backend Worker of
// the same environment, through its read-only FrontendReads entrypoint
// (src/frontend-reads.ts at the repo root), never its default HTTP handler. The
// test in test/backend-bindings.test.ts reads the checked-in app/wrangler.jsonc
// and root wrangler.toml through Wrangler and fails CI when a service binding
// crosses environments. scripts/check-build.ts applies the same guard to the
// built dist/server/wrangler.json, which is what `wrangler deploy` uploads, and
// the deploy workflows run it between build and deploy.

import { unstable_readConfig } from "wrangler";

export const BACKEND_BINDING = "BACKEND";
export const BACKEND_ENTRYPOINT = "FrontendReads";

export type EnvironmentLabel = "local" | "staging" | "production";

/** Wrangler environment names; `undefined` is the top-level (local) config. */
export const ENVIRONMENTS: ReadonlyArray<{ label: EnvironmentLabel; env: string | undefined }> = [
  { label: "local", env: undefined },
  { label: "staging", env: "staging" },
  { label: "production", env: "production" },
];

export interface WorkerConfigView {
  name: string;
  services: Array<{ binding: string; service: string; entrypoint?: string }>;
}

type Route = { pattern: string; zone_name?: string; zone_id?: string; custom_domain?: boolean };

/** The fields of one environment that decide where and against what it deploys. */
export interface DeployedConfigView extends WorkerConfigView {
  routes: Route[];
  workers_dev?: boolean;
  preview_urls?: boolean;
}

/** A built dist/server/wrangler.json, which also records its environment. */
export interface BuiltConfigView extends DeployedConfigView {
  targetEnvironment?: string;
}

// Wrangler's published Config type references a package it doesn't ship, so
// narrow the fields read here explicitly.
type RawConfig = {
  name?: string;
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
  routes?: Array<string | Route>;
  workers_dev?: boolean;
  preview_urls?: boolean;
  targetEnvironment?: string;
};

function view(raw: RawConfig): BuiltConfigView {
  return {
    name: raw.name ?? "",
    services: (raw.services ?? []).map(({ binding, service, entrypoint }) => ({
      binding,
      service,
      ...(entrypoint === undefined ? {} : { entrypoint }),
    })),
    routes: (raw.routes ?? []).map((route) =>
      typeof route === "string"
        ? { pattern: route }
        : {
            pattern: route.pattern,
            ...(route.zone_name === undefined ? {} : { zone_name: route.zone_name }),
            ...(route.zone_id === undefined ? {} : { zone_id: route.zone_id }),
            ...(route.custom_domain === undefined ? {} : { custom_domain: route.custom_domain }),
          },
    ),
    workers_dev: raw.workers_dev,
    preview_urls: raw.preview_urls,
    ...(raw.targetEnvironment === undefined ? {} : { targetEnvironment: raw.targetEnvironment }),
  };
}

/** Reads one environment of a checked-in Wrangler config. */
export function readEnvironment(configPath: string, env: string | undefined): DeployedConfigView {
  return view(unstable_readConfig({ config: configPath, env }, { hideWarnings: true }) as RawConfig);
}

/** Reads every environment of a checked-in Wrangler config. */
export function readEnvironments(configPath: string): Record<EnvironmentLabel, DeployedConfigView> {
  const views = {} as Record<EnvironmentLabel, DeployedConfigView>;
  for (const { label, env } of ENVIRONMENTS) views[label] = readEnvironment(configPath, env);
  return views;
}

/** Parses a built dist/server/wrangler.json. */
export function parseBuiltConfig(json: string): BuiltConfigView {
  return view(JSON.parse(json) as RawConfig);
}

function checkEnvironment(
  label: EnvironmentLabel,
  config: WorkerConfigView,
  backend: Record<EnvironmentLabel, WorkerConfigView>,
): string[] {
  const errors: string[] = [];
  const backendNames = new Set(ENVIRONMENTS.map((environment) => backend[environment.label].name));
  const own = backend[label].name;

  if (backendNames.has(config.name)) {
    errors.push(`${label}: frontend Worker name "${config.name}" is a backend Worker's name`);
  }

  const backendBindings = config.services.filter(({ binding }) => binding === BACKEND_BINDING);
  if (backendBindings.length !== 1) {
    errors.push(`${label}: expected exactly one ${BACKEND_BINDING} service binding, found ${backendBindings.length}`);
  }

  for (const { binding, service, entrypoint } of config.services) {
    if (binding === BACKEND_BINDING) {
      if (service !== own) {
        errors.push(`${label}: ${binding} binds "${service}", expected "${own}"`);
      }
      if (entrypoint !== BACKEND_ENTRYPOINT) {
        errors.push(`${label}: ${binding} entrypoint is "${entrypoint ?? "default"}", expected "${BACKEND_ENTRYPOINT}"`);
      }
    } else if (backendNames.has(service) && service !== own) {
      errors.push(`${label}: ${binding} binds another environment's backend "${service}"`);
    }
  }

  return errors;
}

export function checkBackendBindings(
  frontend: Record<EnvironmentLabel, WorkerConfigView>,
  backend: Record<EnvironmentLabel, WorkerConfigView>,
): string[] {
  return ENVIRONMENTS.flatMap(({ label }) => checkEnvironment(label, frontend[label], backend));
}

const DEPLOYED_FIELDS = ["name", "routes", "services", "workers_dev", "preview_urls"] as const;

/**
 * Checks a built config against the checked-in environment it was meant to
 * build: the same environment, the same deployed fields, and a backend binding
 * that passes the same guard as the source.
 */
export function checkBuiltConfig(
  label: EnvironmentLabel,
  built: BuiltConfigView,
  source: DeployedConfigView,
  backend: Record<EnvironmentLabel, WorkerConfigView>,
): string[] {
  const errors: string[] = [];
  const env = ENVIRONMENTS.find((environment) => environment.label === label)?.env;

  if (built.targetEnvironment !== env) {
    errors.push(`${label}: build targets environment "${built.targetEnvironment ?? "top level"}", expected "${env ?? "top level"}"`);
  }
  for (const field of DEPLOYED_FIELDS) {
    const got = JSON.stringify(built[field]);
    const want = JSON.stringify(source[field]);
    if (got !== want) errors.push(`${label}: built ${field} is ${got}, expected ${want} from wrangler.jsonc`);
  }

  return [...errors, ...checkEnvironment(label, built, backend)];
}
