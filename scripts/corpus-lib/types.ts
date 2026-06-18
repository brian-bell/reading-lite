// Shape of an item in the corpus list index (index/list.json). Mirrors a
// subset of ListIndexItem (src/schemas/api.ts) — only the fields the corpus
// health tooling reads. Kept hand-typed so scripts don't import worker code.
export interface ListItem {
  id: string;
  url: string;
  status: "ready" | "pending" | "failed" | string;
  created_at: string;
  key_prefix: string;
  title?: string;
  error?: { code?: string; stage?: string; message?: string };
  active_attempt?: { stage?: string; trigger?: string; status?: string };
  last_attempt?: { stage?: string; trigger?: string };
}

export type AuditCategory = "failed" | "pending" | "teaser";
export type PendingClass = "stranded" | "orphan-dup";

// One row of the audit inventory — also the unit corpus-recover consumes.
export interface AuditRow {
  category: AuditCategory;
  url: string;
  short: string;
  reading_id: string;
  key_prefix: string;
  attempts: number;
  // failed
  code?: string;
  stage?: string;
  message?: string;
  reason?: string;
  // pending
  class?: PendingClass;
  stuck_stage?: string;
  trigger?: string;
  age_days?: number;
  // teaser
  title?: string;
}

export type RecoveryAction = "reprocess" | "local-extract" | "skip" | "none";
