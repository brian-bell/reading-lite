import type { QueryClient } from "@tanstack/react-query";
import {
  settingsFromResponse,
  settingsSaveFromResponse,
  type SettingsBody,
  type SettingsResult,
  type SettingsSaveOutcome,
} from "../settings";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for notification settings (#340.6): same-origin
// /api/auth/settings with the session cookie, pinned to the account the page
// was rendered for, as the sessions list is (api/sessions.ts). The save sends
// the CSRF token, and its 403 is read twice for the same reason a revoke's is:
// CSRF is checked before the tenant pin.

export async function fetchSettings(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<SettingsResult> {
  const response = await apiFetch(queryClient, "/api/auth/settings", {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
  });
  return settingsFromResponse(response.status, await jsonOrNull(response));
}

export async function saveSettings(
  queryClient: QueryClient,
  body: SettingsBody,
  expectedTenant: string | undefined,
): Promise<SettingsSaveOutcome> {
  const response = await apiFetch(queryClient, "/api/auth/settings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: JSON.stringify(body),
  });
  const outcome = settingsSaveFromResponse(response.status, await jsonOrNull(response));
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
