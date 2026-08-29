import { SESSION_COOKIE_MAX_AGE_SECONDS, SESSION_COOKIE_NAME } from "./constants";

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

export function readSessionCookie(header: string | undefined): string | null {
  return readCookie(header, SESSION_COOKIE_NAME);
}

export function sessionCookieHeader(credential: string): string {
  return `${SESSION_COOKIE_NAME}=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
