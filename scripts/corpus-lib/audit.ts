import { classifyPending, dedupeByUrl, shortUrl, siblingStatuses } from "./classify";
import { reasonForFailure } from "./reason";
import type { AuditRow, ListItem } from "./types";

// Mirrors PENDING_TTL_SECONDS (900s, see wrangler.toml): below this a pending
// may still be in-flight or backing off, so we don't treat it as stranded.
export const STRANDED_AFTER_MS = 900_000;

function failedRow(rep: ListItem, count: number): AuditRow {
  return {
    category: "failed",
    url: rep.url,
    short: shortUrl(rep.url),
    reading_id: rep.id,
    key_prefix: rep.key_prefix,
    attempts: count,
    code: rep.error?.code ?? "?",
    stage: rep.error?.stage ?? "—",
    message: rep.error?.message ?? "",
    reason: reasonForFailure(rep.error?.code, rep.error?.message, rep.url),
  };
}

const byReasonThenUrl = (a: AuditRow, b: AuditRow) =>
  (a.reason ?? "").localeCompare(b.reason ?? "") || a.short.localeCompare(b.short);

// Real, actionable failures: a failed url with NO ready copy. A url that also
// has a ready reading is excluded here and surfaced by buildFailedOrphanDupRows
// instead — recovery would be pointless (the content is already in the corpus).
export function buildFailedRows(items: ListItem[]): AuditRow[] {
  const siblings = siblingStatuses(items);
  const failed = items.filter((i) => i.status === "failed");
  return dedupeByUrl(failed)
    .filter(({ rep }) => !siblings.get(rep.url)?.has("ready"))
    .map(({ rep, count }) => failedRow(rep, count))
    .sort(byReasonThenUrl);
}

// Cosmetic cruft: failed copies of a url that already has a ready reading
// (e.g. earlier failed attempts left behind after a later success, or a
// re-submit that lost a fetch race). The ready copy owns the by-url pointer +
// embedding, so these are safe to drop via corpus-drop — not to recover.
export function buildFailedOrphanDupRows(items: ListItem[]): AuditRow[] {
  const siblings = siblingStatuses(items);
  const failed = items.filter((i) => i.status === "failed");
  return dedupeByUrl(failed)
    .filter(({ rep }) => siblings.get(rep.url)?.has("ready"))
    .map(({ rep, count }) => ({ ...failedRow(rep, count), class: "orphan-dup" as const }))
    .sort(byReasonThenUrl);
}

export function buildPendingRows(
  items: ListItem[],
  nowMs: number,
  strandedAfterMs: number = STRANDED_AFTER_MS,
): AuditRow[] {
  const siblings = siblingStatuses(items);
  const pending = items.filter((i) => i.status === "pending");
  return dedupeByUrl(pending)
    .map(({ rep, count }) => {
      // Prefer updated_at — same staleness reference the API uses (router.ts
      // annotateStale) so a row mid-retry isn't mistaken for stranded.
      const ageMs = nowMs - Date.parse(rep.updated_at ?? rep.created_at);
      return {
        category: "pending" as const,
        url: rep.url,
        short: shortUrl(rep.url),
        reading_id: rep.id,
        key_prefix: rep.key_prefix,
        attempts: count,
        class: classifyPending(rep.url, siblings, ageMs > strandedAfterMs),
        stuck_stage: rep.active_attempt?.stage ?? "?",
        trigger: rep.active_attempt?.trigger ?? rep.last_attempt?.trigger ?? "?",
        age_days: Math.round((nowMs - Date.parse(rep.created_at)) / 86_400_000),
      };
    })
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
