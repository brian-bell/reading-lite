import { forwardedFrom, type BackendReads } from "./server/backend-reads";

// Signed-in identity from GET /api/whoami, read through the backend entrypoint
// during a server render and from same-origin /api/whoami in the browser. Both
// paths map the response here, so they agree on what signed out means.

/** GetWhoamiResponseSchema in the backend's src/schemas/api.ts. */
export interface Identity {
  tenant_id: string;
  user_id: string;
  principal: "session" | "token";
  tenant_data_plane: boolean;
  email: string;
  csrf_token?: string;
}

export const whoamiQueryKey = ["whoami"] as const;

/** Identity could not be determined. Not a sign-out: the shell shows neither state. */
export class IdentityUnavailableError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "IdentityUnavailableError";
    this.status = status;
  }
}

/** 200 is an identity and 401 is signed out (null). Anything else, 403 included (#369), throws. */
export function identityFromResponse(status: number, body: unknown): Identity | null {
  if (status === 401) return null;
  if (status !== 200) throw new IdentityUnavailableError(status, `whoami returned ${status}`);
  if (!isIdentity(body)) throw new IdentityUnavailableError(status, "whoami returned an unexpected body");
  return body;
}

/** Server renders: forward the incoming Cookie header and host to the backend entrypoint. */
export async function readWhoamiFromBackend(backend: BackendReads, request: Request): Promise<Identity | null> {
  let result;
  try {
    result = await backend.whoami(forwardedFrom(request));
  } catch (err) {
    throw new IdentityUnavailableError(null, `backend entrypoint failed: ${String(err)}`);
  }
  return identityFromResponse(result.status, result.body);
}

function isIdentity(body: unknown): body is Identity {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Record<string, unknown>;
  return (
    typeof value.tenant_id === "string" &&
    typeof value.user_id === "string" &&
    (value.principal === "session" || value.principal === "token") &&
    typeof value.tenant_data_plane === "boolean" &&
    typeof value.email === "string" &&
    (value.csrf_token === undefined || typeof value.csrf_token === "string")
  );
}
