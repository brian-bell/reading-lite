import type { ProcessingStage, ReadingError } from "./reading";

// Failure categories (acceptance matrix, Failure categories). Failed manifests
// carry `error.code` — the backend error class name, or a `stale_*` marker —
// plus `error.stage`. Those names are not a published contract, so the mapping
// lives here, in one module, with an unknown fallback that shows the backend's
// message unchanged.
//
// test/reading-failure.test.ts pins every category against the fixture pack
// (docs/design/connected/fixture-pack.md), which is generated from the real
// error classes: renaming one at the backend fails that test rather than
// silently demoting a reading to "Unknown".
//
// Recovery actions (Retry, Import a copy) arrive with capture in Phase 4
// (#339); this slice states the category and what happened.

export type FailureCategory =
  | "source-unreachable"
  | "source-incomplete"
  | "provider-limit"
  | "provider-error"
  | "key-problem"
  | "hosting-limit"
  | "stopped"
  | "unknown";

export interface Failure {
  category: FailureCategory;
  /** The category's fixed sentence, or the backend's message for `unknown`. */
  headline: string;
  /** The backend's message. Shown as supporting detail unless it is the headline. */
  message: string;
  stage?: ProcessingStage;
}

const HEADLINES: Record<Exclude<FailureCategory, "unknown">, string> = {
  "source-unreachable": "The page couldn't be fetched.",
  "source-incomplete": "The page didn't contain the full article.",
  "provider-limit": "The AI provider is rate limiting requests.",
  "provider-error": "The AI provider returned an error.",
  // Hosted keys are the operator's today; Phase 6 (#341) gives this its own copy.
  "key-problem": "The AI provider rejected the credentials for this request.",
  "hosting-limit": "Reading Lite's processing limit was reached.",
  stopped: "Processing stopped before finishing.",
};

/** Fetching the source, whatever the class: the reader's recovery is the same. */
const SOURCE_UNREACHABLE_STAGES: ReadonlySet<string> = new Set<ProcessingStage>([
  "fetch_source",
]);

const SOURCE_INCOMPLETE_CODES: ReadonlySet<string> = new Set([
  "SourceRejectedError",
  "OpenAISourceRejectedError",
  "RedditManualImportError",
  "XApiConfigError",
  "XThreadIncompleteError",
  "XThreadOutsideRecentWindowError",
]);

const STOPPED_CODES: ReadonlySet<string> = new Set([
  "stale_pending",
  "stale_active_attempt",
  "QueueRetriesExhaustedError",
]);

const HOSTING_LIMIT_CODES: ReadonlySet<string> = new Set([
  "SpendAdmissionError",
  "ProcessingDeferExpiredError",
  "DeferPaidWorkError",
]);

/** Where the paid providers are called. `query_similar` is our own index, not a provider. */
const PROVIDER_STAGES: ReadonlySet<string> = new Set<ProcessingStage>([
  "summarize",
  "embed_source",
  "embed_summary",
]);

const PROVIDER_CODES: ReadonlySet<string> = new Set([
  "AnthropicError",
  "BadEmbeddingResponseError",
  "BadStatusError",
  "BadToolInputError",
  "NoToolUseError",
  "OpenAIError",
  "OpenAIIncompleteResponseError",
  "OpenAIOutputError",
  "OpenAIRefusalError",
  "OpenAIResponseError",
  "OversizedResponseError",
  "RateLimitedError",
]);

export function categorize(error: ReadingError): Failure {
  const category = categoryOf(error);
  const message = error.message;
  return {
    category,
    headline: category === "unknown" ? message : HEADLINES[category],
    message,
    ...(error.stage === undefined ? {} : { stage: error.stage }),
  };
}

function categoryOf(error: ReadingError): FailureCategory {
  const { code, stage } = error;
  // A class name can mean two different things at two stages: BadStatusError is
  // the site refusing us at fetch_source and the provider refusing us at
  // summarize. Stage decides first.
  if (stage !== undefined && SOURCE_UNREACHABLE_STAGES.has(stage)) return "source-unreachable";
  if (SOURCE_INCOMPLETE_CODES.has(code)) return "source-incomplete";
  if (STOPPED_CODES.has(code)) return "stopped";
  if (HOSTING_LIMIT_CODES.has(code)) return "hosting-limit";
  if (stage !== undefined && PROVIDER_STAGES.has(stage) && PROVIDER_CODES.has(code)) {
    const status = providerStatusOf(error.message);
    if (code === "RateLimitedError" || status === 429) return "provider-limit";
    if (status === 401 || status === 403) return "key-problem";
    return "provider-error";
  }
  return "unknown";
}

/**
 * The HTTP status inside a provider error's message. The manifest error carries
 * no status field of its own (ManifestErrorSchema is code/message/stage/…), and
 * 401 and 403 are what separate a key problem from an ordinary provider error,
 * so it is read back out of the text the class wrote: "bad response status 401:
 * …" (BadStatusError), "(status 429, retry after …)" (RateLimitedError).
 * No match means no status, which lands on `provider-error` — never a false
 * key problem.
 */
function providerStatusOf(message: string): number | undefined {
  const match = /\bstatus (\d{3})\b/.exec(message);
  return match ? Number(match[1]) : undefined;
}
