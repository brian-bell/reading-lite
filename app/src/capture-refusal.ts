import { z } from "zod";
import { messageOf } from "./reading";
import { dateTimeOn } from "./reading-presentation";

// The refusals every capture write can meet — a save (save.ts) and a
// reprocess (reprocess.ts) — and their words, so the reading page renders a
// 429 exactly as /save does (acceptance matrix, Capture: "Request rate or
// quota", "Usage guard unavailable"). A 503's sentence names what could not be
// done, so each surface words that one itself.
//
// Each is a value rather than a throw: a refusal the reader can wait out
// leaves the page as it was, with a way to ask again.

export type CaptureRefusal =
  /** 429: a limit the tenant reached. `limit` is the window the backend named. */
  | { kind: "limited"; limit: string; resetAt?: string }
  /** 429 from the usage guard itself: the limits could not be checked. */
  | { kind: "guard-unavailable" }
  /** 503: the write could not be queued; `id` is the reading it got as far as. */
  | { kind: "unavailable"; id?: string };

/**
 * The 429 quota body (src/router.ts `quotaHttp`). `limit` is the window the
 * backend named, and naming one is what makes this body the quota shape: a
 * 429 without it is the guard's, or none of ours.
 *
 * `limit` is a string, not the enum of today's three windows, for the reason
 * reading.ts keeps the backend's enums open: a window added later would
 * otherwise drop the reader to the server error and lose what they typed,
 * which is the regression this refusal exists to prevent. There is a sentence
 * for a window this app does not know.
 *
 * `reset_at` is read the same way round: a reset the page cannot format is
 * worth less than the limit's name, so it is dropped rather than thrown over.
 */
const LimitedSchema = z.looseObject({
  limit: z.string().min(1),
  reset_at: z.string().min(1).optional().catch(undefined),
});

/**
 * The 503 body (src/router.ts, the `unavailable` outcome). Only `id` is
 * read, and only when it is there: a queue send that failed after the attempt
 * was written names the reading it got as far as, a missing binding names
 * nothing. An `id` of another shape reads as none rather than failing the
 * refusal it belongs to.
 */
const UnavailableSchema = z.looseObject({ id: z.string().min(1).optional().catch(undefined) });

/**
 * The usage guard's own 429 (`guard_unavailable` in src/router.ts's `toHttp`,
 * declared in src/schemas/api.ts), which names no limit at all.
 */
const GUARD_UNAVAILABLE = "usage guard unavailable";

/** The refusal a 429 or 503 is, or undefined for any answer that is not one. */
export function captureRefusalOf(status: number, body: unknown): CaptureRefusal | undefined {
  if (status === 429) {
    if (messageOf(body) === GUARD_UNAVAILABLE) return { kind: "guard-unavailable" };
    const parsed = LimitedSchema.safeParse(body);
    // A 429 that names neither a limit nor the guard is not a refusal a page
    // can explain, so it stays the caller's retryable server error.
    return parsed.success ? { kind: "limited", limit: parsed.data.limit, resetAt: parsed.data.reset_at } : undefined;
  }
  if (status === 503) {
    const parsed = UnavailableSchema.safeParse(body);
    return { kind: "unavailable", id: parsed.success ? parsed.data.id : undefined };
  }
  return undefined;
}

/** Which limit was reached (acceptance matrix, Capture), in the reader's terms. */
const LIMIT_REACHED: Record<string, string> = {
  request_rate: "You've reached the request rate limit.",
  hourly: "You've reached the hourly reading limit.",
  monthly: "You've reached the monthly reading limit.",
};

/** A window the backend named that this app has never heard of. */
const LIMIT_REACHED_UNKNOWN = "You've reached a limit.";

/** What a 429 says, in one wording for every surface. */
export function limitSentence(refusal: Extract<CaptureRefusal, { kind: "limited" | "guard-unavailable" }>): string {
  if (refusal.kind === "guard-unavailable") return "Limits can't be checked right now.";
  const reached = LIMIT_REACHED[refusal.limit] ?? LIMIT_REACHED_UNKNOWN;
  const resets = dateTimeOn(refusal.resetAt);
  return resets ? `${reached} It resets at ${resets}.` : reached;
}
