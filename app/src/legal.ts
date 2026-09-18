import { LEGAL_PATHS } from "./legal-copy";

/** Public legal routes (acceptance matrix, ADR 0003). They carry no identity. */
export const PUBLIC_LEGAL_PATHS = [LEGAL_PATHS.terms, LEGAL_PATHS.privacy, LEGAL_PATHS.dmca] as const;

export type PublicLegalPath = (typeof PUBLIC_LEGAL_PATHS)[number];

export function isPublicLegalPath(pathname: string): pathname is PublicLegalPath {
  return (PUBLIC_LEGAL_PATHS as readonly string[]).includes(pathname);
}
