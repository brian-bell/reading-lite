import { z } from "zod";
import type { AccountRead, AccountRefusal, AccountView } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";
import { submitFromResponse, type SubmitOutcome } from "./save";

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

export const DESK_INBOX_LIMIT = 5;

/** `shown` keeps the server's order. */
export type DeskInboxFold =
  | { kind: "pending" }
  | { kind: "empty" }
  | { kind: "blocked"; block: DeskInboxBlock }
  | { kind: "staged"; shown: readonly InboxItemMeta[]; total: number };

export type DeskInboxBlock =
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "offline" }
  | { kind: "error"; message: string };

/**
 * Whether the desk says it is empty.
 * `withheld` draws neither "Nothing needs you." nor On your desk.
 * `empty` is that sentence. `occupied` draws On your desk.
 */
export type DeskQuiet = "withheld" | "empty" | "occupied";

export function deskInboxFold(view: AccountView<InboxList>): DeskInboxFold {
  switch (view.kind) {
    case "loading":
      return { kind: "pending" };
    case "forbidden":
      return { kind: "blocked", block: { kind: "forbidden" } };
    case "account-changed":
      return {
        kind: "blocked",
        block: {
          kind: "account-changed",
          ...(view.actingTenant === undefined ? {} : { actingTenant: view.actingTenant }),
        },
      };
    case "server-error":
      return { kind: "blocked", block: { kind: "error", message: view.message } };
    case "offline":
      return view.value === undefined ? { kind: "blocked", block: { kind: "offline" } } : foldList(view.value);
    case "ready":
      return foldList(view.value);
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

function foldList(list: InboxList): DeskInboxFold {
  if (list.items.length === 0) return { kind: "empty" };
  return {
    kind: "staged",
    shown: list.items.slice(0, DESK_INBOX_LIMIT),
    total: list.items.length,
  };
}

export function deskQuietOf(
  groups: { needsYou: number; processing: number; onDesk: number; readySince: number },
  fold: DeskInboxFold,
): DeskQuiet {
  const groupsEmpty = groups.needsYou === 0 && groups.processing === 0 && groups.onDesk === 0 && groups.readySince === 0;
  if (!groupsEmpty) return "occupied";
  switch (fold.kind) {
    case "pending":
      return "withheld";
    case "empty":
      return "empty";
    case "staged":
    case "blocked":
      return "occupied";
    default: {
      const unreachable: never = fold;
      return unreachable;
    }
  }
}

export const InboxItemSchema = InboxItemMetaSchema.extend({ markdown: z.string() });
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** Account-scoped, so sign-in and sign-out drop both (auth/session.ts). */
export function inboxQueryKey(userId: string): readonly unknown[] {
  return ["inbox", userId];
}

export function inboxItemQueryKey(userId: string, id: string): readonly unknown[] {
  return ["inbox-item", userId, id];
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
export type PromoteOutcome =
  | (Extract<SubmitOutcome, { kind: "accepted" }> & { retained: boolean })
  | (Extract<SubmitOutcome, { kind: "existing" }> & { retained: boolean })
  | Exclude<SubmitOutcome, { kind: "accepted" | "existing" }>
  | { kind: "gone" }
  | { kind: "too-large" };

export function promoteFromResponse(status: number, body: unknown): PromoteOutcome {
  if (status === 404) return { kind: "gone" };
  if (status === 413) return { kind: "too-large" };
  const submitted = submitFromResponse(status, body);
  if (submitted.kind === "accepted" || submitted.kind === "existing") {
    return { ...submitted, retained: retainedOf(body) };
  }
  return submitted;
}

function retainedOf(body: unknown): boolean {
  return (
    typeof body === "object" && body !== null && "inbox_item_retained" in body && body.inbox_item_retained === true
  );
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

/** Whether a settled write leaves the cached list, keeps a newer stage, or changes nothing. */
export type InboxWriteEffect = "drop" | "retain" | "keep";

export function inboxWriteEffect(outcome: PromoteOutcome | DiscardOutcome): InboxWriteEffect {
  if (outcome.kind === "discarded" || outcome.kind === "gone") return "drop";
  if (outcome.kind === "accepted" || outcome.kind === "existing") return outcome.retained ? "retain" : "drop";
  return "keep";
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
