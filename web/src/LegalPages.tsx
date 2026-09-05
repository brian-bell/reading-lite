import { Link, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import {
  DMCA_DOCUMENT,
  LEGAL_NAV,
  LEGAL_PATHS,
  OPERATOR_CONTACT_EMAIL,
  PRIVACY_DOCUMENT,
  TERMS_DOCUMENT,
  type LegalDocument
} from "./legal-copy";

export { LEGAL_PATHS };

export function LegalFooter() {
  return (
    <footer className="site-footer">
      <LegalNav />
    </footer>
  );
}

export function LoginLegalLinks() {
  return (
    <div className="login-legal-links">
      <p>Legal notices:</p>
      <LegalNav />
    </div>
  );
}

function LegalNav() {
  const location = useLocation();
  return (
    <nav aria-label="Legal">
      {LEGAL_NAV.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          aria-current={location.pathname === item.path ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function TermsPage() {
  return <LegalDocumentPage document={TERMS_DOCUMENT} />;
}

export function PrivacyPage() {
  return <LegalDocumentPage document={PRIVACY_DOCUMENT} />;
}

export function DmcaPage() {
  return <LegalDocumentPage document={DMCA_DOCUMENT} />;
}

function LegalDocumentPage({ document }: { document: LegalDocument }) {
  return (
    <article className="page legal-page">
      <div className="page-heading">
        <h1>{document.title}</h1>
      </div>
      {document.sections.map((section) => (
        <section key={section.id} id={section.id} className="legal-section" aria-labelledby={`${section.id}-heading`}>
          <h2 id={`${section.id}-heading`}>{section.title}</h2>
          {section.blocks.map((block, index) =>
            block.type === "p" ? (
              <LegalParagraph key={index} text={block.text} selfPath={document.path} />
            ) : (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <LegalInline text={item} selfPath={document.path} />
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
      ))}
      <nav className="legal-cross-links" aria-label="Other legal pages">
        {LEGAL_NAV.filter((item) => item.path !== document.path).map((item) => (
          <Link key={item.path} to={item.path}>
            {item.label}
          </Link>
        ))}
      </nav>
    </article>
  );
}

function LegalParagraph({ text, selfPath }: { text: string; selfPath: string }) {
  return (
    <p>
      <LegalInline text={text} selfPath={selfPath} />
    </p>
  );
}

const WORD_TO_PATH: Record<string, string> = {
  Terms: LEGAL_PATHS.terms,
  Privacy: LEGAL_PATHS.privacy,
  DMCA: LEGAL_PATHS.dmca
};

function LegalInline({ text, selfPath }: { text: string; selfPath: string }) {
  const nodes: ReactNode[] = [];
  const escapedEmail = OPERATOR_CONTACT_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(${escapedEmail})|(\\/terms)|(\\/privacy)|(\\/dmca)|(Privacy)|(Terms)|(DMCA)`,
    "g"
  );
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token === OPERATOR_CONTACT_EMAIL) {
      nodes.push(
        <a key={key++} href={`mailto:${OPERATOR_CONTACT_EMAIL}`}>
          {OPERATOR_CONTACT_EMAIL}
        </a>
      );
    } else {
      const href = token.startsWith("/") ? token : WORD_TO_PATH[token];
      if (!href || href === selfPath) {
        nodes.push(token);
      } else {
        const label = LEGAL_NAV.find((item) => item.path === href)?.label ?? token;
        nodes.push(
          <Link key={key++} to={href}>
            {label}
          </Link>
        );
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}
