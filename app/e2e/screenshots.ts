// Screenshots are review artifacts, not pixel gates: the design spec uses
// system fonts, so wrapping differs between machines (issue #374). Each file
// lands under e2e/screenshots/<project>/<case>.png and is attached to the
// report, so CI uploads one browsable set.

import type { Page, TestInfo } from "@playwright/test";
import path from "node:path";

export const SCREENSHOT_DIR = path.join(import.meta.dirname, "screenshots");

export async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = path.join(SCREENSHOT_DIR, testInfo.project.name, `${name}.png`);
  const body = await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(`${name}.png`, { body, contentType: "image/png" });
}
