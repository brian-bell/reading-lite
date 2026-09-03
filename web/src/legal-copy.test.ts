import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CURRENT_BEHAVIOR_NOTICE,
  DMCA_DOCUMENT,
  flattenAllLegalText,
  flattenLegalText,
  formatLegalSection,
  LEGAL_DOCUMENTS,
  LEGAL_PATHS,
  OPERATOR_CONTACT_URL,
  PRIVACY_DELETION_SECTION,
  PRIVACY_DOCUMENT,
  TERMS_DOCUMENT
} from "./legal-copy";

describe("legal copy", () => {
  const all = flattenAllLegalText();

  it("marks every page as a draft of current product behavior", () => {
    expect(CURRENT_BEHAVIOR_NOTICE).toMatch(/current product behavior/i);
    expect(CURRENT_BEHAVIOR_NOTICE).toMatch(/not approved/i);
    for (const doc of LEGAL_DOCUMENTS) {
      expect(flattenLegalText(doc)).toContain(CURRENT_BEHAVIOR_NOTICE);
    }
  });

  it("uses the OpenAPI GitHub contact and does not invent a mailbox", () => {
    expect(OPERATOR_CONTACT_URL).toBe("https://github.com/brian-bell/reading-lite");
    expect(all).toContain(OPERATOR_CONTACT_URL);
    expect(all).not.toMatch(/mailto:/i);
    expect(all).not.toMatch(/\b[\w.+-]+@(?:bbell\.dev|reading-lite\.[a-z]+|example\.com)\b/i);
    expect(all.toLowerCase()).toMatch(/do not publish a dedicated (?:dmca|privacy|legal) mailbox|does not invent a legal mailbox|do not publish a dedicated dmca mailbox/);
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

  it("does not promise self-serve export or an ADR 0001 account wipe", () => {
    expect(all).toMatch(/no self-serve export/i);
    expect(flattenLegalText(PRIVACY_DOCUMENT)).toMatch(/self-serve account deletion is not available/i);
    expect(all).toMatch(/does not promise the full account wipe described in ADR 0001/i);
    expect(all).not.toMatch(/you can delete your account/i);
    expect(all).not.toMatch(/we will (?:delete|wipe) your entire account/i);
  });

  it("states reading purge only, including that the SPA may not expose it", () => {
    const deletion = formatLegalSection(PRIVACY_DELETION_SECTION);
    expect(PRIVACY_DELETION_SECTION.id).toBe("deletion");
    expect(deletion).toMatch(/Self-serve account deletion is not available/);
    expect(deletion).toMatch(/DELETE \/api\/readings\/:id/);
    expect(deletion).toMatch(/SPA does not currently expose reading purge/);
    expect(deletion).toMatch(/readings:delete/);
    expect(deletion).toMatch(/Inbound connections on other readings may still name the deleted id/);
    expect(deletion).toMatch(/ADR 0001/);
    expect(deletion).toMatch(/not implemented in the hosted product/);
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
