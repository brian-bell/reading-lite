// Every covered route (e2e/coverage.ts) in every matrix project
// (playwright.config.ts): 390 px and 1440 px, light and dark. Axe, the
// offscreen check, and the keyboard pass fail the job; the screenshot is
// evidence for review.

import { EVIDENCE_CASES } from "../coverage";
import { expectNoAxeViolations } from "../checks/axe";
import { expectNothingOffscreen } from "../checks/layout";
import {
  expectNoFocusTrap,
  expectSkipLinkFirst,
  expectVisibleFocusOnEveryStop,
  walkTabStops,
} from "../checks/keyboard";
import { captureEvidence } from "../screenshots";
import { SESSION_EMAIL } from "../sessions";
import { expect, openCase, test } from "../test";

for (const evidence of EVIDENCE_CASES) {
  test(`${evidence.name} renders its state, passes axe, and is usable from the keyboard`, async ({
    page,
    baseURL,
    theme,
  }, testInfo) => {
    await openCase(page, baseURL!, evidence);

    const applied = await page.locator("html").getAttribute("data-theme");
    expect(applied, "the theme cookie decides the server render").toBe(theme === "system" ? null : theme);
    if (evidence.state === "signed-in") {
      // The account menu's, not the account page's own mention of it.
      await expect(page.locator(".account-menu-email").getByText(SESSION_EMAIL)).toBeAttached();
      await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    } else {
      await expect(page.locator("details.account-menu")).toHaveCount(0);
    }
    await expectNothingOffscreen(page);
    await captureEvidence(page, testInfo, evidence.name);
    await expectNoAxeViolations(page, testInfo);

    // The walk starts from a fresh load: Chromium resumes tabbing from
    // wherever focus last was. It runs in every theme, since the focus
    // indicator is a themed token and a dark ring can fail to paint while the
    // light one passes.
    await openCase(page, baseURL!, evidence);
    await expectSkipLinkFirst(page);
    await openCase(page, baseURL!, evidence);
    const stops = await walkTabStops(page);
    expectVisibleFocusOnEveryStop(stops);
    expectNoFocusTrap(stops);
  });
}
