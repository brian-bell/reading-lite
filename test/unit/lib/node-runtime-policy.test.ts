import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_NODE_GATE_MESSAGE,
  DEV_NODE_MINIMUM,
  evaluateDevNode,
  isDevNodeSupported,
  isNodeAtLeast,
} from "../../../scripts/require-dev-node";

const repoRoot = process.cwd();

function readPkg(): { engines: { node: string }; scripts: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

describe("Node runtime policy (ops floor vs local dev)", () => {
  it("keeps engines.node as the ops/install floor, not a Node 22-only requirement", () => {
    const pkg = readPkg();
    expect(pkg.engines.node).toBe(">=20.19.0");
    expect(pkg.engines.node).not.toMatch(/^>=22/);
  });

  it("leaves scripts.dev on wrangler dev and does not launch wrangler-dist", () => {
    const pkg = readPkg();
    expect(pkg.scripts.dev).toContain("wrangler dev");
    expect(pkg.scripts.dev).not.toMatch(/wrangler-dist/);
    expect(pkg.scripts.predev).toBe("tsx scripts/require-dev-node.ts");
    expect(pkg.scripts["types:generate"]).toMatch(/^wrangler /);
    expect(pkg.scripts["types:generate"]).not.toMatch(/wrangler-dist/);
    expect(pkg.scripts["types:check"]).toContain("types:generate");
  });

  it("keeps scripts.ops on tsx scripts/ops.ts and spawners on wrangler-cli", () => {
    const pkg = readPkg();
    expect(pkg.scripts.ops).toBe("tsx scripts/ops.ts");

    const spawners = [
      "scripts/corpus-lib/wrangler-r2.ts",
      "scripts/corpus-lib/wrangler-put.ts",
      "scripts/check-corpus-lib/fetch-index.ts",
      "scripts/ops-lib/commands/deploy-worker.ts",
      "scripts/ops-lib/commands/deploy-web.ts",
      "scripts/staging-env.ts",
      "scripts/lib/founder-bootstrap.ts",
      "scripts/dev-setup.ts",
    ];
    for (const file of spawners) {
      const src = readFileSync(path.join(repoRoot, file), "utf8");
      expect(src, file).toMatch(/wrangler-cli["']/);
      expect(src, file).not.toMatch(/spawn\(\s*["']wrangler["']/);
    }
  });

  it("fails the dev Node gate below 22.12 and fail-closes on unparseable versions", () => {
    expect(DEV_NODE_MINIMUM).toBe("22.12.0");
    expect(isDevNodeSupported("22.12.0")).toBe(true);
    expect(isDevNodeSupported("22.12.1")).toBe(true);
    expect(isDevNodeSupported("22.13.0")).toBe(true);
    expect(isDevNodeSupported("23.0.0")).toBe(true);
    expect(evaluateDevNode("22.12.0")).toEqual({ ok: true });
    expect(isDevNodeSupported("22.12.0")).toBe(isNodeAtLeast("22.12.0", DEV_NODE_MINIMUM));

    for (const version of ["20.19.2", "20.19.0", "21.0.0", "22.0.0", "22.11.9"]) {
      expect(evaluateDevNode(version), version).toEqual({
        ok: false,
        message: DEV_NODE_GATE_MESSAGE,
      });
    }

    for (const version of ["", "22", "22.12", "not-a-version", "v22.12.0"]) {
      expect(isDevNodeSupported(version), version).toBe(false);
      expect(evaluateDevNode(version), version).toEqual({
        ok: false,
        message: DEV_NODE_GATE_MESSAGE,
      });
    }

    expect(DEV_NODE_GATE_MESSAGE).toMatch(/Node 22\.12\+/);
    expect(DEV_NODE_GATE_MESSAGE).toMatch(/npm run dev/);
    expect(DEV_NODE_GATE_MESSAGE).toMatch(/npm run ops/);
  });

  it("compares major, minor, and patch against parsed DEV_NODE_MINIMUM", () => {
    expect(isNodeAtLeast("22.12.0", DEV_NODE_MINIMUM)).toBe(true);
    expect(isNodeAtLeast("22.12.1", DEV_NODE_MINIMUM)).toBe(true);
    expect(isNodeAtLeast("22.12.0", "22.12.1")).toBe(false);
    expect(isNodeAtLeast("22.11.99", DEV_NODE_MINIMUM)).toBe(false);
    expect(isNodeAtLeast("22.12.0", "not-a-version")).toBe(false);

    const src = readFileSync(path.join(repoRoot, "scripts/require-dev-node.ts"), "utf8");
    expect(src).toMatch(/isNodeAtLeast\(\s*version,\s*DEV_NODE_MINIMUM\s*\)/);
    expect(src).not.toMatch(/major\s*[<>]=?\s*22/);
    expect(src).not.toMatch(/minor\s*[<>]=?\s*12/);
  });

  it("keeps the Node policy table identical in README, AGENTS.md, and operations.md", () => {
    const table = [
      "| Path | Supported Node | How Wrangler is launched |",
      "| --- | --- | --- |",
      "| `npm run ops` | Node **20.19.x** (Debian); also runs on Node 22 | `scripts/lib/wrangler-cli.ts` → `wrangler-dist/cli.js` |",
      "| `npm run dev` (and types:generate / types:check) | Node **22.12+** | npm bin wrapper `bin/wrangler.js` |",
      "| CI | Worker + SPA: Node **22**; ops compatibility: **20.19.2** | Worker tests stay on workerd |",
    ].join("\n");
    for (const file of ["README.md", "AGENTS.md", "docs/operations.md"]) {
      expect(readFileSync(path.join(repoRoot, file), "utf8"), file).toContain(table);
    }
  });
});
