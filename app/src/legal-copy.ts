// Public legal notices. Keep operational instructions in the product documentation.
export const LEGAL_PATHS = { terms: "/terms", privacy: "/privacy", dmca: "/dmca" } as const;
export const OPERATOR_CONTACT_EMAIL = "operator@readinglite.app";
export const PUBLIC_HOST = "readinglite.ai";

export type LegalBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };
export type LegalSection = { id: string; title: string; blocks: LegalBlock[] };
export type LegalDocument = {
  path: (typeof LEGAL_PATHS)[keyof typeof LEGAL_PATHS];
  navLabel: string;
  title: string;
  sections: LegalSection[];
};
export const LEGAL_NAV = [
  { path: LEGAL_PATHS.terms, label: "Terms" },
  { path: LEGAL_PATHS.privacy, label: "Privacy" },
  { path: LEGAL_PATHS.dmca, label: "Copyright" }
] as const;
const p = (text: string): LegalBlock => ({ type: "p", text });
const ul = (items: string[]): LegalBlock => ({ type: "ul", items });
const section = (id: string, title: string, ...blocks: LegalBlock[]): LegalSection => ({ id, title, blocks });
// Update this date when substantive legal copy changes; do not derive it at render time.
const updated = p("Last updated: October 1, 2026. Effective when published.");

export const TERMS_DOCUMENT: LegalDocument = {
  path: LEGAL_PATHS.terms,
  navLabel: "Terms",
  title: "Terms of Service",
  sections: [
    section("about", "About these terms", updated,
      p(`These terms govern your use of reading-lite at ${PUBLIC_HOST} and readinglite.app, a personal reading archive operated by Brian Bell (\"we\", \"us\"). By creating an account or using the service, you agree to these terms. If you do not agree, do not use the service. Contact us at ${OPERATOR_CONTACT_EMAIL}.`)),
    section("accounts", "Your account",
      p("You must be at least 18 years old and able to enter into this agreement. Use an email address you control, protect your sign-in links and API tokens, and tell us promptly if you believe someone has accessed your account without permission. You are responsible for the activity you authorize through your account."),
      p("You can manage your sessions, API tokens, email address, and notification preferences on the Security page. Access may be subject to invitations, usage limits, or other restrictions shown in the service.")),
    section("service", "What the service does",
      p("The service saves copies of articles and documents you submit, creates AI-generated summaries and search information, and helps you find related material in your archive. Your archive is not published as a public website. Our Privacy policy explains how we process and share information to provide these features."),
      p("AI-generated summaries, labels, and connections may be incomplete or wrong. Check important information against the original source. Outputs are not professional advice, and the service is not a substitute for your own backup. Some websites cannot be imported, and access to third-party sources may change.")),
    section("content", "Your content and permission to process it",
      p("You retain any rights you hold in the material you submit. Third-party material remains the property of its respective rights holders. Saving or summarizing a work does not give you ownership of it or permission to redistribute it."),
      p("You grant us a nonexclusive, worldwide, royalty-free permission to retrieve, copy, store, process, and display your submissions, and to create summaries and search representations, solely to operate and maintain the service for you. This permission extends to service providers performing those tasks for us and lasts only as needed for those purposes, including the retention and deletion process described in Privacy."),
      p("You must have the rights or other lawful authority needed for that processing. Do not submit material that infringes copyright or privacy rights, bypass access restrictions, compromise another account, interfere with the service, or evade usage limits. Private storage does not by itself make copying lawful.")),
    section("provider-key", "Your own AI provider key",
      p("Some accounts process readings with an OpenAI API key you connect on the Provider page. When yours does, the requests that summarize and index your readings are made with your key and charged to your OpenAI account under your own agreement with OpenAI. We do not pay for those requests or refund them, and we never fall back to another key when yours is missing or refused."),
      p("You are responsible for keeping your key valid and funded and for the charges made through it, including requests already sent when you remove or replace it, which may still finish and be charged. We use your key only to process your own readings. The daily spending limit on the Provider page is our own estimate, checked before we send requests; it is not a limit OpenAI enforces, and you can set limits in your OpenAI account as well. Usage limits we set for hosting apply whoever pays.")),
    section("suspension", "Suspension and ending use",
      p("You may stop using the service at any time and request deletion as described in Privacy. We may restrict access or remove material to address violations of these terms, security risks, unlawful activity, or legal requirements. We terminate accounts of repeat copyright infringers in appropriate circumstances."),
      p("We may change or discontinue this beta service. Where reasonably practicable, we will give advance notice of a discontinuation or a material restriction on your account; urgent security or legal concerns may require immediate action.")),
    section("availability", "Availability and responsibility",
      p("To the extent permitted by law, the service is provided as is and as available, without warranties of merchantability, fitness for a particular purpose, or noninfringement. We do not guarantee uninterrupted operation, accurate outputs, or preservation of every saved item."),
      p("To the extent permitted by law, we are not liable for indirect, incidental, special, or consequential losses arising from use of the service. Nothing in these terms excludes liability for fraud, willful misconduct, gross negligence, or any liability or consumer right that applicable law does not allow us to exclude or limit.")),
    section("changes", "Changes and questions",
      p("We may revise these terms as the service changes. We will update the date above and give notice through the service or email before material changes take effect. Your continued use after the effective date means you accept the revised terms, subject to any consent required by law."),
      p(`If you have a concern or dispute, contact ${OPERATOR_CONTACT_EMAIL} so we can try to resolve it. These terms do not require arbitration or waive your right to bring a claim in a court with jurisdiction. If a provision cannot be enforced, the remaining provisions continue to apply.`))
  ]
};

