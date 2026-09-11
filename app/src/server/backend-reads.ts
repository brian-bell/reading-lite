// The backend's read-only FrontendReads entrypoint, bound as BACKEND in
// wrangler.jsonc (ADR 0003, Server reads). Mirrors src/frontend-reads.ts at the
// repo root; keep the two in step, as web/src/types.ts is kept in step with the
// API schemas.
//
// Results carry the HTTP API's status and JSON body and no headers, so the
// backend cannot set cookies through this binding. Server renders only: browser
// code calls same-origin /api/* (src/api/client.ts).

export type BackendReadResult = { status: number; body: unknown };

export interface BackendReads {
  /** GET /api/whoami for the browser's session cookie. */
  whoami(input: { cookie: string | null; host: string }): Promise<BackendReadResult>;
  /** GET /api/readings/:id, optionally pinned with x-expected-tenant. */
  reading(input: {
    cookie: string | null;
    host: string;
    id: string;
    expectedTenant?: string;
  }): Promise<BackendReadResult>;
}

/** What a server render forwards: the incoming Cookie header and host, nothing else. */
export function forwardedFrom(request: Request): { cookie: string | null; host: string } {
  return { cookie: request.headers.get("cookie"), host: new URL(request.url).host };
}
