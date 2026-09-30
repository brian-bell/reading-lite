import { isPublicLegalPath } from "./legal";

// Pages anyone may open, signed in or not, whose server render carries no
// identity (ADR 0003). The root route skips the whoami read for them and
// request-policy leaves their HTML off `private, no-store`, so a shared cache
// may keep it: the legal notices, and the sample library
// (reading-lite-gh341.10), whose readings are bundled in the frontend rather
// than read from any tenant.

export const SAMPLES_PATH = "/samples";

/** `/samples` and every page under it. */
export function isSamplePath(pathname: string): boolean {
  return pathname === SAMPLES_PATH || pathname.startsWith(`${SAMPLES_PATH}/`);
}

export function isPublicPath(pathname: string): boolean {
  return isPublicLegalPath(pathname) || isSamplePath(pathname);
}
