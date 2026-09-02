export function canonicalizeEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value.includes("@") || value.startsWith("@") || value.endsWith("@")) {
    throw new Error("email is required");
  }
  return value;
}

export function redactEmail(raw: string): string {
  const canonical = canonicalizeEmail(raw);
  const at = canonical.lastIndexOf("@");
  const local = canonical.slice(0, at);
  const domain = canonical.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Redact mailbox addresses in diagnostics and logs. Unknown shapes become `[redacted]`. */
export function redactEmailsInText(raw: string): string {
  return raw.replace(EMAIL_IN_TEXT, (match) => {
    try {
      return redactEmail(match);
    } catch {
      return "[redacted]";
    }
  });
}
