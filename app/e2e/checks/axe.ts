// Axe against WCAG 2.2 AA, the level the design spec commits to
// (docs/design/connected/design-spec.md, Themes and contrast). Violations fail
// the test; the full result is attached so a CI run explains itself.

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const WCAG_22_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function expectNoAxeViolations(page: Page, testInfo: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS).analyze();
  await testInfo.attach("axe-results.json", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
  expect(results.violations.map(describeViolation)).toEqual([]);
}

function describeViolation(violation: { id: string; help: string; nodes: { target: unknown[] }[] }): string {
  const targets = violation.nodes.map((node) => node.target.join(" ")).join(", ");
  return `${violation.id}: ${violation.help} (${targets})`;
}
