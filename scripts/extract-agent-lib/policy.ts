// Per-row decision table for the extraction agent. Modeled on
// scripts/corpus-lib/policy.ts (corpus-recover's triage table) but a separate
// module on purpose — recover semantics stay untouched.
//
//   attempt       re-extract locally via the given route and re-submit
//   never         permanently unrecoverable this way (dead, paywalled, SSRF)
//   out_of_scope  Worker-recoverable (stale/DLQ strandings) — local extraction
//                 adds nothing; counted, not hidden
//   ineligible    not a candidate right now (pending, ready, running attempt)

import type { ListIndexItem } from "../../src/schemas/api";
import { httpStatusFromMessage } from "../corpus-lib/reason";
import { isRedditThreadUrl } from "../../src/modules/extractor/reddit";
import { isYoutubeWatchUrl } from "../../src/modules/extractor/youtube";

export type Route = "static" | "reddit" | "youtube";

export type Decision =
  | { decision: "attempt"; route: Route; why: string }
  | { decision: "never" | "out_of_scope" | "ineligible"; why: string };

export function classify(row: ListIndexItem): Decision {
  if (row.status === "pending") return { decision: "ineligible", why: "pending — likely in-flight" };
  if (row.status === "ready") return { decision: "ineligible", why: "ready — upgrades land in Phase 6" };
  if (row.active_attempt?.status === "running") {
    return { decision: "ineligible", why: "worker attempt running — never race it" };
  }

  // status === "failed" from here on.
  // The stage filter is deliberate and subtler than it looks: real processing
  // failures stamp the true stage from the in-memory attempt, but
  // stale-annotated strandings and DLQ-marked rows derive their stage from the
  // manifest summary, which is written once at activation as "queued" and never
  // advanced. Those rows are Worker-recoverable (reprocess / corpus-recover);
  // do NOT "fix" this filter to include them.
  if (row.error?.stage !== "fetch_source") {
    return { decision: "out_of_scope", why: "not a fetch_source failure — worker-recoverable" };
  }

  const { code, message } = row.error;
  if (code === "BlockedHostError" || code === "TooManyRedirectsError") {
    return { decision: "never", why: "SSRF guard fired — do not retry from inside the LAN" };
  }
  if (isExplicitNonArticleReason(message)) {
    return { decision: "never", why: "not an article (PDF)" };
  }

  const status = code === "BadStatusError" ? httpStatusFromMessage(message) : 0;
  if (status === 404 || status === 410) return { decision: "never", why: `dead link (HTTP ${status})` };
  if (status === 401 || status === 402 || status === 451) {
    return { decision: "never", why: `paywalled/blocked (HTTP ${status})` };
  }

  // Route keys off the URL as well as the error code: a reddit/youtube row can
  // carry any fetch_source error, but the recovery path is the same.
  if (code === "RedditManualImportError" || isRedditThreadUrl(row.url)) {
    return { decision: "attempt", route: "reddit", why: "reddit thread — anonymous .json fetch" };
  }
  if (isYoutubeWatchUrl(row.url)) {
    return { decision: "attempt", route: "youtube", why: "youtube watch page — local metadata + transcript" };
  }

  if (status === 403 || status === 429) {
    return { decision: "attempt", route: "static", why: `fetch blocked (HTTP ${status}) — try residential fetch` };
  }
  if (code === "FetchTimeoutError") return { decision: "attempt", route: "static", why: "transient fetch timeout" };
  if (code === "OversizedResponseError") {
    return { decision: "attempt", route: "static", why: "oversized for the worker cap — agent cap is higher" };
  }
  if (status >= 500) return { decision: "attempt", route: "static", why: `origin error (HTTP ${status})` };
  return { decision: "attempt", route: "static", why: "unknown fetch_source failure — try locally" };
}

function isExplicitNonArticleReason(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === "not an article" || normalized === "not an article — pdf" || normalized === "not an article (pdf)";
}
