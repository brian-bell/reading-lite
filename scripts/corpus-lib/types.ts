// Shape of an item in the corpus list index (index/list.json). Mirrors a
// subset of ListIndexItem (src/schemas/api.ts) — only the fields the corpus
// health tooling reads. Kept hand-typed so scripts don't import worker code.
export interface ListItem {
  id: string;
  url: string;
  status: "ready" | "pending" | "failed" | string;
  created_at: string;
  updated_at?: string;
  key_prefix: string;
  title?: string;
  error?: { code?: string; stage?: string; message?: string };
  active_attempt?: { stage?: string; trigger?: string; status?: string };
  last_attempt?: { stage?: string; trigger?: string };
  enrichment_degradation?: {
    source?: string;
    tier?: string;
    code?: string;
    message?: string;
  };
}

export type AuditCategory = "failed" | "pending" | "teaser" | "degraded";
export type PendingClass = "stranded" | "orphan-dup" | "fresh";
// Hand-typed copy of ProcessingAttemptTrigger — corpus-lib does not import worker schemas.
export type AttemptTrigger = "submit" | "reprocess" | "import";

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
  last_attempt_trigger?: AttemptTrigger;
  // pending
  class?: PendingClass;
  stuck_stage?: string;
  trigger?: string;
  age_days?: number;
  // teaser
  title?: string;
}

export type RecoveryAction = "reprocess" | "local-extract" | "skip" | "none";
