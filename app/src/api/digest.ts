import type { QueryClient } from "@tanstack/react-query";
import { digestPreviewFromResponse, type DigestPreviewResult } from "../digest-preview";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the digest preview (reading-lite-kl7y.10): same-origin
// /api/digest/preview with the session cookie, pinned to the account the page
// was rendered for, as the desk's read is (api/desk.ts).

export async function fetchDigestPreview(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
  signal?: AbortSignal,
): Promise<DigestPreviewResult> {
  const response = await apiFetch(queryClient, "/api/digest/preview", {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: the status decides.
  }
  return digestPreviewFromResponse(response.status, body);
}
