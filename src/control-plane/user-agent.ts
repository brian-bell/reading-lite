import { USER_AGENT_LABEL_MAX } from "./constants";

export function sanitizeUserAgent(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, USER_AGENT_LABEL_MAX);
}
