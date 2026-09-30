import type { QueryClient } from "@tanstack/react-query";
import {
  discardFromResponse,
  inboxItemFromResponse,
  inboxListFromResponse,
  promoteFromResponse,
  type DiscardOutcome,
  type InboxItemResult,
  type InboxListResult,
  type PromoteOutcome,
} from "../inbox";
import { postCapture } from "./capture";
import { apiFetch, forbiddenOrSwitched } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for the inbox (reading-lite-fy8t): same-origin /api/inbox with
// the session cookie (ADR 0003), pinned to the account the page was rendered
// for like the library's reads; the backend enforces that pin on
// /api/inbox… (`requireExpectedTenant`). There is no server-render path.
//
// Promote is a capture write: it goes through the shared capture request
// (api/capture.ts), so its 403 is read twice as a save's is. Discard reads its
// 403 the same way.

function pin(expectedTenant: string | undefined): HeadersInit {
  return expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant };
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Non-JSON (a 204 among them): the mapping decides from the status.
    return null;
  }
}

export async function fetchInbox(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
): Promise<InboxListResult> {
  const response = await apiFetch(queryClient, "/api/inbox", { headers: pin(expectedTenant) });
  return inboxListFromResponse(response.status, await bodyOf(response));
}

export async function fetchInboxItem(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<InboxItemResult> {
  const response = await apiFetch(queryClient, `/api/inbox/${encodeURIComponent(id)}`, {
    headers: pin(expectedTenant),
  });
  return inboxItemFromResponse(response.status, await bodyOf(response));
}

/** Adds the item to the library. The body is empty: a promote never asks for the completion email. */
export function promoteInboxItem(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<PromoteOutcome> {
  return postCapture(
    queryClient,
    `/api/inbox/${encodeURIComponent(id)}/promote`,
    {},
    expectedTenant,
    promoteFromResponse,
  );
}

export async function discardInboxItem(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<DiscardOutcome> {
  const response = await apiFetch(queryClient, `/api/inbox/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: pin(expectedTenant),
  });
  const outcome = discardFromResponse(response.status, await bodyOf(response));
  return outcome.kind === "forbidden" ? forbiddenOrSwitched(queryClient) : outcome;
}
