// Decides which CI jobs a pull request's changed paths need
// (.github/workflows/ci.yml, `changes` job). Pushes to main skip this and run
// every job: a deploy follows any green main run, so main must never ship on
// an earlier commit's result.
//
// Each rule names the jobs whose suites read the matching paths; the first
// matching rule wins. A path no rule matches runs every job, so a new
// top-level file costs CI time rather than coverage. Changing this file or
// ci.yml runs everything.
//
// Runs directly under Node 22's type stripping: keep it free of imports that
// need a build step and of non-erasable TypeScript syntax.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CI_JOBS = ["worker", "ops", "app", "appBrowser"] as const;
export type CiJob = (typeof CI_JOBS)[number];
export type CiJobSelection = Record<CiJob, boolean>;

const ALL: readonly CiJob[] = CI_JOBS;
const NONE: readonly CiJob[] = [];
// The Worker suite, plus the Ops CLI job, which imports scripts/ and,
// through them, src/.
const BACKEND: readonly CiJob[] = ["worker", "ops"];

type Rule = [pattern: RegExp, jobs: readonly CiJob[]];

const RULES: Rule[] = [
  [/^\.github\/workflows\/ci\.yml$|^scripts\/ci-lib\//, ALL],
  // No suite reads the other workflows.
  [/^\.github\/workflows\//, NONE],

  // Documentation.
  [/^docs\//, NONE],
  [/^(README\.md|AGENTS\.md|CLAUDE\.md|CONTEXT\.md|LICENSE|skills-lock\.json|\.gitignore|\.dockerignore|Dockerfile|docker-compose\.yml)$/, NONE],
  [/^evaluations\/|^\.beads\/|^\.claude\/skills\//, NONE],
  // Agent skills, hooks, rules, and cloud-agent setup. No suite reads them.
  [/^(\.agents\/.*|\.claude\/settings\.json|\.codex\/.*|\.cursor\/.*)$/, NONE],

  // app/. The Worker suite checks the committed browser fixture pack and
  // sample library against the local fixture pack they are projected from.
  [/^app\/.*\.md$|^app\/(Dockerfile|\.dockerignore)$/, NONE],
  // The design study (app/prototypes): its own Vite entry and Vitest config,
  // outside the app's tsconfig, tests, build, and browser evidence.
  [/^app\/prototypes\/|^app\/(vite|vitest)\.prototypes\.config\.ts$|^app\/tsconfig\.prototypes\.json$/, NONE],
  [/^app\/(e2e\/fixtures\/|src\/samples\/)/, ["worker", "app", "appBrowser"]],
  // Unit tests, the smoke suite, and Worker config. wrangler.jsonc is mostly
  // routes and bindings; its compatibility and assets settings shape the built
  // Worker, which the app job's smoke suite serves (backend 404s, cache
  // headers, themed SSR), so browser evidence waits for a rendering change.
  [/^app\/(test|smoke|scripts)\/|^app\/(wrangler\.jsonc|vitest\.config\.ts|vitest\.smoke\.config\.ts)$/, ["app"]],
  [/^app\//, ["app", "appBrowser"]],

  // The root Worker. app/test checks its routes and service bindings against
  // wrangler.toml, and mirrors the FrontendReads seam.
  [/^wrangler\.toml$|^src\/frontend-reads\.ts$/, [...BACKEND, "app"]],
  [/^(src|scripts)\//, BACKEND],
  [/^(package\.json|package-lock\.json|tsconfig\.json|vitest\.config\.ts|vitest\.workspace\.ts)$/, BACKEND],
  // The Ops CLI job runs this file's wrangler launch case.
  [/^test\/unit\/operator-guards\.test\.ts$/, BACKEND],
  // db/ holds the PostgreSQL migrations the Worker suite's globalSetup applies.
  [/^(test|db)\//, ["worker"]],
  [/^(wrangler\.test\.toml|worker-configuration\.d\.ts)$/, ["worker"]],
  [/^\.(dev|stg|corpus)\.vars\.example$/, NONE],
];

export function jobsForPath(path: string): readonly CiJob[] {
  for (const [pattern, jobs] of RULES) {
    if (pattern.test(path)) return jobs;
  }
  return ALL;
}

export function selectJobs(paths: Iterable<string>): CiJobSelection {
  const selection = Object.fromEntries(CI_JOBS.map((job) => [job, false])) as CiJobSelection;
  for (const path of paths) {
    for (const job of jobsForPath(path)) selection[job] = true;
  }
  return selection;
}

export function formatOutputs(selection: CiJobSelection): string {
  return CI_JOBS.map((job) => `${job}=${selection[job]}\n`).join("");
}

// CLI: NUL-separated paths (`git diff --name-only -z`) on stdin, GitHub
// Actions `key=value` outputs on stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const paths = Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean);
  process.stdout.write(formatOutputs(selectJobs(paths)));
}