export const PRIVACY_DOCUMENT: LegalDocument = {
  path: LEGAL_PATHS.privacy,
  navLabel: "Privacy",
  title: "Privacy Policy",
  sections: [
    section("about", "Who is responsible", updated,
      p(`Brian Bell operates reading-lite at ${PUBLIC_HOST} and readinglite.app and is responsible for the personal information described here. Contact ${OPERATOR_CONTACT_EMAIL} with privacy questions or requests.`)),
    section("collection", "Information we collect",
      ul([
        "Account information: your email address, account settings, authentication records, sessions, API-token records, and device or browser labels used to help you recognize sessions.",
        "Provider key: if you connect your own OpenAI API key, we store it encrypted, with its last four characters, whether OpenAI accepts it, and when it was checked. We also record estimated charges against your daily spending limit.",
        "Saved material: submitted URLs and documents, downloaded source content, extracted text, summaries, tags, search representations, and connections between readings.",
        "Operational information: processing and error records, usage-limit records, email-delivery records, and information you send us when requesting support. Our infrastructure providers also process connection information, such as IP addresses, to deliver and protect the service."
      ])),
    section("uses", "How we use information",
      p("We use this information to authenticate you, save and search your readings, generate summaries, send requested messages, troubleshoot failures, enforce usage limits, prevent abuse, and respond to support and legal requests. We do not sell your personal information or use your saved readings for targeted advertising."),
      p("Where applicable law requires a legal basis, we process information to provide the service under our agreement with you, for legitimate interests in securing and maintaining the service, to meet legal obligations, or with consent where required. You can withdraw consent for optional processing without affecting earlier lawful processing.")),
    section("providers", "Who receives information",
      ul([
        "Cloudflare hosts the website, application, account database, saved content, search index, and background processing. Its Turnstile service may help protect sign-in from abuse.",
        "OpenAI receives text from processed readings to create search representations. The configured summarization provider, OpenAI or Anthropic, receives reading text and relevant material from earlier readings in your archive to generate summaries. The service does not silently switch summarization providers after a failure.",
        "When your account uses your own OpenAI key, those requests are made with your key, OpenAI handles them under the terms and policies of your OpenAI account, and OpenAI bills you for them. Checking a key when you connect it asks OpenAI which models the key can use, which is not charged.",
        "Resend receives email addresses and message content to deliver sign-in links, security messages, and reading notifications. Reading notifications can contain information from your archive.",
        "When you submit a URL, the source website receives a request for that page. Some imports also contact platform APIs, including YouTube or X, with the URL or identifiers needed to retrieve the material."
      ]),
      p("AI processing takes place outside your device. Provider retention and any use of submitted data are governed by the applicable API agreements and provider policies; this service does not promise zero retention by those providers. Do not submit secrets or other material you are not comfortable sending to these providers."),
      p("We may access account information and saved material when needed to provide support, investigate abuse or failures, or meet legal obligations. We may disclose information when legally required or reasonably necessary to protect rights and safety. Copyright complaints and responses may be shared with the other party so the claim can be addressed.")),
    section("cookies", "Cookies and messages",
      p("We use a necessary session cookie to keep you signed in. Anti-abuse checks may process browser information. Blocking necessary cookies can prevent sign-in from working."),
      p("Sign-in and security emails are part of operating your account. Notifications when a reading is ready are enabled by default; you can turn them off and choose daily, weekly, or no digest on the Security page.")),
    section("security", "Security and location",
      p("Accounts are separated using access controls, and your readings are not made available as public pages or shared with other users through the service. Your archive is not end-to-end encrypted: the application and its providers must process readable content to deliver its features. No online service can guarantee complete security."),
      p("A provider key you connect is encrypted with AES-256-GCM under a server secret kept apart from sign-in secrets, and bound to your account so it cannot be used for another. It is decrypted only in memory while a request to OpenAI is made. We never show it again in full: the service, its emails and exports, and our logs show at most its last four characters. Sign-in sessions can manage the key; API tokens cannot read or change it."),
      p("Our providers may process information in the United States and other countries, which may have different privacy protections from your country. Where applicable law requires safeguards for international transfers, those requirements apply to our processing. Contact us for information about the arrangements relevant to your account.")),
    section("retention", "How long information stays",
      p("Saved readings do not expire automatically. We generally retain them while your account remains open unless you delete them or we remove them under the Terms. Failed imports and processing records may also remain with your archive. Email-digest delivery records remain after a message is sent, skipped, or fails, and are removed during account teardown."),
      p("A limited account-deletion audit record, including the account identifier, deletion dates, and cleanup status, remains after account teardown so we can track deletion attempts and investigate incomplete cleanup. It does not contain your saved article text or email address. That record currently has no automatic expiry.")),
    section("deletion", "Deleting readings or your account",
      p(`You can request help deleting a reading or your account at ${OPERATOR_CONTACT_EMAIL}. Deletion is also available through the authenticated API. The web app does not yet have deletion buttons. We may need to verify your identity before acting.`),
      p("Removing your provider key on the Provider page deletes the stored key at once. Readings already saved stay readable and searchable without it."),
      p("Starting account deletion immediately disables sign-in, deletes any stored provider key, and revokes sessions and API tokens. Cleanup of saved content and search data normally starts after about seven days, unless we start it sooner. This delay is not a promise that the account can be recovered."),
      p("Cleanup runs in the background. Search data can take additional time to disappear, and incomplete cleanup can leave stored copies or search data requiring operator attention. We cannot currently give a guaranteed completion date or promise that every residual copy has been removed. Contact us to ask about the status of your request."),
      p("Deleting an individual reading removes it from your library and initiates removal of its stored content and search data. Deletion may need to wait while that reading is being processed. Earlier summaries or connections in your other readings can still contain references to it; those are not automatically rewritten. Deleting from this service does not remove the original source website.")),
    section("rights", "Your choices and requests",
      p("You can view your readings and retrieve individual saved documents through the website or API. There is no built-in bulk account export. Save anything you need before requesting account deletion, because access ends immediately when deletion starts."),
      p(`Depending on where you live, you may have rights to access, correct, delete, or receive a portable copy of personal information, restrict or object to processing, withdraw consent, or complain to a privacy regulator. Contact ${OPERATOR_CONTACT_EMAIL} to exercise applicable rights, including when the app has no corresponding control. We will verify requests as appropriate and respond within the period required by applicable law. A missing product feature does not limit your statutory rights.`)),
    section("children", "Children",
      p("The service is intended for adults, not children under 18. If you believe a child has provided personal information, contact us so we can investigate and address it.")),
    section("changes", "Policy changes",
      p("We will update this policy and its date when our practices change. We will provide notice through the service or email before material changes take effect and obtain consent where required. See Terms for the agreement governing use and Copyright for copyright complaints."))
  ]
};

