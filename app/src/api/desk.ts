import type { QueryClient } from "@tanstack/react-query";
import { deskFromResponse, deskWriteFromResponse, type DeskResult, type DeskWriteOutcome } from "../desk";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the desk: same-origin /api/desk with the session cookie
// and CSRF token (ADR 0003), pinned to the account the page was rendered
// for. A write's 403 is read twice, as a capture's is (api/capture.ts): the
// CSRF check runs before the pin, so a tab another account signed in to gets
// 403, and only whoever is signed in now tells the two apart.

function pinOf(expectedTenant: string | undefined): Record<string, string> {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Non-JSON: the mapping decides from the status.
    return null;
  }
}

export async function fetchDesk(
  queryClient: QueryClient,
  since: string | undefined,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
): Promise<DeskResult> {
  const path = since === undefined ? "/api/desk" : `/api/desk?since=${encodeURIComponent(since)}`;
  const response = await apiFetch(queryClient, path, {
    headers: pinOf(expectedTenant),
    ...(signal === undefined ? {} : { signal }),
  });
  return deskFromResponse(response.status, await bodyOf(response));
}

export async function writeDesk(
  queryClient: QueryClient,
  id: string,
  put: boolean,
  expectedTenant: string | undefined,
): Promise<DeskWriteOutcome> {
  const pin = pinOf(expectedTenant);
  const response = await apiFetch(
    queryClient,
    put ? "/api/desk" : `/api/desk/${encodeURIComponent(id)}`,
    put
      ? { method: "POST", headers: { "content-type": "application/json", ...pin }, body: JSON.stringify({ id }) }
      : { method: "DELETE", headers: pin },
  );
  const outcome = deskWriteFromResponse(response.status, await bodyOf(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

/** DELETE /api/desk: every reading off the desk. */
export async function clearDesk(queryClient: QueryClient, expectedTenant: string | undefined): Promise<DeskWriteOutcome> {
  const response = await apiFetch(queryClient, "/api/desk", { method: "DELETE", headers: pinOf(expectedTenant) });
  const outcome = deskWriteFromResponse(response.status, await bodyOf(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
