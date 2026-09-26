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
// already has the content, so nothing is staged and the reading is returned;
// a failed owner is named on the new item, because promoting it re-imports
// that reading in place. The check is not in the stage transaction. A claim
// that commits between the two leaves an item for an owned URL, which is
// harmless: its promote finds the owner and returns it.

import type { TenantUsage } from "../control-plane/tenant-usage-guard";
import { applyStaleness } from "../modules/staleness";
import type { PgInboxStore } from "../modules/stores/postgres/inbox-store";
import type { PgReadingStore } from "../modules/stores/postgres/reading-store";
import type { InboxItemMeta } from "../schemas/api";
import type { Manifest } from "../schemas/manifest";
import type { Services } from "../services";

export type InboxStageOutcome =
  | { kind: "staged"; item: InboxItemMeta; replaced: boolean; corpusReading?: { id: string; status: "failed" } }
  | { kind: "existing"; manifest: Manifest }
  | { kind: "inbox_full" }
  | { kind: "rate_limited"; limit: "request_rate"; resetAtMs: number }
  | { kind: "guard_unavailable" }
  | { kind: "tenant_inactive" };

export interface InboxStageDeps {
  inbox: Pick<PgInboxStore, "stage">;
  store: Pick<PgReadingStore, "findOwnerByUrl" | "loadReadingById">;
  usage: Pick<TenantUsage, "admitRequest">;
  services: Pick<Services, "now">;
  pendingTtlSeconds: number;
}

export async function stageInboxItem(
  deps: InboxStageDeps,
  input: { url: string; markdown: string; title?: string },
): Promise<InboxStageOutcome> {
  const now = deps.services.now();
  const nowMs = Date.parse(now);
  const admitted = await deps.usage.admitRequest(nowMs);
  if (!admitted.ok) {
    return admitted.reason === "request_rate"
      ? { kind: "rate_limited", limit: "request_rate", resetAtMs: admitted.resetAtMs ?? nowMs }
      : { kind: "guard_unavailable" };
  }

  // An owner purged between the lookup and the load no longer owns the URL.
  const owner = await deps.store.findOwnerByUrl(input.url);
  const found = owner ? await deps.store.loadReadingById(owner.id) : null;
  let corpusReading: { id: string; status: "failed" } | undefined;
  if (found) {
    const effective = applyStaleness(found.manifest, deps.pendingTtlSeconds, now);
    if (effective.status !== "failed") return { kind: "existing", manifest: effective };
    corpusReading = { id: effective.id, status: "failed" };
  }

  const staged = await deps.inbox.stage(input);
  if (staged.kind !== "staged") return staged;
  return { ...staged, ...(corpusReading ? { corpusReading } : {}) };
}
