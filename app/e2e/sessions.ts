// Signed-in state for the browser-evidence suite. The value is the session key
// e2e/backend-stub.js answers for; the cookie name matches the backend's, so
// the frontend forwards exactly the header it forwards in production.
//
// E2E_SESSION_COOKIE overrides the value when the suite runs against a host
// with real sessions.

export const SESSION_COOKIE_VALUE = process.env.E2E_SESSION_COOKIE ?? "reader-a";

/**
 * `__Host-` cookies must be Secure, and a browser refuses a Secure cookie on
 * an http origin, so the local harness uses the plain name the stub also
 * accepts. Against an https host the real name is set, unchanged.
 */
export function sessionCookieName(baseUrl: string): string {
  return baseUrl.startsWith("https:") ? "__Host-session" : "e2e-session";
}

/** The email e2e/backend-stub.js reports for that session. */
export const SESSION_EMAIL = "reader-a@example.com";
