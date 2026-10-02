// How much of the browser-evidence suite a run covers.
//
// The full suite is every case in e2e/coverage.ts in every project of
// playwright.config.ts, plus the reduced-motion and zoom passes: the local
// verification before a frontend change ships. CI runs the essential scope
// (`npm run test:browser:ci`): the cases marked `essential` in coverage.ts, in
// one light and one dark project that between them still cover both
// viewports, plus the behaviour specs. Reduced motion and zoom stay local.
//
// Against an external host (E2E_BASE_URL, e2e/harness.ts) only the projects
// playwright.config.ts marks `anyHost` run; each behaviour spec reads the
// stub's scenarios or the fixture pack.

import { externalBaseUrl } from "./harness";

export type EvidenceScope = "full" | "essential";

export const EVIDENCE_SCOPE: EvidenceScope = process.env.BROWSER_EVIDENCE === "essential" ? "essential" : "full";

/** Projects the essential scope keeps; every other project runs only in full. */
export const ESSENTIAL_PROJECTS = new Set([
  "phone-dark",
  "desktop-light",
  "checks",
  "reading-cache",
  "library",
  "library-return",
  "reading-trail",
  "reading-source",
  "reading-details",
  "save",
  "reading-refresh",
  "reprocess",
  "inbox",
  "account",
  "controls",
  "samples",
  "onboarding",
]);

export function inScope(project: { name?: string; metadata?: { anyHost?: boolean } }): boolean {
  if (externalBaseUrl() && !project.metadata?.anyHost) return false;
  return EVIDENCE_SCOPE === "full" || ESSENTIAL_PROJECTS.has(project.name ?? "");
}
