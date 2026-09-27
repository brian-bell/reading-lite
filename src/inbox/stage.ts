// Staging Markdown into the tenant's inbox (reading-lite-gh423). HTTP-free,
// like reading intake: the router parses and size-checks the body, then maps
// the outcome onto a status.
//
// Stage writes only the inbox row. It claims no URL, creates no reading,
// attempt, job or embedding, sends no queue message and reserves no reading
// slot: the reading quota and the paid work are charged at promote. It is
// charged one request against the ingress rate, as every write verb is.
//
// Before writing, stage asks the corpus who owns the URL, read-only and with
// the same resolution /lookup and importMarkdown use: a ready or pending owner
// already has the content, so nothing is staged, any item staged for the URL
// earlier is discarded, and the reading is returned; a failed owner is named
// on the new item, because promoting it re-imports that reading in place.
// The check is not in the stage transaction. A claim that commits between the
// two leaves an item for an owned URL, which is harmless: its promote finds
// the owner and returns it.
//
// Promote carries the item in one queue message, so an item must fit
// INBOX_STAGE_BUDGET_BYTES. The router measures the body before admitting the
// request; stage measures again once it knows the owner, because promoting an
// untitled item over a failed owner keeps that owner's title
// (src/modules/manifest-drafting.ts) and the title rides in the message.

import type { TenantUsage } from "../control-plane/tenant-usage-guard";
import { nowMs, usageDenial, type UsageDenial } from "../intake";
import { applyStaleness } from "../modules/staleness";
import type { PgInboxStore } from "../modules/stores/postgres/inbox-store";
import type { PgReadingStore } from "../modules/stores/postgres/reading-store";
import { INBOX_STAGE_BUDGET_BYTES, type InboxItemMeta } from "../schemas/api";
import type { Manifest } from "../schemas/manifest";
import type { Services } from "../services";

export type InboxStageOutcome =
  | { kind: "staged"; item: InboxItemMeta; replaced: boolean; corpusReading?: { id: string; status: "failed" } }
  | { kind: "existing"; manifest: Manifest }
  | { kind: "inbox_full" }
  | { kind: "too_large" }
  | UsageDenial
  | { kind: "tenant_inactive" };

export interface InboxStageDeps {
  inbox: Pick<PgInboxStore, "stage" | "discardUrl">;
  store: Pick<PgReadingStore, "findOwnerByUrl" | "loadReadingById">;
  usage: Pick<TenantUsage, "admitRequest">;
  services: Pick<Services, "now">;
  pendingTtlSeconds: number;
}

// What an item costs in the promote message: the forwarded fields' JSON
// serialization, in UTF-8 bytes. The router passes the whole parsed body, so a
// field added to it is measured there without being named; the owner-aware
// check below spells the fields promote forwards and must name any new one.
export function inboxMessageBytes(fields: { source_url: string; title?: string; markdown: string }): number {
  return new TextEncoder().encode(JSON.stringify(fields)).byteLength;
}

export async function stageInboxItem(
  deps: InboxStageDeps,
  input: { url: string; markdown: string; title?: string },
): Promise<InboxStageOutcome> {
  const denied = usageDenial(await deps.usage.admitRequest(nowMs(deps.services)), deps.services);
  if (denied) return denied;

  // An owner purged between the lookup and the load no longer owns the URL.
  const owner = await deps.store.findOwnerByUrl(input.url);
  const found = owner ? await deps.store.loadReadingById(owner.id) : null;
  let corpusReading: { id: string; status: "failed" } | undefined;
  if (found) {
    const effective = applyStaleness(found.manifest, deps.pendingTtlSeconds, deps.services.now());
    if (effective.status !== "failed") {
      // An item staged before this owner existed could only promote into it.
      await deps.inbox.discardUrl(input.url);
      return { kind: "existing", manifest: effective };
    }
    corpusReading = { id: effective.id, status: "failed" };
    const title = input.title ?? effective.title;
    const promoted = { source_url: input.url, ...(title === undefined ? {} : { title }), markdown: input.markdown };
    if (inboxMessageBytes(promoted) > INBOX_STAGE_BUDGET_BYTES) return { kind: "too_large" };
  }

  const staged = await deps.inbox.stage(input);
  if (staged.kind !== "staged") return staged;
  return { ...staged, ...(corpusReading ? { corpusReading } : {}) };
}
