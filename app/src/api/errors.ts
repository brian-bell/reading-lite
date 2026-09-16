/** A non-2xx API response. The status decides the state shown (acceptance matrix, Common states). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * `fetch` itself failed, so there was no response. `offline` is what the
 * browser said at the time: whether the failure reads as offline is decided
 * when it happens, not when the page next renders (#416).
 */
export class NetworkError extends Error {
  readonly offline: boolean;

  constructor(cause: unknown, offline: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "NetworkError";
    this.offline = offline;
  }
}

/** 401 means the session ended. 403 is permission denied and never a sign-out. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** The backend's `{ "error": … }` message, or `fallback` for any other body. */
export async function errorMessageOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    if (body && typeof body.error === "string" && body.error !== "") return body.error;
  } catch {
    // Non-JSON body.
  }
  return fallback;
}

export async function apiErrorOf(response: Response, fallback: string): Promise<ApiError> {
  return new ApiError(response.status, await errorMessageOf(response, fallback));
}
