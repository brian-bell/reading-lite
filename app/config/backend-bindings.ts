// Guard for ADR 0003: each frontend environment binds only the backend Worker of
// the same environment. The test in test/backend-bindings.test.ts reads the
// checked-in app/wrangler.jsonc and root wrangler.toml through Wrangler and
// fails CI when a service binding crosses environments.

export const BACKEND_BINDING = "BACKEND";

export type EnvironmentLabel = "local" | "staging" | "production";

/** Wrangler environment names; `undefined` is the top-level (local) config. */
export const ENVIRONMENTS: ReadonlyArray<{ label: EnvironmentLabel; env: string | undefined }> = [
  { label: "local", env: undefined },
  { label: "staging", env: "staging" },
  { label: "production", env: "production" },
];

export interface WorkerConfigView {
  name: string;
  services: Array<{ binding: string; service: string }>;
}

export function checkBackendBindings(
  frontend: Record<EnvironmentLabel, WorkerConfigView>,
  backend: Record<EnvironmentLabel, WorkerConfigView>,
): string[] {
  const errors: string[] = [];
  const backendNames = new Set(ENVIRONMENTS.map(({ label }) => backend[label].name));

  for (const { label } of ENVIRONMENTS) {
    const own = backend[label].name;
    const config = frontend[label];

    if (backendNames.has(config.name)) {
      errors.push(`${label}: frontend Worker name "${config.name}" is a backend Worker's name`);
    }

    const backendBindings = config.services.filter(({ binding }) => binding === BACKEND_BINDING);
    if (backendBindings.length !== 1) {
      errors.push(`${label}: expected exactly one ${BACKEND_BINDING} service binding, found ${backendBindings.length}`);
    }

    for (const { binding, service } of config.services) {
      if (binding === BACKEND_BINDING && service !== own) {
        errors.push(`${label}: ${binding} binds "${service}", expected "${own}"`);
      } else if (binding !== BACKEND_BINDING && backendNames.has(service) && service !== own) {
        errors.push(`${label}: ${binding} binds another environment's backend "${service}"`);
      }
    }
  }

  return errors;
}
