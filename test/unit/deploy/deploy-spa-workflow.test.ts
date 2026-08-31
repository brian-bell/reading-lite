import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on?: {
    workflow_run?: {
      workflows?: string[];
      types?: string[];
      branches?: string[];
    };
  };
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, { if?: string; steps?: Step[] }>;
}

async function readWorkflow(path: string): Promise<Workflow> {
  return parse(await readFile(path, "utf8")) as Workflow;
}

function steps(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function commands(workflow: Workflow): string {
  return steps(workflow)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string")
    .join("\n");
}

describe("coordinated production deployment workflows", () => {
  it("deploys the successful CI commit to the Worker and records its SHA", async () => {
    const workflow = await readWorkflow(".github/workflows/deploy-worker.yml");
    const checkout = steps(workflow).find((step) => step.uses === "actions/checkout@v7");
    const upload = steps(workflow).find((step) => step.uses === "actions/upload-artifact@v6");

    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["CI"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(workflow.jobs?.deploy?.if).toContain("conclusion == 'success'");
    expect(checkout?.with?.ref).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(commands(workflow)).toContain("npm run ops -- deploy worker --env production --execute");
    expect(commands(workflow)).toContain(
      "git fetch --no-tags origin main:refs/remotes/origin/main",
    );
    expect(commands(workflow)).toContain("git rev-parse origin/main");
    expect(upload?.with?.name).toBe("production-worker-release-sha");
  });

  it("deploys only the exact SHA recorded by a successful Worker release", async () => {
    const workflow = await readWorkflow(".github/workflows/deploy-spa.yml");
    const allSteps = steps(workflow);
    const download = allSteps.find((step) => step.uses === "actions/download-artifact@v7");
    const checkout = allSteps.find((step) => step.uses === "actions/checkout@v7");
    const allCommands = commands(workflow);

    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["Deploy production worker"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow.concurrency).toEqual({
      group: "deploy-production-spa",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs?.deploy?.if).toContain("conclusion == 'success'");
    expect(download?.with?.["run-id"]).toBe("${{ github.event.workflow_run.id }}");
    expect(checkout?.with?.ref).toBe("${{ steps.release.outputs.sha }}");
    expect(allCommands).toContain("git fetch --no-tags origin main:refs/remotes/origin/main");
    expect(allCommands).toContain("git rev-parse origin/main");
    expect(allCommands).toContain("npm ci");
    expect(allCommands).toContain("npm run ops -- deploy web --branch main --execute");
    expect(allCommands).not.toMatch(/deploy worker|wrangler deploy/);
  });
});
