// The production Worker workflow's contract with `ops deploy worker`
// (reading-lite-gh347.4.4). The command's own ordering and fail-closed
// behaviour belong to deploy-worker-migrations.test.ts; what only the workflow
// can get wrong is passing a connection string it never required, or deploying
// before the stale-commit and wipe checks.

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

const workflow = async () =>
  parse(await readFile(".github/workflows/deploy-worker.yml", "utf8")) as {
    concurrency?: { group?: string };
    jobs?: Record<string, { steps?: Step[] }>;
  };

const steps = async () => (await workflow()).jobs?.deploy?.steps ?? [];

describe("deploy-worker.yml", () => {
  it("fails early with a named error when the connection-string secret is missing", async () => {
    const require = (await steps()).find((step) => step.name === "Require deploy secrets");
    expect(require?.env?.PRODUCTION_DATABASE_URL).toBe("${{ secrets.PRODUCTION_DATABASE_URL }}");
    expect(require?.run).toContain('missing secret PRODUCTION_DATABASE_URL');
  });

  it("deploys with that secret named, after the stale-commit and wipe checks", async () => {
    const deploy = (await steps()).find((step) => step.name === "Deploy production worker");
    expect(deploy?.env?.PRODUCTION_DATABASE_URL).toBe("${{ secrets.PRODUCTION_DATABASE_URL }}");
    const run = deploy?.run ?? "";
    expect(run).toContain("deploy worker --env production --execute --database-url-env PRODUCTION_DATABASE_URL");
    expect(run.indexOf("refusing stale Worker release")).toBeLessThan(run.indexOf("deploy wipe-check"));
    expect(run.indexOf("deploy wipe-check")).toBeLessThan(run.indexOf("deploy worker"));
  });

  it("holds the shared release lock", async () => {
    expect((await workflow()).concurrency?.group).toBe("deploy-production-release");
  });
});
