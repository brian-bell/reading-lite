import { expect, it } from "vitest";
import { jobsForPath } from "../../scripts/ci-lib/changed-jobs";

it("runs worker, app, and browser jobs for the http upgrade module", () => {
  expect(jobsForPath("app/src/server/http-upgrade.ts")).toEqual(["worker", "app", "appBrowser"]);
});
