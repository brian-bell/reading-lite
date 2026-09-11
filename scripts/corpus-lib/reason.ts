import type { AttemptTrigger } from "./types";

// Human-readable failure reasons. Most are derived from the manifest error
// (code + the HTTP status embedded in BadStatusError messages); a handful of
// URLs get a hand-verified override (probed locally — PDF vs paywall vs dead).

export const FAILURE_OVERRIDES: Record<string, string> = {
  "https://www.thebestideasforkids.com/wp-content/uploads/2024/11/Thanksgiving-Bingo-Cards-The-Best-Ideas-for-Kids.pdf":
    "Not an article — PDF (printable bingo cards)",
  "https://saewitz.com/agentic-coding-is-a-fundamental-shift": "Dead link — 404 Not Found",
  "https://medium.com/@niall.mcnulty/the-complete-guide-to-model-context-protocol-148dca58f148":
    "Dead link — 410 Gone (removed)",
};

export function httpStatusFromMessage(message: string | undefined): number {
  return Number(message?.match(/status (\d{3})/)?.[1] ?? 0);
}

// DestinationResolutionError: one originating attempt (submit/import/absent) plus
// one corpus recover. A last_attempt.trigger of "reprocess" means that ceiling
// is already spent. workerd reports NXDOMAIN, SERVFAIL, and a missing address
// family as ENOTFOUND, so this rule cannot split those cases.
export const DESTINATION_RESOLUTION_RETRY_CEILING_WHY =
  "originating attempt + one recover already used; resolver cannot tell a dead name from a blip";

const DESTINATION_RESOLUTION_REASON = "Destination would not resolve";

export function destinationResolutionRetryExhausted(trigger: string | undefined): boolean {
  return trigger === "reprocess";
}

const STATUS_LABEL: Record<number, string> = {
  401: "Unauthorized",
  402: "Payment required (paywall)",
  403: "Forbidden (bot-block/paywall)",
  404: "Not found (dead link)",
  410: "Gone (removed)",
  429: "Rate limited",
  451: "Blocked (legal)",
};

export function reasonForFailure(
  code: string | undefined,
  message: string | undefined,
  url: string,
  lastAttemptTrigger?: AttemptTrigger,
): string {
  if (FAILURE_OVERRIDES[url]) return FAILURE_OVERRIDES[url];
  if (/reddit\.com|redd\.it/i.test(url)) return "Reddit — import via local reddit-import skill";
  switch (code) {
    case "BadStatusError": {
      const s = httpStatusFromMessage(message);
      if (STATUS_LABEL[s]) return `HTTP ${s} — ${STATUS_LABEL[s]}`;
      if (s >= 500) return `HTTP ${s} — server/origin error`;
      return s ? `HTTP ${s}` : "Bad response status";
    }
    case "OversizedResponseError":
      return "Response exceeded fetch byte cap";
    case "BadToolInputError":
      return "Summarization failed — invalid model tool output";
    case "FetchTimeoutError":
      return "Fetch timed out";
    case "DestinationResolutionError":
      if (destinationResolutionRetryExhausted(lastAttemptTrigger)) {
        return `${DESTINATION_RESOLUTION_REASON} — not auto-selected: ${DESTINATION_RESOLUTION_RETRY_CEILING_WHY}`;
      }
      return DESTINATION_RESOLUTION_REASON;
    case "SourceRejectedError":
    case "OpenAISourceRejectedError":
      if (/youtube\.com|youtu\.be/i.test(url)) {
        return "Thin extraction — import via local youtube-import skill";
      }
      return "Thin extraction — not a full article or transcript";
    default:
      return code ? `${code}: ${(message ?? "").slice(0, 60)}` : "Unknown failure";
  }
}
