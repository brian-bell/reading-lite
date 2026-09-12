// Every covered route and state (e2e/coverage.ts) in every project
// (playwright.config.ts): 390 px and 1440 px, light and dark. Axe and the
// keyboard pass fail the job; the screenshot is evidence for review.

import { EVIDENCE_CASES } from "../coverage";
import { expectNoAxeViolations } from "../checks/axe";
import { expectNothingOffscreen } from "../checks/layout";
import {
  expectNoFocusTrap,
  expectSkipLinkFirst,
  expectSkipLinkReachesMain,
  expectVisibleFocusOnEveryStop,
  walkTabStops,
} from "../checks/keyboard";
import { captureEvidence } from "../screenshots";
import { SESSION_EMAIL } from "../sessions";
import { expect, openCase, test } from "../test";

for (const evidence of EVIDENCE_CASES) {
  test.describe(evidence.name, () => {
    test.beforeEach(async ({ page, baseURL }) => {
      await openCase(page, baseURL!, evidence);
    });

    test("renders the state in the project's theme", async ({ page, theme }, testInfo) => {
      const applied = await page.locator("html").getAttribute("data-theme");
      expect(applied, "the theme cookie decides the server render").toBe(
        theme === "system" ? null : theme,
      );
      // The signed-in and signed-out cases really differ, so the evidence for
      // each is the state it claims. Signed out, the way in is either the
      // navigation's link or the sign-in form rendered in place.
      if (evidence.state === "signed-in") {
        await expect(page.getByText(SESSION_EMAIL)).toBeAttached();
        await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
      } else {
        await expect(page.locator("details.account-menu")).toHaveCount(0);
        const waysIn =
          (await page.getByRole("link", { name: "Sign in" }).count()) +
          (await page.getByRole("button", { name: /Email me a link/ }).count());
        expect(waysIn, "a signed-out page offers a way to sign in").toBeGreaterThan(0);
      }
      await expectNothingOffscreen(page);
      await captureEvidence(page, testInfo, evidence.name);
    });

    test("has no WCAG 2.2 AA violations", async ({ page }, testInfo) => {
      await expectNoAxeViolations(page, testInfo);
    });

    // Each tab walk starts from a fresh load: Chromium resumes tabbing from
    // wherever focus last was, so the skip-link assertions need a clean page.
    test("is usable from the keyboard", async ({ page, baseURL }) => {
      const pristine = { ...evidence, prepare: undefined };
      await openCase(page, baseURL!, pristine);
      await expectSkipLinkFirst(page);

      await openCase(page, baseURL!, pristine);
      await expectSkipLinkReachesMain(page);

      await openCase(page, baseURL!, evidence);
      const stops = await walkTabStops(page);
      expectVisibleFocusOnEveryStop(stops);
      expectNoFocusTrap(stops);
    });
  });
}
