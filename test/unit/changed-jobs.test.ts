// The http-upgrade rule is more specific than /^app\// and wins first, so it
// has to name every job the app tree would have selected plus the Worker.

import { expect, it } from "vitest";
import { jobsForPath } from "../../scripts/ci-lib/changed-jobs";

it("runs worker, app, and browser jobs for the http upgrade module", () => {
  expect(jobsForPath("app/src/server/http-upgrade.ts")).toEqual(["worker", "app", "appBrowser"]);
});
