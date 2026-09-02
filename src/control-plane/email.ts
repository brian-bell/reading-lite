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

/**
 * Every mailbox canonicalizeEmail accepts in free text. Quoted-local is first
 * so `"Foo Bar"@x` is not split on the space. Unquoted local/domain may have
 * interior whitespace (`a @ b`); `@` still cannot start or end the match.
 */
const EMAIL_IN_TEXT = /"[^"]+"\s*@\s*[^\s@]+|[^\s@]+\s*@\s*[^\s@]+/g;

/** Redact mailbox addresses in diagnostics and logs. Unknown shapes become `[redacted]`. */
export function redactEmailsInText(raw: string, knownRecipients: readonly string[] = []): string {
  let out = raw;
  for (const known of knownRecipients) {
    out = redactKnownRecipient(out, known);
  }
  return out.replace(EMAIL_IN_TEXT, (match) => redactMatchedMailbox(match));
}

function redactKnownRecipient(raw: string, known: string): string {
  const variants = knownRecipientVariants(known);
  if (variants.length === 0) return raw;
  const escaped = variants.map(escapeRegExp).join("|");
  return raw.replace(new RegExp(escaped, "gi"), (match) => redactMatchedMailbox(match));
}

function knownRecipientVariants(known: string): string[] {
  const variants = new Set<string>();
  const trimmed = known.trim();
  if (trimmed) {
    variants.add(trimmed);
    variants.add(trimmed.toLowerCase());
  }
  try {
    variants.add(canonicalizeEmail(known));
  } catch {
    /* ignore */
  }
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redactMatchedMailbox(match: string): string {
  try {
    return redactEmail(match);
  } catch {
    return "[redacted]";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
