import type { QueryClient } from "@tanstack/react-query";
import type { MarkdownImportBody } from "../import-markdown";
import { submitFromResponse, type SubmitOutcome } from "../save";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for saving a URL (#431) and importing Markdown (#408):
// same-origin POST /api/readings or /api/readings/import-markdown with the
// session cookie and the CSRF token (ADR 0003), pinned to the account the page
// was rendered for, as the library's reads are. Both answer with the same
// intake outcomes (src/router.ts `respondIntake`), read by submitFromResponse.
// There is no server-render path: a save is a write the reader makes, never
// part of rendering a page.
//
// A 403 is read twice. The backend checks the CSRF token before the tenant
// pin (src/middleware.ts), so when another tab has signed in as someone else
// the cached token no longer matches the cookie and the answer is 403, never
// the 412 the pin would have given a read. Only whoever is signed in now tells
// a switched account from a real refusal, so the page asks, as signOut does
// for a refused logout (auth/session.ts).

export function submitReading(
  queryClient: QueryClient,
  url: string,
  expectedTenant: string | undefined,
): Promise<SubmitOutcome> {
  return postCapture(queryClient, "/api/readings", { url }, expectedTenant);
}

export function importMarkdown(
  queryClient: QueryClient,
  body: MarkdownImportBody,
  expectedTenant: string | undefined,
): Promise<SubmitOutcome> {
  return postCapture(queryClient, "/api/readings/import-markdown", body, expectedTenant);
}

async function postCapture(
  queryClient: QueryClient,
  path: string,
  payload: object,
  expectedTenant: string | undefined,
): Promise<SubmitOutcome> {
  const response = await apiFetch(queryClient, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant }),
    },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: submitFromResponse decides from the status.
  }
  const outcome = submitFromResponse(response.status, body);
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
