// Requests built by the FrontendReads entrypoint (src/frontend-reads.ts), which
// is reachable only through a service binding. ADR 0003 has the frontend Worker
// pass the browser's Cookie header on server renders, where a typed URL or an
// email link never satisfies cookieAuthAllowed's Origin/Sec-Fetch-Site gate.
// Instead of forging those headers, the entrypoint registers the Request object
// it constructs, and requirePrincipal treats exactly that object as
// same-origin. No request from the internet can enter this set: membership is
// object identity, not anything carried on the wire.

const trusted = new WeakSet<Request>();

export function trustFrontendRead(request: Request): Request {
  trusted.add(request);
  return request;
}

export function isTrustedFrontendRead(request: Request): boolean {
  return trusted.has(request);
}
