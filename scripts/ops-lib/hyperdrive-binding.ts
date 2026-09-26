// The Hyperdrive binding check `ops deploy worker` runs before anything
// remote (ADR 0005). The Worker reaches PostgreSQL only through its HYPERDRIVE
// binding, so an execute that would upload a placeholder config id is refused:
// the Worker would deploy with no database behind it. Plan mode tolerates the
// placeholder so a checkout can still dry-run.

import { readFileSync } from "node:fs";
import { defaultWranglerTomlPath, type DeployEnvName } from "../control-plane-env";

// The ids a checkout carries before `wrangler hyperdrive create …
// --caching-disabled` has filled one in; the local binding uses the first.
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

export type HyperdriveBindingCheck =
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

export function checkHyperdriveBinding(
  env: DeployEnvName,
  opts: { execute: boolean; toml?: string },
): HyperdriveBindingCheck {
  const toml = opts.toml ?? readFileSync(defaultWranglerTomlPath(), "utf8");
  const bound = parseWranglerHyperdriveBindings(toml).filter((binding) => binding.env === env);
  if (bound.length === 0) return { ok: true, bound: false };
  const placeholder = bound.find((binding) => PLACEHOLDER_HYPERDRIVE_IDS.has(binding.id.trim().toLowerCase()) || binding.id === "");
  if (placeholder && opts.execute) {
    return {
      ok: false,
      error: `Hyperdrive binding ${placeholder.binding} for ${env} still has a placeholder id. Create the config with caching disabled and set its id in wrangler.toml.`,
    };
  }
  return { ok: true, bound: true };
}
