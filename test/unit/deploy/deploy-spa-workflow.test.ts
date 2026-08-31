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

const productionReleaseLock = {
  group: "deploy-production-release",
  "cancel-in-progress": false,
};

function expectBoundaryCheck(run: string | undefined, deployCommand: string): void {
  expect(run).toBeTypeOf("string");
  const script = run ?? "";
  const fetchAt = script.indexOf("git fetch --no-tags origin main:refs/remotes/origin/main");
  const compareAt = script.indexOf("git rev-parse origin/main");
  const deployAt = script.indexOf(deployCommand);
  expect(fetchAt).toBeGreaterThanOrEqual(0);
  expect(compareAt).toBeGreaterThan(fetchAt);
  expect(deployAt).toBeGreaterThan(compareAt);
}

describe("coordinated production deployment workflows", () => {
  it("deploys the successful CI commit to the Worker and records its SHA", async () => {
    const workflow = await readWorkflow(".github/workflows/deploy-worker.yml");
    const checkout = steps(workflow).find((step) => step.uses === "actions/checkout@v7");
    const upload = steps(workflow).find((step) => step.uses === "actions/upload-artifact@v6");
    const deploy = steps(workflow).find((step) =>
      step.run?.includes("npm run ops -- deploy worker --env production --execute"),
    );

    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["CI"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(workflow.jobs?.deploy?.if).toContain("conclusion == 'success'");
    expect(workflow.concurrency).toEqual(productionReleaseLock);
    expect(checkout?.with?.ref).toBe("${{ github.event.workflow_run.head_sha }}");
    expectBoundaryCheck(
      deploy?.run,
      "npm run ops -- deploy worker --env production --execute",
    );
    expect(upload?.with?.name).toBe("production-worker-release-sha");
  });

  it("deploys only the exact SHA recorded by a successful Worker release", async () => {
    const workflow = await readWorkflow(".github/workflows/deploy-spa.yml");
    const allSteps = steps(workflow);
    const download = allSteps.find((step) => step.uses === "actions/download-artifact@v7");
    const checkout = allSteps.find((step) => step.uses === "actions/checkout@v7");
    const deploy = allSteps.find((step) =>
      step.run?.includes("npm run ops -- deploy web --branch main --execute"),
    );
    const allCommands = commands(workflow);

    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["Deploy production worker"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow.concurrency).toEqual(productionReleaseLock);
    expect(workflow.jobs?.deploy?.if).toContain("conclusion == 'success'");
    expect(download?.with?.["run-id"]).toBe("${{ github.event.workflow_run.id }}");
    expect(checkout?.with?.ref).toBe("${{ steps.release.outputs.sha }}");
    expect(allCommands).toContain("npm ci");
    expectBoundaryCheck(deploy?.run, "npm run ops -- deploy web --branch main --execute");
    expect(allCommands).not.toMatch(/deploy worker|wrangler deploy/);
  });
});
