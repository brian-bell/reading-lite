import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
  "working-directory"?: string;
}

interface Job {
  if?: string;
  needs?: string | string[];
  steps?: Step[];
}

interface Workflow {
  on?: {
    workflow_dispatch?: unknown;
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
  jobs?: Record<string, Job>;
}

async function readWorkflow(path: string): Promise<Workflow> {
  return parse(await readFile(path, "utf8")) as Workflow;
}

function steps(workflow: Workflow | Job): Step[] {
  if ("steps" in workflow) return (workflow as Job).steps ?? [];
  return Object.values((workflow as Workflow).jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function commands(workflow: Workflow | Job): string {
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
    const gateAt = deploy!.run!.indexOf('npm run ops -- deploy wipe-check --release-sha "$RELEASE_SHA"');
    expect(gateAt).toBeGreaterThan(deploy!.run!.indexOf("git rev-parse origin/main"));
    expect(gateAt).toBeLessThan(deploy!.run!.indexOf("npm run ops -- deploy worker --env production --execute"));
    expect(deploy?.env?.DEPLOY_WIPE_OVERRIDE_SHA).toBe("${{ vars.DEPLOY_WIPE_OVERRIDE_SHA }}");
    expect(deploy?.env?.RELEASE_SHA).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(deploy?.["continue-on-error"]).not.toBe(true);
    expect(upload?.with?.name).toBe("production-worker-release-sha");
  });

  it("deploys only the exact SHA recorded by a successful Worker release", async () => {
    const workflow = await readWorkflow(".github/workflows/deploy-spa.yml");
    const spa = workflow.jobs?.deploy ?? {};
    const allSteps = steps(spa);
    const download = allSteps.find((step) => step.uses === "actions/download-artifact@v7");
    const checkout = allSteps.find((step) => step.uses === "actions/checkout@v7");
    const deploy = allSteps.find((step) =>
      step.run?.includes("npm run ops -- deploy web --branch main --execute"),
    );
    const allCommands = commands(spa);

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

  it("deploys the frontend Worker to every production host from the same released SHA", async () => {
    // ADR 0003 (amended 2026-09-13; apex cutover reading-lite-gh340.4). A job in the SPA run, not its own
    // workflow: the release group keeps one pending run, so a second workflow
    // queued behind the Worker release could cancel the SPA release.
    const workflow = await readWorkflow(".github/workflows/deploy-spa.yml");
    const app = workflow.jobs?.app ?? {};
    const appSteps = steps(app);
    const download = appSteps.find((step) => step.uses === "actions/download-artifact@v7");
    const checkout = appSteps.find((step) => step.uses === "actions/checkout@v7");
    const build = appSteps.find((step) => step.env?.CLOUDFLARE_ENV !== undefined);
    const deploy = appSteps.find((step) => step.run?.includes("npx wrangler deploy"));
    const smoke = appSteps.find((step) => step.run?.includes("app/scripts/smoke-host.sh"));

    expect(app.if).toContain("conclusion == 'success'");
    expect(app.if).toContain("head_branch == 'main'");
    // Independent of the SPA job, so a frontend failure never blocks the SPA.
    expect(app.needs).toBeUndefined();
    expect(download?.with?.name).toBe("production-worker-release-sha");
    expect(download?.with?.["run-id"]).toBe("${{ github.event.workflow_run.id }}");
    expect(checkout?.with?.ref).toBe("${{ steps.release.outputs.sha }}");
    expect(build?.env?.CLOUDFLARE_ENV).toBe("production");
    expect(build?.["working-directory"]).toBe("app");
    expect(build?.run).toContain("node scripts/check-build.ts production");
    expect(deploy?.["working-directory"]).toBe("app");
    expectBoundaryCheck(deploy?.run, "npx wrangler deploy");
    expect(appSteps.indexOf(smoke!)).toBeGreaterThan(appSteps.indexOf(deploy!));
    for (const host of ["https://next.readinglite.ai", "https://readinglite.ai", "https://readinglite.app"]) {
      expect(smoke?.run).toContain(`app/scripts/smoke-host.sh ${host}`);
    }
    expect(commands(app)).not.toMatch(/deploy worker|deploy web|--env/);
  });
});

describe("staging frontend deployment workflow", () => {
  it("deploys only the staging frontend, by manual dispatch, outside the production lock", async () => {
    const workflow = await readWorkflow(".github/workflows/deploy-app-staging.yml");
    const allSteps = steps(workflow);
    const build = allSteps.find((step) => step.env?.CLOUDFLARE_ENV !== undefined);
    const deploy = allSteps.find((step) => step.run?.includes("npx wrangler deploy"));
    const smoke = allSteps.find((step) => step.run?.includes("app/scripts/smoke-host.sh"));

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.concurrency?.group).not.toBe(productionReleaseLock.group);
    expect(build?.env?.CLOUDFLARE_ENV).toBe("staging");
    expect(build?.run).toContain("node scripts/check-build.ts staging");
    expect(deploy?.["working-directory"]).toBe("app");
    expect(smoke?.run).toContain("https://next-staging.readinglite.ai");
    expect(commands(workflow)).not.toMatch(/production|deploy worker|deploy web/);
  });
});
