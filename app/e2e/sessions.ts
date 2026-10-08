// Signed-in state for the browser-evidence suite. The value is the session key
// e2e/backend-stub.js answers for; the cookie name matches the backend's, so
// the frontend forwards exactly the header it forwards in production.
//
// E2E_SESSION_COOKIE and E2E_SESSION_EMAIL override the value and the email
// it signs in as when the suite runs against a host with real sessions
// (e2e/harness.ts).

/** The real session an external run signs in with, if it was given one. */
export function hostSession(): string | undefined {
  return process.env.E2E_SESSION_COOKIE || undefined;
}

/** The address that real session's account menu shows. */
export function hostSessionEmail(): string | undefined {
  return process.env.E2E_SESSION_EMAIL || undefined;
}

export const SESSION_COOKIE_VALUE = hostSession() ?? "reader-a";

/**
 * A new reader (reading-lite-gh341.11): no provider key yet, which saving
 * needs, and nothing in the library. Only e2e/backend-stub.js knows it.
 */
export const NEW_READER_SESSION = "reader-new";

/**
 * `__Host-` cookies must be Secure, and a browser refuses a Secure cookie on
 * an http origin, so the local harness uses the plain name the stub also
 * accepts. Against an https host the real name is set, unchanged.
 */
export function sessionCookieName(baseUrl: string): string {
  return baseUrl.startsWith("https:") ? "__Host-session" : "e2e-session";
}

/** The email e2e/backend-stub.js reports for that session, or the real session's. */
export const SESSION_EMAIL = hostSessionEmail() ?? "reader-a@example.com";
