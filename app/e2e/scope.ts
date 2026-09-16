// How much of the browser-evidence suite a run covers.
//
// The full suite is every case in e2e/coverage.ts in every project of
// playwright.config.ts, plus the reduced-motion and zoom passes: the local
// verification before a frontend change ships. CI runs the essential scope
// (`npm run test:browser:ci`): the cases marked `essential` in coverage.ts, in
// one light and one dark project that between them still cover both
// viewports, plus the behaviour specs. Reduced motion and zoom stay local.

export type EvidenceScope = "full" | "essential";

export const EVIDENCE_SCOPE: EvidenceScope = process.env.BROWSER_EVIDENCE === "essential" ? "essential" : "full";

/** Projects the essential scope keeps; every other project runs only in full. */
export const ESSENTIAL_PROJECTS = new Set([
  "phone-dark",
  "desktop-light",
  "checks",
  "reading-cache",
  "library",
  "reading-trail",
  "reading-source",
  "reading-details",
  "save",
]);

export function inScope(project: { name?: string }): boolean {
  return EVIDENCE_SCOPE === "full" || ESSENTIAL_PROJECTS.has(project.name ?? "");
}
