/** A non-2xx API response. The status decides the state shown (acceptance matrix, Common states). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
