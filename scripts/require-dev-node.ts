#!/usr/bin/env tsx
// Gate `npm run dev` to Node 22.12+. Node 20.19.x remains the ops/install
// floor (`engines.node`) and launches Wrangler via wrangler-dist/cli.js.
import { pathToFileURL } from "node:url";

export const DEV_NODE_MINIMUM = "22.12.0";

export const DEV_NODE_GATE_MESSAGE =
  "Use Node 22.12+ for `npm run dev`. Node 20.19.x is for `npm run ops` only.";

function parseNodeTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isDevNodeSupported(version: string): boolean {
  const parsed = parseNodeTriple(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  if (major > 22) return true;
  if (major < 22) return false;
  return minor >= 12;
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
