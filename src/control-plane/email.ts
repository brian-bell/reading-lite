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
