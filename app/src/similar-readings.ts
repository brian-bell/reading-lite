import type { HistoryState } from "@tanstack/history";
import { z } from "zod";
import type { AccountRead } from "./account-state";
import { ApiError } from "./api/errors";
import { captureRefusalOf, type CaptureRefusal } from "./capture-refusal";
import { absent, actingTenantOf, messageOf } from "./reading";
import { categorize, type Failure, type FailureCategory } from "./reading-failure";
import { currentLoadId } from "./reading-trail";

// Meaning search and More like this (reading-lite-kl7y.5): the question a
// reader asks Find in meaning mode, what POST /api/readings/search and
// GET /api/readings/:id/similar answered, and where the question lives.
// Pure; similar-readings-query.ts makes the requests and CatalogPage.tsx and
// ReadingContext.tsx render the results.
//
// The score becomes a closeness band here, once, and goes no further: no
// component sees a number (design spec, Meaning search).
//
// The question is never put in the URL. It travels in the catalog history
// entry that asked it, scoped to the document load as the return trail is
// (reading-trail.ts), so Back shows the answer again from the cache and a
// reload drops both without asking, which would spend again.

declare const meaningQuestionBrand: unique symbol;
/** Trimmed, 1 to MEANING_QUESTION_MAX characters. Only meaningQuestionOf mints one. */
export type MeaningQuestion = string & { readonly [meaningQuestionBrand]: true };

/** The backend's longest question (PostReadingsSearchBodySchema). */
export const MEANING_QUESTION_MAX = 500;

export function meaningQuestionOf(draft: string): MeaningQuestion | undefined {
  const question = draft.trim();
  if (question === "" || question.length > MEANING_QUESTION_MAX) return undefined;
  return question as MeaningQuestion;
}

export type Closeness = "Close" | "Near" | "Faint";

// Provisional until an operator eval measures question-to-reading scores. Each
// edge is one 0.05 step above the last, the granularity SIMILARITY_FLOOR's
// calibration measured at. Faint is whatever the backend returned below Near,
// so the floor itself is the backend's alone.
const NEAR_FROM = 0.6;
const CLOSE_FROM = 0.65;

function closenessOf(score: number): Closeness {
  if (score >= CLOSE_FROM) return "Close";
  if (score >= NEAR_FROM) return "Near";
  return "Faint";
}

export interface SimilarReading {
  id: string;
  url: string;
  title: string;
  tldr?: string;
}

export interface MeaningResult extends SimilarReading {
  closeness: Closeness;
}

export type MeaningOutcome =
  | { kind: "results"; items: readonly MeaningResult[] }
  | { kind: "refusal"; refusal: CaptureRefusal }
  | { kind: "failure"; failure: Failure }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string };

export type MeaningView =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; outcome: MeaningOutcome }
  | { state: "offline" }
  /** An answer nobody can act on: an unexpected status, or no response while online. */
  | { state: "failed"; message: string };

const SimilarItemSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  title: absent(z.string()),
  tldr: absent(z.string()),
  score: z.number(),
});
const SimilarItemsSchema = z.looseObject({ items: z.array(SimilarItemSchema) });
type SimilarItem = z.output<typeof SimilarItemSchema>;

const CodedErrorSchema = z.looseObject({ code: z.string(), error: z.string() });

/**
 * The categories a refused question can land in: the reader's own key, model
 * access or billing, or a limit. A missing key is the capture refusal instead,
 * and the categories that need a stage or a source never apply to a question.
 */
const MEANING_FAILURES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  "key-invalid",
  "model-access",
  "billing",
  "hosting-limit",
]);

function similarReadingOf(item: SimilarItem): SimilarReading {
  return {
    id: item.id,
    url: item.url,
    title: item.title ?? item.url,
    ...(item.tldr === undefined ? {} : { tldr: item.tldr }),
  };
}

export function meaningOutcomeFromResponse(status: number, body: unknown): MeaningOutcome {
  if (status === 200) {
    const parsed = SimilarItemsSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "meaning search returned an unexpected body");
    return {
      kind: "results",
      items: parsed.data.items.map((item) => ({ ...similarReadingOf(item), closeness: closenessOf(item.score) })),
    };
  }
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  const keyRequired = status === 409 ? captureRefusalOf(status, body) : undefined;
  if (keyRequired) return { kind: "refusal", refusal: keyRequired };
  // These 429s name no `limit`, so captureRefusalOf would not claim them.
  if (status === 409 || status === 429) {
    const coded = CodedErrorSchema.safeParse(body);
    if (coded.success) {
      const failure = categorize({ code: coded.data.code, message: coded.data.error });
      if (MEANING_FAILURES.has(failure.category)) return { kind: "failure", failure };
    }
  }
  const unavailable = status === 503 ? captureRefusalOf(status, body) : undefined;
  if (unavailable) return { kind: "refusal", refusal: unavailable };
  throw new ApiError(status, messageOf(body) ?? `meaning search returned ${status}`);
}

export type SimilarReadingsResult = AccountRead<readonly SimilarReading[]>;

/** GET /api/readings/:id/similar. More like this shows no band, so the score is dropped. */
export function similarReadingsFromResponse(status: number, body: unknown): SimilarReadingsResult {
  if (status === 200) {
    const parsed = SimilarItemsSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "similar readings returned an unexpected body");
    return { state: "ready", value: parsed.data.items.map(similarReadingOf) };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `similar readings returned ${status}`);
}

export interface MeaningState {
  /** The document load that asked; see currentLoadId. */
  load: string;
  question: string;
}

declare module "@tanstack/history" {
  interface HistoryState {
    meaning?: MeaningState;
  }
}

const MeaningStateSchema = z.object({ load: z.string(), question: z.string() });

export function meaningState(question: MeaningQuestion, loadId: string = currentLoadId()): Pick<HistoryState, "meaning"> {
  return { meaning: { load: loadId, question } };
}

/**
 * The question a location's state asked, or none for another load's state or
 * one that no longer parses: @tanstack/history rebuilds state from
 * `window.history.state`, which anything in the page can have written.
 */
export function meaningQuestionOfState(
  state: HistoryState | undefined,
  loadId: string = currentLoadId(),
): MeaningQuestion | undefined {
  const parsed = MeaningStateSchema.safeParse(state?.meaning);
  if (!parsed.success || parsed.data.load !== loadId) return undefined;
  return meaningQuestionOf(parsed.data.question);
}
