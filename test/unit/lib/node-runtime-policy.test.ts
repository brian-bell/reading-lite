import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_NODE_GATE_MESSAGE,
  DEV_NODE_MINIMUM,
  evaluateDevNode,
  formatDevNodeFloor,
  isDevNodeSupported,
  isNodeAtLeast,
} from "../../../scripts/require-dev-node";

const repoRoot = process.cwd();

function readPkg(): { engines: { node: string }; scripts: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

describe("Node runtime policy (ops floor vs local dev)", () => {
  it("keeps engines.node as the Node 22 install and ops floor", () => {
    const pkg = readPkg();
    expect(pkg.engines.node).toBe(">=22.0.0");
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

  it("keeps scripts.ops on tsx scripts/ops.ts", () => {
    // Spawner coverage (every ops wrangler spawner imports wrangler-cli) lives
    // in lib/wrangler-cli.test.ts.
    const pkg = readPkg();
    expect(pkg.scripts.ops).toBe("tsx scripts/ops.ts");
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
  });

  it("compares major, minor, and patch against parsed DEV_NODE_MINIMUM", () => {
    expect(isNodeAtLeast("22.12.0", DEV_NODE_MINIMUM)).toBe(true);
    expect(isNodeAtLeast("22.12.1", DEV_NODE_MINIMUM)).toBe(true);
    expect(isNodeAtLeast("22.12.0", "22.12.1")).toBe(false);
    expect(isNodeAtLeast("22.11.99", DEV_NODE_MINIMUM)).toBe(false);
    expect(isNodeAtLeast("22.12.0", "not-a-version")).toBe(false);
  });

  it("derives the gate message floor from DEV_NODE_MINIMUM", () => {
    expect(formatDevNodeFloor("22.12.0")).toBe("22.12");
    expect(formatDevNodeFloor("23.0.0")).toBe("23.0");
    expect(formatDevNodeFloor("22.12.1")).toBe("22.12.1");
    expect(formatDevNodeFloor("not-a-version")).toBe("not-a-version");
  });

  it("does not use a Node 20 npm engine override", () => {
    for (const file of [".github/workflows/ci.yml", "README.md", "docs/operations.md"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      expect(text, file).not.toContain("npm ci --engine-strict=false");
      expect(text, file).not.toContain("--ignore-engines");
    }
  });

  it("runs the Ops CLI CI job on Node 22", () => {
    const text = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(text).toContain("  ops:\n    name: Ops CLI");
    expect(text).not.toContain("ops-node20");
    expect(text).not.toContain("20.19.2");
    expect(text).not.toMatch(/node-version:\s*"20/);
  });

  it("keeps the Node policy table identical in README, AGENTS.md, and operations.md", () => {
    const table = [
      "| Path | Supported Node | How Wrangler is launched |",
      "| --- | --- | --- |",
      "| `npm run ops` | Node **22** | `scripts/lib/wrangler-cli.ts` → `wrangler-dist/cli.js` |",
      "| `npm run dev` (and types:generate / types:check) | Node **22.12+** | npm bin wrapper `bin/wrangler.js` |",
      "| CI | Worker, SPA, app, and ops: Node **22** | Worker tests stay on workerd |",
    ].join("\n");
    for (const file of ["README.md", "AGENTS.md", "docs/operations.md"]) {
      expect(readFileSync(path.join(repoRoot, file), "utf8"), file).toContain(table);
    }
  });
});
