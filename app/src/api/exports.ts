import type { QueryClient } from "@tanstack/react-query";
import {
  exportRequestFromResponse,
  latestExportFromResponse,
  type ExportRequestOutcome,
  type ExportsResult,
} from "../archive-export";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the archive export (reading-lite-mxwx.5): same-origin
// /api/exports with the session cookie, pinned to the account the page was
// rendered for, as the tokens are (api/tokens.ts). The routes are
// session-only and need no recent sign-in. The request sends the CSRF token,
// and its 403 is read twice for the same reason a token write's is: CSRF is
// checked before the tenant pin. The download is not here: it is a plain
// link (archive-export.ts `exportDownloadHref`), so a large archive streams
// to disk instead of into page memory.

function pin(expectedTenant: string | undefined): HeadersInit {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

export async function fetchLatestExport(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<ExportsResult> {
  const response = await apiFetch(queryClient, "/api/exports/latest", { headers: pin(expectedTenant) });
  return latestExportFromResponse(response.status, await jsonOrNull(response));
}

export async function requestExport(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<ExportRequestOutcome> {
  const response = await apiFetch(queryClient, "/api/exports", { method: "POST", headers: pin(expectedTenant) });
  const outcome = exportRequestFromResponse(response.status, await jsonOrNull(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Non-JSON: the caller decides from the status.
    return null;
  }
}
