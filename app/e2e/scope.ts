// How much of the browser-evidence suite a run covers.
//
// The full suite is every project in playwright.config.ts: the local
// verification before a frontend change ships. CI runs the essential scope
// (`npm run test:browser:ci`): one light and one dark matrix project that
// between them still cover both viewports, plus onboarding.
//
// Against an external host (E2E_BASE_URL, e2e/harness.ts) only the projects
// playwright.config.ts marks `anyHost` run.

import { externalBaseUrl } from "./harness";

export type EvidenceScope = "full" | "essential";

export const EVIDENCE_SCOPE: EvidenceScope = process.env.BROWSER_EVIDENCE === "essential" ? "essential" : "full";

/** Projects the essential scope keeps; every other project runs only in full. */
export const ESSENTIAL_PROJECTS = new Set(["phone-dark", "desktop-light", "onboarding"]);

export function inScope(project: { name?: string; metadata?: { anyHost?: boolean } }): boolean {
  if (externalBaseUrl() && !project.metadata?.anyHost) return false;
  return EVIDENCE_SCOPE === "full" || ESSENTIAL_PROJECTS.has(project.name ?? "");
}
