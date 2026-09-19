import path from "node:path";

export type DeployEnvName = "staging" | "production";

export const CONTROL_PLANE_RUNTIME_SECRETS = ["AUTH_ROOT_SECRET"] as const;
export const CONTROL_PLANE_BOOTSTRAP_SECRETS = ["READER_API_TOKEN"] as const;

export interface ControlPlaneRequiredSecrets {
  runtime: readonly string[];
  bootstrapOnly: readonly string[];
}

// The control plane is on PostgreSQL (ADR 0005), reached through the
// Hyperdrive binding, so there is no longer a D1 database id to validate here.
// What a deploy still has to get right is the secret set: what the runtime
// needs on every request, and what only founder bootstrap ever reads.
export const CONTROL_PLANE_REQUIRED_SECRETS: ControlPlaneRequiredSecrets = {
  runtime: [...CONTROL_PLANE_RUNTIME_SECRETS],
  bootstrapOnly: [...CONTROL_PLANE_BOOTSTRAP_SECRETS],
};

export function defaultWranglerTomlPath(): string {
  return path.join(process.cwd(), "wrangler.toml");
}
