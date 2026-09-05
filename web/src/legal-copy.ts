// Published Terms, Privacy, and DMCA copy for the hosted product.
// Contact for legal notices is operator@bbookmarks.com (email only).

export const LEGAL_PATHS = {
  terms: "/terms",
  privacy: "/privacy",
  dmca: "/dmca"
} as const;

export const OPERATOR_CONTACT_EMAIL = "operator@bbookmarks.com";
export const PUBLIC_HOST = "bbookmarks.com";

export type LegalBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

export type LegalSection = {
  id: string;
  title: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  path: (typeof LEGAL_PATHS)[keyof typeof LEGAL_PATHS];
  navLabel: string;
  title: string;
  sections: LegalSection[];
};

export const LEGAL_NAV = [
  { path: LEGAL_PATHS.terms, label: "Terms" },
  { path: LEGAL_PATHS.privacy, label: "Privacy" },
  { path: LEGAL_PATHS.dmca, label: "DMCA" }
] as const;

function p(text: string): LegalBlock {
  return { type: "p", text };
}

function ul(items: string[]): LegalBlock {
  return { type: "ul", items };
}

export function flattenLegalText(doc: LegalDocument): string {
  const parts = [doc.title];
  for (const section of doc.sections) {
    parts.push(section.title);
    for (const block of section.blocks) {
      if (block.type === "p") parts.push(block.text);
      else parts.push(...block.items);
    }
  }
  return parts.join("\n");
}

export function flattenAllLegalText(): string {
  return LEGAL_DOCUMENTS.map(flattenLegalText).join("\n");
}

