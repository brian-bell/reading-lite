// Reduced motion and zoom for the shell. Both run in one project; the loop over
// e2e/coverage.ts is the same one the matrix uses, so later pages inherit them
// by being added there.

import { EVIDENCE_CASES } from "../coverage";
import { expectNoAxeViolations } from "../checks/axe";
import { expectNoHorizontalScroll, expectReducedMotionHonoured } from "../checks/motion";
import { captureEvidence } from "../screenshots";
import { openCase, test } from "../test";

// Cases that reach their state by loading alone: no `prepare`, or one that
// only waits for the load's content (`waitsOnly`).
const SHELL = EVIDENCE_CASES.filter((evidence) => evidence.prepare === undefined || evidence.waitsOnly);

test.describe("reduced motion", () => {
  // reducedMotion is a context option in this Playwright version.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  for (const evidence of SHELL) {
    test(`${evidence.name} respects prefers-reduced-motion`, async ({ page, baseURL }, testInfo) => {
      await openCase(page, baseURL!, evidence);
      await expectReducedMotionHonoured(page);
      await captureEvidence(page, testInfo, `${evidence.name}-reduced-motion`);
    });
  }
});

// 200% zoom of the 1440 px desktop window, and the 320 px reflow floor
// (400% of 1280 px). See e2e/checks/motion.ts for why zoom is modelled as a
// viewport width.
const ZOOM_VIEWPORTS = [
  { name: "zoom-200", viewport: { width: 720, height: 466 } },
  { name: "reflow-320", viewport: { width: 320, height: 512 } },
];

for (const zoom of ZOOM_VIEWPORTS) {
  test.describe(zoom.name, () => {
    test.use({ viewport: zoom.viewport });

    for (const evidence of SHELL) {
      test(`${evidence.name} reflows without horizontal scrolling`, async ({ page, baseURL }, testInfo) => {
        await openCase(page, baseURL!, evidence);
        await expectNoHorizontalScroll(page);
        await expectNoAxeViolations(page, testInfo);
        await captureEvidence(page, testInfo, `${evidence.name}-${zoom.name}`);
      });
    }
  });
}
