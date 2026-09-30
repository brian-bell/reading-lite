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
// This module states the category, what happened, and the reader's next step;
// the recovery actions themselves, Retry, Import a copy, and the link to
// provider settings, are the status card's (ReadingStatusCard.tsx).

export type FailureCategory =
  | "source-unreachable"
  | "source-incomplete"
  | "provider-limit"
  | "provider-error"
  | "key-missing"
  | "key-invalid"
  | "model-access"
  | "billing"
  | "hosting-limit"
  | "stopped"
  | "unknown";

export interface Failure {
  category: FailureCategory;
  /** The category's fixed sentence, or the backend's message for `unknown`. */
  headline: string;
  /** The backend's message. */
  message: string;
  /**
   * What the card shows under the headline: the backend's message, unless it
   * is the headline already or the backend's own fixed sentence that `next`
   * says better.
   */
  detail?: string;
  /** The reader's next step, when it is more than pressing Retry. */
  next?: string;
  /** The fix is in provider settings (/account/provider): the link's label. */
  settings?: string;
  /** The manifest's stage as written; open so a stage added later still categorises. */
  stage?: string;
}

interface Copy {
  headline: string;
  next?: string;
  settings?: string;
}

const COPY: Record<Exclude<FailureCategory, "unknown">, Copy> = {
  "source-unreachable": { headline: "The page couldn't be fetched." },
  "source-incomplete": { headline: "The page didn't contain the full article." },
  "provider-limit": {
    headline: "The AI provider is rate limiting requests.",
    next: "Wait a few minutes, then retry.",
  },
  "provider-error": { headline: "The AI provider returned an error." },
  "key-missing": {
    headline: "No OpenAI key is connected.",
    next: "Connect your key, then retry.",
    settings: "Connect key",
  },
  "key-invalid": {
    headline: "Your OpenAI key needs replacing.",
    next: "Replace your key, then retry.",
    settings: "Replace key",
  },
  "model-access": {
    headline: "Your OpenAI key can't use the models Reading Lite needs.",
    next: "Allow them for the key's project in OpenAI, or connect another key, then retry.",
    settings: "Provider settings",
  },
  billing: {
    headline: "Your OpenAI account is out of credit.",
    next: "Add credit in OpenAI's billing settings, then retry.",
    settings: "Provider settings",
  },
  "hosting-limit": {
    headline: "Reading Lite's processing limit was reached.",
    next: "Retry once the limit resets.",
  },
  stopped: { headline: "Processing stopped before finishing." },
};

// The provider-account codes (ADR 0004, Queued work and provider errors). The
// backend fails the attempt with these at once, never retrying, because only
// the reader can fix them: their messages are its own fixed recovery sentences,
// which `next` replaces. `provider_key_undecryptable` is the stored key failing
// to open; saving it again is the reader's way on, as for a rejected one.
const ACCOUNT_CODES: ReadonlyMap<string, FailureCategory> = new Map<string, FailureCategory>([
  ["provider_key_required", "key-missing"],
  ["provider_key_invalid", "key-invalid"],
  ["provider_key_undecryptable", "key-invalid"],
  ["provider_model_access", "model-access"],
  ["provider_insufficient_quota", "billing"],
]);

/**
 * Failed while fetching the source, and the class said nothing more specific:
 * the reader's recovery is the same whatever it was. Checked after the explicit
 * code mappings, which are raised at this stage too.
 */
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
  "ReadingReservationExpiredError",
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
  if (category === "unknown") {
    return { category, headline: message, message, ...stageOf(error) };
  }
  const { headline, next, settings } = COPY[category];
  return {
    category,
    headline,
    message,
    ...(ACCOUNT_CODES.has(error.code) ? {} : { detail: message }),
    ...(next === undefined ? {} : { next }),
    ...(settings === undefined ? {} : { settings }),
    ...stageOf(error),
  };
}

function stageOf(error: ReadingError): { stage?: string } {
  return error.stage === undefined ? {} : { stage: error.stage };
}

function categoryOf(error: ReadingError): FailureCategory {
  const { code, stage } = error;
  // A code this module recognises decides before the stage does. The Reddit and
  // X classes are all raised inside the backend's fetch_source stage, and an
  // expired attempt keeps whatever stage it had reached (`expiredActiveAttempt`
  // preserves it), so the fetch-stage fallback below would otherwise swallow
  // them and report the wrong recovery.
  const account = ACCOUNT_CODES.get(code);
  if (account !== undefined) return account;
  if (SOURCE_INCOMPLETE_CODES.has(code)) return "source-incomplete";
  if (STOPPED_CODES.has(code)) return "stopped";
  if (HOSTING_LIMIT_CODES.has(code)) return "hosting-limit";
  // Stage separates a class raised at more than one stage: RateLimitedError is
  // the site at fetch_source and the provider at summarize.
  if (stage !== undefined && SOURCE_UNREACHABLE_STAGES.has(stage)) return "source-unreachable";
  if (stage !== undefined && PROVIDER_STAGES.has(stage) && PROVIDER_CODES.has(code)) {
    // The provider classes keep the provider's own message, which does not
    // repeat the status, so it is read from the field the backend records.
    // A 401 or 403 to the reader's own key arrives as an account code above;
    // one that reaches an adapter was sent with Reading Lite's hosted key,
    // which the reader cannot fix, so it stays a provider error.
    const status = error.http_status;
    if (code === "RateLimitedError" || status === 429) return "provider-limit";
    return "provider-error";
  }
  return "unknown";
}
