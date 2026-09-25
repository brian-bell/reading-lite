import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CI_JOBS, selectJobs, type CiJob } from "../../../scripts/ci-lib/changed-jobs";

function only(...jobs: CiJob[]) {
  return Object.fromEntries(CI_JOBS.map((job) => [job, jobs.includes(job)]));
}

describe("CI job selection for pull requests", () => {
  it.each<[string, string[], Record<string, boolean>]>([
    ["documentation only", ["docs/architecture.md", "docs/operations.md", "README.md", "AGENTS.md", "CONTEXT.md", "app/README.md", ".agents/skills/x/SKILL.md"], only()],
    [
      "agent hooks and rules",
      [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".cursor/hooks.json", ".cursor/rules/beads.mdc"],
      only(),
    ],
    ["the cloud agent environment", [".cursor/environment.json"], only("worker")],
    ["the OpenAPI spec the Worker suite checks", ["docs/openapi.yaml"], only("worker")],
    ["a Worker module", ["src/router.ts"], only("worker", "ops")],
    ["a Worker test", ["test/integration/submit.test.ts"], only("worker")],
    ["a D1 migration", ["migrations/0020_x.sql"], only("worker")],
    ["a PostgreSQL migration", ["db/migrations/0002_x.sql"], only("worker")],
    ["a deploy workflow", [".github/workflows/deploy-app.yml"], only("worker")],
    ["a frontend route", ["app/src/routes/index.tsx"], only("app", "appBrowser")],
    ["a frontend unit test", ["app/test/reading-state.test.ts"], only("app")],
    ["the browser fixture pack", ["app/e2e/fixtures/fixture-pack.json"], only("worker", "app", "appBrowser")],
    ["the Markdown import limit the Worker suite pins", ["app/src/markdown-import-limit.ts"], only("worker", "app", "appBrowser")],
    ["the FrontendReads seam", ["src/frontend-reads.ts"], only("worker", "ops", "app")],
    // PR #444: staging routes, a comment in wrangler.toml, and docs.
    [
      "frontend routes with their backend comment",
      [".github/workflows/deploy-app-staging.yml", "app/README.md", "app/test/frontend-routes.test.ts", "app/wrangler.jsonc", "docs/operations.md", "wrangler.toml"],
      only("worker", "ops", "app"),
    ],
    ["the CI workflow", [".github/workflows/ci.yml"], only(...CI_JOBS)],
    ["an unclassified path", ["new-tool.config.js"], only(...CI_JOBS)],
  ])("%s", (_name, paths, expected) => {
    expect(selectJobs(paths)).toEqual(expected);
  });

  // Spawning the .ts entry needs Node's built-in type stripping (22.18+), as CI has.
  const stripsTypes = Boolean((process.features as { typescript?: unknown }).typescript);
  it.skipIf(!stripsTypes)("reads NUL-separated paths and writes step outputs", () => {
    const output = execFileSync(process.execPath, ["scripts/ci-lib/changed-jobs.ts"], {
      input: "test/integration/submit.test.ts\0app/test/a.test.ts\0",
      encoding: "utf8",
    });
    expect(output).toBe("worker=true\nops=false\napp=true\nappBrowser=false\n");
  });
});
