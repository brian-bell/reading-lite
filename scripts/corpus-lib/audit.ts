import { classifyPending, dedupeByUrl, shortUrl, siblingStatuses } from "./classify";
import { reasonForFailure } from "./reason";
import type { AuditRow, ListItem } from "./types";

export function buildFailedRows(items: ListItem[]): AuditRow[] {
  const failed = items.filter((i) => i.status === "failed");
  return dedupeByUrl(failed)
    .map(({ rep, count }) => ({
      category: "failed" as const,
      url: rep.url,
      short: shortUrl(rep.url),
      reading_id: rep.id,
      key_prefix: rep.key_prefix,
      attempts: count,
      code: rep.error?.code ?? "?",
      stage: rep.error?.stage ?? "—",
      message: rep.error?.message ?? "",
      reason: reasonForFailure(rep.error?.code, rep.error?.message, rep.url),
    }))
    .sort((a, b) => (a.reason ?? "").localeCompare(b.reason ?? "") || a.short.localeCompare(b.short));
}

export function buildPendingRows(items: ListItem[], nowMs: number): AuditRow[] {
  const siblings = siblingStatuses(items);
  const pending = items.filter((i) => i.status === "pending");
  return dedupeByUrl(pending)
    .map(({ rep, count }) => ({
      category: "pending" as const,
      url: rep.url,
      short: shortUrl(rep.url),
      reading_id: rep.id,
      key_prefix: rep.key_prefix,
      attempts: count,
      class: classifyPending(rep.url, siblings),
      stuck_stage: rep.active_attempt?.stage ?? "?",
      trigger: rep.active_attempt?.trigger ?? rep.last_attempt?.trigger ?? "?",
      age_days: Math.round((nowMs - Date.parse(rep.created_at)) / 86_400_000),
    }))
    .sort((a, b) => (a.class ?? "").localeCompare(b.class ?? "") || (b.age_days ?? 0) - (a.age_days ?? 0));
}

export interface StatusTally {
  ready: number;
  pending: number;
  failed: number;
  other: number;
}

export function tallyStatuses(items: ListItem[]): StatusTally {
  const t: StatusTally = { ready: 0, pending: 0, failed: 0, other: 0 };
  for (const it of items) {
    if (it.status === "ready") t.ready++;
    else if (it.status === "pending") t.pending++;
    else if (it.status === "failed") t.failed++;
    else t.other++;
  }
  return t;
}

// For monitoring a recovery batch: status of a specific set of reading ids.
export function tallyByIds(items: ListItem[], ids: string[]): {
  ready: number;
  pending: number;
  failed: number;
  absent: number;
} {
  const byId = new Map(items.map((i) => [i.id, i.status]));
  const t = { ready: 0, pending: 0, failed: 0, absent: 0 };
  for (const id of ids) {
    const s = byId.get(id);
    if (s === "ready") t.ready++;
    else if (s === "pending") t.pending++;
    else if (s === "failed") t.failed++;
    else t.absent++;
  }
  return t;
}
