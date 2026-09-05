import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DMCA_DOCUMENT,
  flattenAllLegalText,
  flattenLegalText,
  formatLegalSection,
  LEGAL_DOCUMENTS,
  LEGAL_PATHS,
  OPERATOR_CONTACT_EMAIL,
  PRIVACY_DELETION_SECTION,
  PRIVACY_DOCUMENT,
  PUBLIC_HOST,
  TERMS_DOCUMENT
} from "./legal-copy";

describe("legal copy", () => {
  const all = flattenAllLegalText();

  it("publishes live pages without a draft banner", () => {
    expect(all).not.toMatch(/draft for review/i);
    expect(all).not.toMatch(/not approved/i);
    expect(all).not.toMatch(/About this draft/);
    expect(all).not.toMatch(/current product behavior/i);
    for (const doc of LEGAL_DOCUMENTS) {
      expect(flattenLegalText(doc)).not.toMatch(/draft for review/i);
    }
  });

  it("publishes the operator email as the legal-notice contact", () => {
    expect(OPERATOR_CONTACT_EMAIL).toBe("operator@bbookmarks.com");
    expect(all).toContain(OPERATOR_CONTACT_EMAIL);
    expect(all).not.toMatch(/github\.com\/brian-bell\/reading-lite/);
    expect(all).toMatch(/do not publish a postal address/i);
    expect(all).toMatch(/phone number/);
  });

  it("names bbookmarks.com as the public host", () => {
    expect(PUBLIC_HOST).toBe("bbookmarks.com");
    expect(all).toContain(PUBLIC_HOST);
    expect(all).not.toMatch(/reading-lite\.bbell\.dev/);
  });

  it("describes current account, mail, and processor behavior", () => {
    expect(all).toMatch(/magic[- ]link/i);
    expect(all).toMatch(/D1/);
    expect(all).toMatch(/__Host-session/);
    expect(all).toMatch(/scoped API tokens/i);
    expect(all).toMatch(/Resend/);
    expect(all).toMatch(/immediate/i);
    expect(all).toMatch(/digest/i);
    expect(all).toMatch(/OpenAI/);
    expect(all).toMatch(/embedding/i);
    expect(all).toMatch(/Anthropic/);
    expect(all).toMatch(/never falls back silently|no silent fallback/i);
    expect(all).toMatch(/Cloudflare/);
    expect(all).toMatch(/R2/);
    expect(all).toMatch(/Vectorize/);
    expect(all).toMatch(/Queues/);
    expect(all).toMatch(/private-by-default/i);
  });

  it("does not promise self-serve export or a complete corpus wipe", () => {
    expect(all).toMatch(/no self-serve export/i);
    expect(all).toMatch(/does not claim that wipe is complete/i);
    expect(all).toMatch(
      /does not claim[^.!?]*(?:that residue is zero|zero residue|leaves zero residue)/i
    );
    expect(all).not.toMatch(/self-serve account deletion is not available/i);
    expect(all).not.toMatch(/ADR 0001/);
    expect(all).not.toMatch(/not implemented in the hosted product/i);
    expect(all).not.toMatch(/you can delete your account/i);
  });

  it("states account deletion and reading purge, including that the SPA exposes neither", () => {
    const deletion = formatLegalSection(PRIVACY_DELETION_SECTION);
    expect(PRIVACY_DELETION_SECTION.id).toBe("deletion");
    expect(deletion).toMatch(/DELETE \/api\/account/);
    expect(deletion).toMatch(/session-only/);
    expect(deletion).toMatch(/security email/);
    expect(deletion).toMatch(/asynchronous after that fence/);
    expect(deletion).toMatch(/SPA does not currently expose account deletion/);
    expect(deletion).toMatch(/DELETE \/api\/readings\/:id/);
    expect(deletion).toMatch(/SPA does not currently expose reading purge/);
    expect(deletion).toMatch(/readings:delete/);
    expect(deletion).toMatch(/Inbound connections on other readings may still name the deleted id/);
    expect(flattenLegalText(PRIVACY_DOCUMENT)).toMatch(/DELETE \/api\/account/);

    const dmca = flattenLegalText(DMCA_DOCUMENT);
    expect(dmca).toMatch(/DELETE \/api\/account/);
    expect(dmca).toMatch(/fences the account immediately/);
    expect(dmca).toMatch(/about seven days unless an operator starts it sooner/);
    expect(dmca).not.toMatch(/fences the account immediately and starts an asynchronous corpus wipe/);
    expect(dmca).toMatch(/does not claim[^.!?]*(?:that residue is zero|zero residue|leaves zero residue)/i);
  });

  it("publishes the three public paths", () => {
    expect(TERMS_DOCUMENT.path).toBe(LEGAL_PATHS.terms);
    expect(PRIVACY_DOCUMENT.path).toBe(LEGAL_PATHS.privacy);
    expect(DMCA_DOCUMENT.path).toBe(LEGAL_PATHS.dmca);
    expect(LEGAL_PATHS).toEqual({ terms: "/terms", privacy: "/privacy", dmca: "/dmca" });
  });

  it("documents legal routes on the Pages SPA fallback", () => {
    const redirects = readFileSync(join(process.cwd(), "public/_redirects"), "utf8");
    expect(redirects).toMatch(/\/terms/);
    expect(redirects).toMatch(/\/privacy/);
    expect(redirects).toMatch(/\/dmca/);
    expect(redirects).toMatch(/\/index\.html\s+200/);
  });
});
