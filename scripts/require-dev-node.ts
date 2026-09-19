#!/usr/bin/env tsx
// Gate `npm run dev` to Node 22.12+. Install and `npm run ops` use
// `engines.node` (>=22.0.0).
import { pathToFileURL } from "node:url";

export const DEV_NODE_MINIMUM = "22.12.0";

function parseNodeTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `22.12.0` → `22.12`; non-zero patch keeps the triple. */
export function formatDevNodeFloor(minimum: string): string {
  const parsed = parseNodeTriple(minimum);
  if (!parsed) return minimum;
  const [major, minor, patch] = parsed;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

export const DEV_NODE_GATE_MESSAGE =
  `Use Node ${formatDevNodeFloor(DEV_NODE_MINIMUM)}+ for \`npm run dev\`.`;

/** Fail-closed: unparseable `version` or `minimum` is not supported. */
export function isNodeAtLeast(version: string, minimum: string): boolean {
  const parsed = parseNodeTriple(version);
  const floor = parseNodeTriple(minimum);
  if (!parsed || !floor) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== floor[i]) return parsed[i]! > floor[i]!;
  }
  return true;
}

export function isDevNodeSupported(version: string): boolean {
  return isNodeAtLeast(version, DEV_NODE_MINIMUM);
}

export function evaluateDevNode(version: string): { ok: true } | { ok: false; message: string } {
  if (isDevNodeSupported(version)) return { ok: true };
  return { ok: false, message: DEV_NODE_GATE_MESSAGE };
}

export function assertDevNode(version = process.versions.node): void {
  const result = evaluateDevNode(version);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assertDevNode();
}
