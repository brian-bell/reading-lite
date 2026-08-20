import { readFileSync } from "node:fs";
import path from "node:path";

export type DeployEnvName = "staging" | "production";

export const PLACEHOLDER_D1_DATABASE_IDS = new Set([
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000003",
]);

export const CONTROL_PLANE_RUNTIME_SECRETS = ["AUTH_ROOT_SECRET"] as const;
export const CONTROL_PLANE_BOOTSTRAP_SECRETS = ["READER_API_TOKEN"] as const;

export interface WranglerD1Binding {
  env: "local" | DeployEnvName;
  binding: string;
  databaseName: string;
  databaseId: string;
}

export interface ControlPlaneRequiredSecrets {
  runtime: readonly string[];
  bootstrapOnly: readonly string[];
}

export type ControlPlaneDeployReadiness =
  | {
      ok: true;
      env: DeployEnvName;
      d1: { binding: string; databaseName: string; databaseId: string };
      requiredSecrets: ControlPlaneRequiredSecrets;
    }
  | {
      ok: false;
      env: DeployEnvName;
      error: string;
      requiredSecrets: ControlPlaneRequiredSecrets;
    };

const DEPLOY_ENVS: readonly DeployEnvName[] = ["staging", "production"];

const requiredSecrets: ControlPlaneRequiredSecrets = {
  runtime: [...CONTROL_PLANE_RUNTIME_SECRETS],
  bootstrapOnly: [...CONTROL_PLANE_BOOTSTRAP_SECRETS],
};

export function isPlaceholderD1DatabaseId(id: string): boolean {
  return PLACEHOLDER_D1_DATABASE_IDS.has(id.trim().toLowerCase());
}

export function defaultWranglerTomlPath(): string {
  return path.join(process.cwd(), "wrangler.toml");
}

export function parseWranglerD1Bindings(toml: string): WranglerD1Binding[] {
  const bindings: WranglerD1Binding[] = [];
  let current: { env: WranglerD1Binding["env"]; fields: Record<string, string> } | null = null;

  const flush = () => {
    if (!current) return;
    const binding = current.fields.binding;
    const databaseName = current.fields.database_name;
    const databaseId = current.fields.database_id;
    if (binding && databaseName && databaseId) {
      bindings.push({
        env: current.env,
        binding,
        databaseName,
        databaseId,
      });
    }
    current = null;
  };

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      flush();
      const match = /^\[\[(?:env\.(staging|production)\.)?d1_databases\]\]$/.exec(line);
      if (match) {
        current = {
          env: (match[1] as DeployEnvName | undefined) ?? "local",
          fields: {},
        };
      }
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (kv) current.fields[kv[1]!] = kv[2]!;
  }
  flush();
  return bindings;
}

export function validateWranglerD1Bindings(wranglerTomlPath: string): void {
  const bindings = parseWranglerD1Bindings(readFileSync(wranglerTomlPath, "utf8"));
  for (const env of DEPLOY_ENVS) {
    const d1 = bindings.find((row) => row.env === env && row.binding === "CONTROL_PLANE");
    if (!d1) {
      throw new Error(`wrangler.toml is missing a CONTROL_PLANE D1 binding for env.${env}`);
    }
    if (isPlaceholderD1DatabaseId(d1.databaseId)) {
      throw new Error(
        `wrangler.toml env.${env} CONTROL_PLANE database_id ${d1.databaseId} is a placeholder; ` +
          `replace it after \`wrangler d1 create ${d1.databaseName}\``,
      );
    }
  }
}

export function validateControlPlaneDeployReadiness(
  env: DeployEnvName,
  opts: { wranglerTomlPath?: string } = {},
): ControlPlaneDeployReadiness {
  const wranglerTomlPath = opts.wranglerTomlPath ?? defaultWranglerTomlPath();
  const bindings = parseWranglerD1Bindings(readFileSync(wranglerTomlPath, "utf8"));
  const d1 = bindings.find((row) => row.env === env && row.binding === "CONTROL_PLANE");
  if (!d1) {
    return {
      ok: false,
      env,
      error: `wrangler.toml is missing a CONTROL_PLANE D1 binding for env.${env}`,
      requiredSecrets,
    };
  }
  if (isPlaceholderD1DatabaseId(d1.databaseId)) {
    return {
      ok: false,
      env,
      error:
        `CONTROL_PLANE database_id ${d1.databaseId} is a placeholder; ` +
        `replace it after \`wrangler d1 create ${d1.databaseName}\``,
      requiredSecrets,
    };
  }
  return {
    ok: true,
    env,
    d1: {
      binding: d1.binding,
      databaseName: d1.databaseName,
      databaseId: d1.databaseId,
    },
    requiredSecrets,
  };
}
