// Promoting an inbox item into the corpus (reading-lite-gh423.2). HTTP-free,
// like stage: the router maps the outcome onto a status.
//
// Promote loads the item and hands its Markdown to ReadingIntake.importMarkdown,
// the same verb REST import-markdown uses, so the item becomes a reading
// exactly as an import would: a new URL is claimed, a ready or pending owner
// is returned, and a failed owner is re-imported in place. The request rate
// and the reading quota are charged here, not at stage. No transaction is held
// across the import: the item row is read once, before it, and deleted once,
// after it.
//
// The item is deleted only when the import activated or found an existing
// owner. Either way the corpus now has the URL, and a later promote of the
// same item would only return that owner, which is also how a promote that
// crashed between the import and the delete is finished. The delete is
// conditional on the version loaded (deleteIfUnchanged): Markdown re-staged
// in between stays for a person to review, and the response says so. Every
// other outcome keeps the item for another try.
//
// Stage measured the item against the promote message with the owner it saw
// then. An untitled item promoted over a failed owner carries that owner's
// title (src/modules/manifest-drafting.ts), and the owner may have failed, or
// retitled, since. So promote measures again, inside the import, against the
// message it actually builds, before anything is written.

import type { ImportMarkdownOptions, IntakeOutcome, ReadingIntake } from "../intake";
import type { PgInboxStore } from "../modules/stores/postgres/inbox-store";
import { INBOX_STAGE_BUDGET_BYTES } from "../schemas/api";
import { inboxMessageBytes } from "./stage";

export type InboxPromoteOutcome =
  | { kind: "not_found" }
  | { kind: "intake"; itemId: string; intake: IntakeOutcome; retained: boolean };

export interface InboxPromoteDeps {
  inbox: Pick<PgInboxStore, "get" | "deleteIfUnchanged">;
  intake: Pick<ReadingIntake, "importMarkdown">;
}

const fitsMessage: ImportMarkdownOptions["fitsMessage"] = (fields) =>
  inboxMessageBytes(fields) <= INBOX_STAGE_BUDGET_BYTES;

export async function promoteInboxItem(
  deps: InboxPromoteDeps,
  id: string,
  opts: { email: boolean },
): Promise<InboxPromoteOutcome> {
  const item = await deps.inbox.get(id);
  if (!item) return { kind: "not_found" };

  const intake = await deps.intake.importMarkdown(item.url, item.markdown, {
    ...(item.title === null ? {} : { title: item.title }),
    email: opts.email,
    fitsMessage,
  });
  if (intake.kind !== "activated" && intake.kind !== "existing") {
    return { kind: "intake", itemId: item.id, intake, retained: false };
  }
  // "missing" is a concurrent discard or promote: the item is gone either way.
  const deleted = await deps.inbox.deleteIfUnchanged(item.id, item.updated_at);
  return { kind: "intake", itemId: item.id, intake, retained: deleted === "changed" };
}
