import { httpStatusFromMessage } from "./reason";
import type { AuditRow, RecoveryAction } from "./types";

export interface ActionDecision {
  action: RecoveryAction;
  why: string;
}

// The triage policy table: maps an audited non-ready reading to a recovery
// action. Kept here (in the skill) on purpose — it's the editable contract for
// how corpus-recover treats each failure class.
//
//   reprocess      re-run the pipeline via POST /readings/:id/reprocess (force)
//   local-extract  fetch locally with a browser UA, re-import as markdown
//   skip           record only — permanently unrecoverable this way
//   none           no content action needed (cosmetic dup)
export function recoveryAction(row: AuditRow): ActionDecision {
  if (row.category === "teaser") return { action: "skip", why: "paywall teaser — only preview content" };

  // An orphan-dup (pending or failed) shares a url with a ready reading — the
  // content is already in the corpus, so there's nothing to recover. It's a
  // corpus-drop candidate, not a corpus-recover one.
  if (row.class === "orphan-dup") return { action: "none", why: "url already has a ready reading (cosmetic dup)" };

  if (row.category === "pending") {
    if (row.class === "fresh") return { action: "none", why: "pending within TTL — likely still in-flight" };
    return { action: "reprocess", why: "stranded — never completed; re-run pipeline" };
  }

  // failed
  const reason = row.reason ?? "";
  if (/not an article|PDF|YouTube/i.test(reason)) return { action: "skip", why: "not an article (PDF/video)" };
  if (/reddit/i.test(reason)) return { action: "skip", why: "reddit — needs .json endpoint, not handled" };
  if (/teaser/i.test(reason)) return { action: "skip", why: "paywall teaser" };

  switch (row.code) {
    case "BadToolInputError":
      return { action: "reprocess", why: "summarize hiccup — re-run" };
    case "FetchTimeoutError":
      return { action: "reprocess", why: "transient fetch timeout" };
    case "OversizedResponseError":
      return { action: "local-extract", why: "retry locally (article body usually < cap once extracted)" };
    case "BadStatusError": {
      const s = httpStatusFromMessage(row.message);
      if (s === 404 || s === 410) return { action: "skip", why: `dead link (HTTP ${s})` };
      if (s === 401 || s === 402 || s === 451) return { action: "skip", why: `paywalled/blocked (HTTP ${s})` };
      if (s === 403 || s === 429) return { action: "local-extract", why: `fetch blocked (HTTP ${s}) — try local browser fetch` };
      if (s >= 500) return { action: "reprocess", why: `origin error (HTTP ${s}) — may be transient` };
      return { action: "reprocess", why: "unknown status — try once" };
    }
    default:
      return { action: "reprocess", why: "unknown failure — try once" };
  }
}

export function planByAction(rows: AuditRow[]): Record<RecoveryAction, AuditRow[]> {
  const plan: Record<RecoveryAction, AuditRow[]> = { reprocess: [], "local-extract": [], skip: [], none: [] };
  for (const row of rows) plan[recoveryAction(row).action].push(row);
  return plan;
}
