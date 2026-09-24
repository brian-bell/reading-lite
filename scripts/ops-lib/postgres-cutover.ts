// The PostgreSQL cutover guard (ADR 0005). The storage migration lives on a
// long-lived candidate branch whose wrangler.toml binds Hyperdrive. Until an
// environment is cut over, a Worker built from that config must not deploy to
// it, so `ops deploy worker` refuses before the readiness preflight,
// migrations or upload. deploy-app.yml gates the app/ job on the
// Worker workflow succeeding, so a refusal here stops the whole release.
//
// The flag is checked in and per environment, so flipping it is a reviewable
// commit that travels with the release: #349 flips staging on the candidate
// branch for the rehearsal, #350 flips production. Staging never unlocks
// production.

import { readFileSync } from "node:fs";
import { defaultWranglerTomlPath, type DeployEnvName } from "../control-plane-env";

export const POSTGRES_CUTOVER_ENABLED: Readonly<Record<DeployEnvName, boolean>> = {
  staging: true,
  production: true,
};

// Filled in by #349 (staging) and #350 (production) with `wrangler hyperdrive
// create … --caching-disabled`.
export const PLACEHOLDER_HYPERDRIVE_IDS = new Set([
  "00000000000000000000000000000001",
  "00000000000000000000000000000002",
  "00000000000000000000000000000003",
]);

export interface WranglerHyperdriveBinding {
  env: "local" | DeployEnvName;
  binding: string;
  id: string;
}

export type PostgresCutoverCheck =
  | { ok: true; bound: boolean }
  | { ok: false; error: string };

export function parseWranglerHyperdriveBindings(toml: string): WranglerHyperdriveBinding[] {
  const bindings: WranglerHyperdriveBinding[] = [];
  let current: { env: WranglerHyperdriveBinding["env"]; fields: Record<string, string> } | null = null;
  const flush = () => {
    if (current?.fields.binding) {
      bindings.push({ env: current.env, binding: current.fields.binding, id: current.fields.id ?? "" });
    }
    current = null;
  };
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      flush();
      const header = /^\[\[(?:env\.(staging|production)\.)?hyperdrive\]\]$/.exec(line);
      if (header) current = { env: (header[1] as DeployEnvName | undefined) ?? "local", fields: {} };
      continue;
    }
    const field = /^([A-Za-z_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (current && field) current.fields[field[1]!] = field[2]!;
  }
  flush();
  return bindings;
}

export function checkPostgresCutover(
  env: DeployEnvName,
  opts: {
    execute: boolean;
    toml?: string;
    flags?: Readonly<Record<DeployEnvName, boolean>>;
  },
): PostgresCutoverCheck {
  const toml = opts.toml ?? readFileSync(defaultWranglerTomlPath(), "utf8");
  const flags = opts.flags ?? POSTGRES_CUTOVER_ENABLED;
  const bound = parseWranglerHyperdriveBindings(toml).filter((binding) => binding.env === env);
  if (bound.length === 0) return { ok: true, bound: false };
  if (!flags[env]) {
    return {
      ok: false,
      error:
        `wrangler.toml binds PostgreSQL (Hyperdrive) for ${env}, but POSTGRES_CUTOVER_ENABLED.${env} is false. ` +
        "This commit is the storage-migration candidate and must not deploy here before the cutover. See docs/decisions/0005-postgresql-storage.md.",
    };
  }
  // Second line of defence; plan mode tolerates it like the placeholder D1 id.
  const placeholder = bound.find((binding) => PLACEHOLDER_HYPERDRIVE_IDS.has(binding.id.trim().toLowerCase()) || binding.id === "");
  if (placeholder && opts.execute) {
    return {
      ok: false,
      error: `Hyperdrive binding ${placeholder.binding} for ${env} still has a placeholder id. Create the config with caching disabled and set its id in wrangler.toml.`,
    };
  }
  return { ok: true, bound: true };
}
