import type { QueryClient } from "@tanstack/react-query";
import {
  keyConnectFromResponse,
  keyRemoveFromResponse,
  preferencesSaveFromResponse,
  providerFromResponse,
  usageFromResponse,
  type KeyConnectOutcome,
  type KeyRemoveOutcome,
  type PreferencesBody,
  type PreferencesSaveOutcome,
  type ProviderResult,
  type ProviderUsageResult,
} from "../provider";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for provider settings (reading-lite-gh341.8): same-origin
// /api/auth/provider with the session cookie, pinned to the account the page
// was rendered for, as the notification settings are (api/settings.ts). The
// routes are session-only, so a bearer token gets 403, and a mismatched pin
// answers 412. Writes send the CSRF token, and a write's plain 403 is read
// twice for the same reason a session revoke's is: CSRF is checked before the
// tenant pin. The key travels only in the connect request's body.

function pin(expectedTenant: string | undefined): Record<string, string> {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

export async function fetchProvider(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<ProviderResult> {
  const response = await apiFetch(queryClient, "/api/auth/provider", { headers: pin(expectedTenant) });
  return providerFromResponse(response.status, await jsonOrNull(response));
}

export async function fetchProviderUsage(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<ProviderUsageResult> {
  const response = await apiFetch(queryClient, "/api/auth/provider/usage", { headers: pin(expectedTenant) });
  return usageFromResponse(response.status, await jsonOrNull(response));
}

export async function connectProviderKey(
  queryClient: QueryClient,
  apiKey: string,
  expectedTenant: string | undefined,
): Promise<KeyConnectOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/provider", {
    method: "POST",
    headers: { "content-type": "application/json", ...pin(expectedTenant) },
    body: JSON.stringify({ api_key: apiKey }),
  });
  const outcome = keyConnectFromResponse(response.status, await jsonOrNull(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

export async function removeProviderKey(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<KeyRemoveOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/provider", {
    method: "DELETE",
    headers: pin(expectedTenant),
  });
  const outcome = keyRemoveFromResponse(response.status, await jsonOrNull(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

export async function saveProviderPreferences(
  queryClient: QueryClient,
  body: PreferencesBody,
  expectedTenant: string | undefined,
): Promise<PreferencesSaveOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/provider/preferences", {
    method: "POST",
    headers: { "content-type": "application/json", ...pin(expectedTenant) },
    body: JSON.stringify(body),
  });
  const outcome = preferencesSaveFromResponse(response.status, await jsonOrNull(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Non-JSON: the status decides.
    return null;
  }
}