export const DMCA_DOCUMENT: LegalDocument = {
  path: LEGAL_PATHS.dmca,
  navLabel: "Copyright",
  title: "Copyright Complaints",
  sections: [
    section("about", "Report a copyright concern", updated,
      p(`We respect copyright and review complaints about material stored through reading-lite. Send complaints to ${OPERATOR_CONTACT_EMAIL}. This is our copyright-complaint contact; it is not represented here as a registered DMCA agent.`),
      p("An archive being private does not exempt it from copyright law. Please identify the material as precisely as you can; you do not need access to another person's private account to report a concern.")),
    section("notice", "What to include",
      ul([
        "Your name and contact details, including an email address and mailing address, and a telephone number if available.",
        "Identify the copyrighted work and the material you believe infringes it. Include the source URL and any reading link, identifier, or other information that helps us locate the stored material.",
        "Confirm your good-faith belief that the disputed use is not authorized by the rights holder, its agent, or applicable law, including any relevant copyright exception.",
        "Confirm that your notice is accurate and declare, under penalty of perjury, that you hold the relevant rights or have authority to act for the rights holder.",
        "Provide your physical or electronic signature."
      ])),
    section("response", "How we respond",
      p("We review sufficiently detailed complaints promptly and remove or disable access to material when appropriate. We may ask for missing information. We normally notify the affected user and may share the complaint, including contact details, so they can respond. Avoid including unnecessary sensitive information."),
      p("We terminate accounts of repeat infringers in appropriate circumstances. We consider the available facts, including credible disputes and withdrawn or mistaken complaints. We cannot remove material from a source website operated by someone else.")),
    section("disputes", "If you believe removal was a mistake",
      p(`Contact ${OPERATOR_CONTACT_EMAIL} with your contact details, the removed reading's link or identifier, and an explanation of why the complaint is mistaken. Include any permission, license, or other information supporting your request.`),
      p("We will review your response and may ask either party for more information. We may share your response and contact details with the complainant. If we determine that restoration is appropriate, we will help you restore or resubmit the material. Contact us before resubmitting removed material."),
      p("This is a manual complaint and review process, not a formal DMCA counter-notification procedure. We do not promise automatic restoration or a fixed restoration deadline. Nothing in this process limits either party's rights under applicable law. See Terms and Privacy for account and data-handling information."))
  ]
};
