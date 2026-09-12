import type { QueryClient } from "@tanstack/react-query";
import { parseTurnstileSiteKey } from "../auth/turnstile";
import { apiFetch } from "./client";
import { apiErrorOf } from "./errors";

// Magic-link sign-in and sign-out, as web/src/api.ts calls them. Browser only.

export interface LoginOptions {
  turnstile_site_key: string | null;
}

/**
 * Sign-in options belong to no account, so `forgetAccount` keeps them across a
 * change of identity. Exported so the query and that exemption cannot drift
 * apart (#384 review).
 */
export const loginOptionsQueryKey = ["login-options"] as const;

const LOGIN_OPTIONS_FAILED = "failed to load sign-in options";

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export async function getLoginOptions(queryClient: QueryClient): Promise<LoginOptions> {
  const response = await apiFetch(queryClient, "/api/auth/login-options");
  if (!response.ok) throw await apiErrorOf(response, LOGIN_OPTIONS_FAILED);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(LOGIN_OPTIONS_FAILED);
  }
  if (body === null || typeof body !== "object" || !("turnstile_site_key" in body)) {
    throw new Error(LOGIN_OPTIONS_FAILED);
  }
  return { turnstile_site_key: parseTurnstileSiteKey((body as { turnstile_site_key: unknown }).turnstile_site_key) };
}

export async function requestLoginLink(
  queryClient: QueryClient,
  email: string,
  turnstileToken?: string | null,
): Promise<void> {
  const token = turnstileToken?.trim();
  const response = await apiFetch(
    queryClient,
    "/api/auth/challenge",
    jsonPost(token ? { email, turnstile_token: token } : { email }),
  );
  if (!response.ok) throw await apiErrorOf(response, "failed to request sign-in link");
}

/** Sets the session cookie on success. The caller reloads identity. */
export async function redeemLoginLink(queryClient: QueryClient, credential: string, redemptionId: string): Promise<void> {
  const response = await apiFetch(
    queryClient,
    "/api/auth/redeem",
    jsonPost({ credential, redemption_id: redemptionId }),
  );
  if (!response.ok) throw await apiErrorOf(response, "failed to complete sign-in");
}

export async function logoutSession(queryClient: QueryClient): Promise<void> {
  const response = await apiFetch(queryClient, "/api/auth/logout", jsonPost({}));
  // 401: the session is already gone; the backend still expires the cookie.
  if (response.status === 401) return;
  if (!response.ok) throw await apiErrorOf(response, "failed to sign out");
}
