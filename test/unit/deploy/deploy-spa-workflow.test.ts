import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Workflow {
  on?: {
    push?: { branches?: string[] };
    workflow_dispatch?: unknown;
  };
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, { if?: string; steps?: Array<Record<string, unknown>> }>;
}

describe("production SPA deployment workflow", () => {
  it("builds and serially deploys only the SPA after pushes to main", async () => {
    const source = await readFile(".github/workflows/deploy-spa.yml", "utf8");
    const workflow = parse(source) as Workflow;
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const commands = steps
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string")
      .join("\n");

    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "deploy-production-spa",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs?.deploy?.if).toBe("github.ref == 'refs/heads/main'");
    expect(commands).toContain("npm ci");
    expect(commands).toContain("npm run ops -- deploy web --branch main --execute");
    expect(commands).not.toMatch(/deploy worker|wrangler deploy/);
  });
});
