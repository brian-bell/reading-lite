import { redactEmail } from "./email";

export function logAuthEvent(event: string, fields: Record<string, unknown> = {}): void {
  const redacted: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (/(secret|token|cookie|credential|authorization|hmac|fragment)/i.test(key)) {
      continue;
    }
    if (key === "email" && typeof value === "string") {
      try {
        redacted.email = redactEmail(value);
      } catch {
        redacted.email = "[redacted]";
      }
      continue;
    }
    redacted[key] = value;
  }
  console.info(JSON.stringify(redacted));
}
