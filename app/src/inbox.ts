import { z } from "zod";
import type { AccountRead, AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";
import { submitFromResponse, type SubmitOutcome } from "./save";

// The Markdown inbox (reading-lite-fy8t, follow-up to reading-lite-gh423):
// Markdown an agent staged over MCP waits in the reader's inbox until they
// add it to the library or discard it. The REST routes are GET /api/inbox,
// GET /api/inbox/:id, POST /api/inbox/:id/promote, and DELETE
// /api/inbox/:id (docs/api.md, Inbox routes). Pure, so every mapping is
// tested without a DOM; api/inbox.ts does the requests and InboxPage.tsx and
// InboxItemPage.tsx render what comes out.
//
// Everything here is read in the browser only, as the account page's lists
// are (ADR 0003): the inbox is never part of the server render, so nothing
// the backend's FrontendReads entrypoint exposes has to change for it.
//
// The projections are loose like the reading's: only what the pages show is
// declared, unknown fields pass through, and a malformed field this app reads
// is the retryable "unexpected body" error rather than a crash in a component.

export const InboxItemMetaSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string().nullable(),
  markdown_bytes: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type InboxItemMeta = z.infer<typeof InboxItemMetaSchema>;

export const InboxListSchema = z.looseObject({ items: z.array(InboxItemMetaSchema) });
export interface InboxList {
  items: InboxItemMeta[];
}

export const InboxItemSchema = InboxItemMetaSchema.extend({ markdown: z.string() });
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** Account-scoped, so sign-in and sign-out drop both (auth/session.ts). */
export function inboxQueryKey(userId: string): readonly unknown[] {
  return ["inbox", userId];
}

export function inboxItemQueryKey(userId: string, id: string): readonly unknown[] {
  return ["inbox", userId, id];
}

/**
 * What GET /api/inbox answered. 403 and 412 are values, as they are for the
 * library and the account page, so the page renders the shared state; a 401
 * and anything unexpected throw.
 */
export type InboxListResult = AccountRead<InboxList>;

export function inboxListFromResponse(status: number, body: unknown): InboxListResult {
  if (status === 200) {
    const parsed = InboxListSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "inbox returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `inbox returned ${status}`);
}

/**
 * What GET /api/inbox/:id answered: the list's values, plus 404 for an item
 * that is not (or no longer) in this reader's inbox — promoted or discarded
 * from another tab, or by the agent that staged it.
 */
export type InboxItemResult = AccountRead<InboxItem> | { state: "not-found" };

export function inboxItemFromResponse(status: number, body: unknown): InboxItemResult {
  if (status === 404) return { state: "not-found" };
  if (status === 200) {
    const parsed = InboxItemSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "inbox item returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `inbox item returned ${status}`);
}

/**
 * What POST /api/inbox/:id/promote answered. Promote imports the item exactly
 * as POST /api/readings/import-markdown would and answers with that route's
 * status and body (plus `inbox_item_id`), so every intake outcome is read by
 * the save page's own `submitFromResponse`: a 202 or 200 opens the reading,
 * the 409 and the 429/503 refusals are notices, and 403/412 the shared
 * states. Promote adds two of its own:
 *
 * - 404: the item is gone, promoted or discarded elsewhere meanwhile.
 * - 413: the promote message would exceed the queue's budget, which happens
 *   only when an untitled item's failed owner lends it a title stage did not
 *   count. Asking again gets the same answer, so it offers nothing.
 */
export type PromoteOutcome = SubmitOutcome | { kind: "gone" } | { kind: "too-large" };

export function promoteFromResponse(status: number, body: unknown): PromoteOutcome {
  if (status === 404) return { kind: "gone" };
  if (status === 413) return { kind: "too-large" };
  return submitFromResponse(status, body);
}

/**
 * What DELETE /api/inbox/:id answered. A 404 is an item already gone, which
 * is what the reader asked for, so it reads as discarded.
 */
export type DiscardOutcome = { kind: "discarded" } | AccountRefusal;

export function discardFromResponse(status: number, body: unknown): DiscardOutcome {
  if (status === 204 || status === 404) return { kind: "discarded" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `discard returned ${status}`);
}

/** What an item is called: its title, or its URL when the agent gave none. */
export function inboxItemName(item: Pick<InboxItemMeta, "title" | "url">): string {
  return item.title ?? item.url;
}

/** The staged Markdown's size, as the reader reads sizes: "840 bytes", "12 KB". */
export function inboxItemSize(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  return `${Math.round(bytes / 1024)} KB`;
}