export function formatLegalSection(section: LegalSection): string {
  const lines: string[] = [`## ${section.title}`, ""];
  for (const block of section.blocks) {
    if (block.type === "p") {
      lines.push(block.text, "");
    } else {
      for (const item of block.items) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export const TERMS_DOCUMENT: LegalDocument = {
  path: LEGAL_PATHS.terms,
  navLabel: "Terms",
  title: "Terms of Service",
  sections: [
    {
      id: "about",
      title: "About these Terms",
      blocks: [
        p(
          `reading-lite is a personal reading archive, search, and retrieval service hosted at ${PUBLIC_HOST}. These Terms describe how the hosted product works today: you submit URLs or Markdown, the service extracts and stores a private copy, embeds and summarizes it, and lets you search and reread your own corpus.`
        ),
        p(
          `The operator contact for legal notices is ${OPERATOR_CONTACT_EMAIL} (email only). These pages do not publish a postal address, phone number, or separate legal entity name.`
        )
      ]
    },
    {
      id: "accounts",
      title: "Accounts and access",
      blocks: [
        p(
          "Access is account-based. Sign-in uses a magic link sent to an email address you control. The service stores sessions in Cloudflare D1 and sets a host-only __Host-session cookie for the browser SPA. Programmatic clients authenticate with scoped API tokens (Authorization: Bearer). Cookie-authenticated POST and DELETE requests also require a session-bound CSRF token from GET /api/whoami."
        ),
        p(
          "You are responsible for the email inbox used to receive magic links, for revoking sessions and tokens you no longer want, and for keeping token secrets private. The Security page lets you list and revoke browser sessions, create and revoke scoped API tokens, change the verified email, and choose notification settings. Recent authentication is required for some sensitive changes."
        ),
        ul([
          "Magic-link sign-in (email), not passwords or social OAuth.",
          "D1-backed browser sessions with a host-only __Host-session cookie.",
          "Scoped API tokens for MCP and other programmatic clients (readings:read, readings:write, readings:import, readings:delete).",
          "Cloudflare Turnstile may run on open-mode magic-link challenges; invite-only and closed signup ignore extra tokens."
        ])
      ]
    },
    {
      id: "the-service",
      title: "The hosted service",
      blocks: [
        p(
          "When you submit a URL, the service writes an eager per-tenant by-url ownership claim, stores a pending manifest, and enqueues a reading job. The background pipeline fetches the source (subject to timeouts, size caps, and source-specific limits), extracts Markdown, embeds the text with OpenAI, queries Cloudflare Vectorize for similar readings in your tenant, summarizes through the configured provider, and commits a terminal manifest plus the list index."
        ),
        p(
          "Summarization uses the configured provider: OpenAI structured output by default, or Anthropic tool use when selected. Provider selection never falls back silently. Embeddings always use OpenAI. You may also import Markdown for sources the worker cannot fetch well (for example Reddit bot-challenges). Reprocess can reuse stored Markdown or accept new Markdown; a source-type flip is recorded only after success."
        ),
        ul([
          "Private-by-default: readings are not a public archive or sharing product. Other tenants cannot see your corpus.",
          "Infrastructure: Cloudflare Workers, Pages, R2, D1, Vectorize, and Queues.",
          "Email: Resend sends magic-link mail plus optional immediate and digest notification mail to the current verified address.",
          "MCP tools search the same private corpus through named tools after authentication."
        ])
      ]
    },
    {
      id: "your-content",
      title: "Your submissions",
      blocks: [
        p(
          "You represent that you have a right to submit each URL or Markdown document and to have the service fetch, store, embed, and summarize it for your private use. Submitting a URL causes the worker to request that URL from the origin (and, for some hosts, to call additional public APIs such as YouTube oEmbed or X recent search). The stored corpus includes raw bytes when captured, extracted Markdown, manifests, embeddings, summaries, tags, entities, connections, and attempt logs."
        ),
        p(
          "Do not use the service to attack systems, bypass access controls, submit material you are not allowed to copy, or overload the pipeline. The operator may refuse, fail, or drop readings that violate these Terms, that cannot be fetched, or that operator policy excludes."
        )
      ]
    },
    {
      id: "availability",
      title: "Availability and changes",
      blocks: [
        p(
          "The hosted product is provided as-is for current personal and beta use. The operator may change models, effort, rate limits, quotas, and features. These pages will be updated when behavior changes; they are not a guarantee of future behavior."
        ),
        p(
          "See Privacy for retention, processors, export, and deletion as they work today, and DMCA for copyright notices. Related pages: Privacy and DMCA."
        )
      ]
    }
  ]
};

export const PRIVACY_DELETION_SECTION: LegalSection = {
  id: "deletion",
  title: "Deletion",
  blocks: [
    p(
      `Self-serve account deletion starts with DELETE /api/account. That request is session-only (a browser session cookie, not a bearer API token), requires cookie CSRF and recent authentication, and must include the body { confirm: "delete" }. Starting deletion immediately marks the account deleting, revokes every session and API token, sends a security email to the current verified address, and clears the browser session cookie. Later sign-in and API use are refused.`
    ),
    p(
      "Corpus wipe of tenant R2 objects, Vectorize embeddings, and related indexes is asynchronous after that fence: a new wipe waits about seven days unless an operator starts it sooner. Embeddings may take additional time to disappear after a delete is submitted. This page does not claim that wipe is complete, that residue is zero, or that no R2 or Vectorize data remains."
    ),
    p(
      "The SPA does not currently expose account deletion. There is no delete-account control in the web app. Account deletion is an API operation."
    ),
    p("You can also delete a single reading, not the whole account:"),
    ul([
      "Reading purge exists as an authenticated API: DELETE /api/readings/:id, gated by the readings:delete scope. The purge is visibility-first: it requests deletion of the Vectorize vector (when Vectorize is bound), releases the owned by-url pointer, removes the list-index row, deletes R2 objects under the reading's id-scoped prefix, and removes the by-id pointer last. Inbound connections on other readings may still name the deleted id. A purge is refused with 409 while an attempt is actively running.",
      "The SPA does not currently expose reading purge. There is no delete button in the web app. Purge is an API operation.",
      "Operators can drop selected readings with operator tooling."
    ]),
    p(
      "Account data is otherwise retained until a reading is purged, account deletion runs, or an operator drops it."
    )
  ]
};

export const PRIVACY_DOCUMENT: LegalDocument = {
  path: LEGAL_PATHS.privacy,
  navLabel: "Privacy",
  title: "Privacy",
  sections: [
    {
      id: "about",
      title: "About this policy",
      blocks: [
        p(
          `This page describes what the hosted reading-lite product at ${PUBLIC_HOST} collects, where it stores it, which processors it uses, and what you can and cannot delete or export today.`
        )
      ]
    },
    {
      id: "accounts-identity",
      title: "Accounts and identity",
      blocks: [
        p(
          "Sign-in is magic-link email authentication. The control plane in Cloudflare D1 stores user and tenant records, hashed credentials, sessions, API tokens, and settings. Browser sessions use a host-only __Host-session cookie. API tokens are scoped (readings:read, readings:write, readings:import, readings:delete) and can be revoked. Runtime authentication does not fall back to a shared legacy bearer secret."
        ),
        p(
          "When signup is open and a Turnstile site key is configured, magic-link challenges verify a Cloudflare Turnstile token. Invite-only and closed modes do not require that widget. Email change sends a confirmation link to the new address and must be completed from the signed-in browser that requested it."
        )
      ]
    },
    {
      id: "readings",
      title: "Readings and derived artifacts",
      blocks: [
        p(
          "For each reading the service may store: the submitted URL, imported Markdown, fetched raw bytes, extracted Markdown, the manifest (title, TL;DR, summary, tags, people, organizations, keywords, novelty verdict, connections, tensions, status, errors), attempt logs, by-url and by-id pointers, a list-index row, and a Vectorize embedding. On the hosted product, tenant objects live under a tenant-rooted R2 prefix and Vectorize queries use a tenant namespace so one tenant cannot match another tenant's vectors."
        ),
        p(
          "Submitting a URL causes the worker to fetch that URL from the origin. Some hosts use extra public APIs (YouTube oEmbed; X/Twitter recent search when an operator token is configured). Reddit threads typically fail in-worker because of a bot challenge. Those fetches send the URL (and sometimes a conversation identifier) to the origin. The stored archive is private-by-default: it is not a public web page and there is no sharing product."
        )
      ]
    },
    {
      id: "notifications",
      title: "Notification email",
      blocks: [
        p(
          "Resend sends email. Magic-link and email-change messages go to the address being verified. Immediate notification mail (optional; default on) is sent when a reading becomes ready, to the current verified email_display — never to a leftover EMAIL_TO operator override. Digest mail (optional daily or weekly cadence, or off) is also Resend to that same verified address. Send-time re-read honors cadence off. Empty digest windows skip sending. You can change these settings on the Security page."
        )
      ]
    },
    {
      id: "processors",
      title: "Processors and subprocessors",
      blocks: [
        p("Current processing, as configured in the hosted product:"),
        ul([
          "Cloudflare: Workers (compute), Pages (SPA), R2 (objects), D1 (control plane and sessions), Vectorize (embeddings), Queues (reading, digest, and account-wipe jobs), and Turnstile (when open signup is enabled).",
          "OpenAI: embeddings (text-embedding-3-small, 1536 dimensions) for every processed reading. OpenAI also summarizes when it is the selected summarizer, using structured output. There is no silent fallback to another provider.",
          "Anthropic: summarizes only when SUMMARIZER_PROVIDER is anthropic (tool use). Invalid provider or effort values fail closed; the product does not switch providers on error.",
          "Resend: magic-link, immediate notification, digest, and account-deletion security email.",
          "Source sites and platform APIs: the origin of each submitted URL, plus YouTube oEmbed and X recent search when those URL types are processed."
        ]),
        p(
          "The selected summarizer and the embedding API receive extracted text (and, for summarization, similar prior readings from your tenant as context). Do not submit secrets you do not want those processors to see."
        )
      ]
    },
    {
      id: "retention",
      title: "Retention",
      blocks: [
        p(
          "Data is retained until a reading is purged, account deletion runs, or an operator drops it. There is no automatic expiry of ready readings. Pending work that exceeds the pending TTL is annotated stale on read; failed readings remain until reprocess, purge, account deletion, or operator drop. Queue retries and a dead-letter path can leave retryable failed manifests. Digest delivery ledgers live in D1 until the digest pipeline closes them. Account deletion fences access immediately; corpus wipe after that fence is asynchronous, and this page does not claim wipe is complete."
        )
      ]
    },
    {
      id: "export",
      title: "Access and export",
      blocks: [
        p(
          "There is no self-serve export of an entire account. Authenticated API and SPA access let you retrieve individual readings you already stored (list, detail, extracted Markdown, raw bytes, diagnostics). That is not a bulk export, portable archive, or guaranteed takeout format."
        )
      ]
    },
    PRIVACY_DELETION_SECTION,
    {
      id: "private-by-default",
      title: "Private by default",
      blocks: [
        p(
          "Archives are private-by-default. The product does not publish your readings as public pages, does not offer team sharing, and does not serve other tenants' similarity results into your summaries. Authenticated MCP tools read the same tenant corpus. Inbound connection references on other readings in your own corpus may still name a purged id."
        )
      ]
    },
    {
      id: "contact",
      title: "Contact",
      blocks: [
        p(
          `Questions about this policy go to ${OPERATOR_CONTACT_EMAIL}. These pages do not publish a postal address or phone number. See also Terms and DMCA.`
        )
      ]
    }
  ]
};

export const DMCA_DOCUMENT: LegalDocument = {
  path: LEGAL_PATHS.dmca,
  navLabel: "DMCA",
  title: "DMCA",
  sections: [
    {
      id: "about",
      title: "About this notice",
      blocks: [
        p(
          "reading-lite stores private copies of third-party pages you submit (raw bytes when captured, extracted Markdown, and derived summaries). That is a copyright-sensitive surface. This page describes how to notify the operator. It is not a claim that a designated DMCA agent is registered."
        )
      ]
    },
    {
      id: "not-a-public-host",
      title: "Private corpus, not a public host",
      blocks: [
        p(
          "The hosted product is private-by-default. Readings are not published as public web pages, there is no sharing product, and other tenants cannot browse your archive. A stored copy still exists in R2 (and related indexes) until it is purged, dropped, or removed by the asynchronous account-deletion wipe. Copyright owners who believe a stored copy infringes can ask the operator to purge that reading."
        )
      ]
    },
    {
      id: "how-to-notify",
      title: "How to send a notice",
      blocks: [
        p(
          `Send notices to ${OPERATOR_CONTACT_EMAIL}. These pages do not publish a postal address or phone number.`
        ),
        p("A useful notice includes:"),
        ul([
          "Your contact information as the complainant.",
          "The work you claim is infringed, and the exact reading URL or reading id (rd_…) in reading-lite if you have it.",
          "A statement that you have a good-faith belief the use is not authorized, and that the notice is accurate.",
          "If you are requesting removal under U.S. copyright law, a statement under penalty of perjury that you are the owner or authorized to act, plus your signature (physical or electronic)."
        ])
      ]
    },
    {
      id: "what-we-can-do",
      title: "What the operator can do today",
      blocks: [
        p(
          "The available product control for a stored copy is reading purge: DELETE /api/readings/:id (readings:delete). That removes the reading's vector (when bound), owned by-url pointer, list row, R2 objects, and by-id pointer. The SPA does not currently expose that control."
        ),
        p(
          "Account deletion (DELETE /api/account) fences the account immediately and starts an asynchronous corpus wipe; this page does not claim that wipe leaves zero residue. The operator may purge or drop the identified reading after reviewing a notice. Inbound connections on other readings may still name a purged id. Source sites remain under their own operators; this service cannot take down the original URL."
        )
      ]
    },
    {
      id: "counter-notice",
      title: "Counter-notice",
      blocks: [
        p(
          `If your reading was purged after a copyright notice and you believe that was a mistake, email ${OPERATOR_CONTACT_EMAIL} with the reading id, a description of why the copy should be restored, and your contact information. Restoration is a manual operator action; there is no self-serve restore.`
        )
      ]
    }
  ]
};

export const LEGAL_DOCUMENTS: LegalDocument[] = [TERMS_DOCUMENT, PRIVACY_DOCUMENT, DMCA_DOCUMENT];

export function legalDocumentForPath(pathname: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((doc) => doc.path === pathname);
}
