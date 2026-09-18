import { describe, expect, it } from "vitest";
import {
  DMCA_DOCUMENT,
  LEGAL_NAV,
  LEGAL_PATHS,
  OPERATOR_CONTACT_EMAIL,
  PRIVACY_DOCUMENT,
  PUBLIC_HOST,
  TERMS_DOCUMENT,
} from "../src/legal-copy";
import {
  DMCA_DOCUMENT as webDmca,
  LEGAL_NAV as webNav,
  LEGAL_PATHS as webPaths,
  OPERATOR_CONTACT_EMAIL as webEmail,
  PRIVACY_DOCUMENT as webPrivacy,
  PUBLIC_HOST as webHost,
  TERMS_DOCUMENT as webTerms,
} from "../../web/src/legal-copy";

describe("legal copy", () => {
  it("matches the SPA documents, paths, and contact details", () => {
    expect(LEGAL_PATHS).toEqual(webPaths);
    expect(LEGAL_NAV).toEqual(webNav);
    expect(OPERATOR_CONTACT_EMAIL).toEqual(webEmail);
    expect(PUBLIC_HOST).toEqual(webHost);
    expect(TERMS_DOCUMENT).toEqual(webTerms);
    expect(PRIVACY_DOCUMENT).toEqual(webPrivacy);
    expect(DMCA_DOCUMENT).toEqual(webDmca);
  });
});
