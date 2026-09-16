import { z } from "zod";
import { ApiError } from "./api/errors";
import { actingTenantOf, isProcessing, messageOf } from "./reading";

// Saving a URL (#431, #433, Phase 4 of #339): the rule the field applies
// before it asks, and what POST /api/readings answered. Pure, so both are
// tested without a DOM; api/save.ts does the request and SavePage.tsx renders
// the outcome.
//
// A refusal the reader can wait out — a rate limit, a quota, a queue that is
// not there — is a value here rather than a throw, because the page keeps the
// form and the URL in it. Only an answer nobody can act on (a 401 through the
// session cache, a 500) is left to throw.
//
// The client-side rule mirrors the backend's `webUrl()` in src/schemas/api.ts
// (a parseable URL, refined to http(s)) rather than inventing a second one.
// It exists to save a round trip on an obvious typo, not to replace the
// backend's judgement: a URL this accepts can still come back 400, and that
// answer renders in exactly the same place.

/** Why this input cannot be saved, or undefined when it can be tried. */
export function saveUrlProblem(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return "Enter the URL of the page you want to save.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full URL, like https://example.com/article.";
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return "Only http and https links can be saved.";
  }
  return undefined;
}

/**
 * The 202 body (src/router.ts, the `activated` outcome). Loose like the
 * reading projection: only `id` is load-bearing here — the page opens the
 * reading and that page reads its own status — so `status`, `poll`, and
 * `attempt_id` are left to pass through untouched, as a field the backend adds
 * later does.
 */
export const SubmitAcceptedSchema = z.looseObject({ id: z.string().min(1) });

/**
 * What a reading that already exists answers with: the owning manifest for a
 * 200 (src/router.ts, the `existing` outcome), and `{ error, id, poll }` for
 * the 409 that names the owner still initializing. Loose for the same reason
 * as above: only what decides the notice is read here — the manifest's own
 * status and the attempt running over it — and the reading's page reads the
 * rest for itself. Each state field `.catch`es its own shape, so a body that
 * carries something unexpected there still names the reading to open.
 */
export const SubmitExistingSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional().catch(undefined),
  active_attempt: z
    .looseObject({ status: z.string().optional().catch(undefined) })
    .nullish()
    .catch(undefined),
});

/**
 * What the reader is told on arrival about a URL that was already theirs
 * (#432). A closed set: the reading page renders one sentence per value and
 * nothing else, so a body that fits neither says nothing rather than guessing.
 */
export type SaveNotice = "already-saved" | "still-processing";

export type SubmitOutcome =
  /** 202: an attempt was written and enqueued. */
  | { kind: "accepted"; id: string }
  /**
   * 200 or 409: this URL is already a reading, so open it. `notice` is what
   * the reading says about it once it is open — absent when the backend gave
   * nothing to say (the 409, which names an id and no state).
   */
  | { kind: "existing"; id: string; notice?: SaveNotice }
  /** 400: the backend rejected the URL, in its own words. */
  | { kind: "invalid"; message: string }
  /** 403: never a sign-out, and never the field's fault. */
  | { kind: "forbidden" }
  /** 412: the tenant pin caught another tab signing in as someone else. */
  | { kind: "account-changed"; actingTenant?: string }
  /** 429: a limit the tenant reached. `limit` is the window the backend named. */
  | { kind: "limited"; limit: string; resetAt?: string }
  /** 429 from the usage guard itself: the limits could not be checked. */
  | { kind: "guard-unavailable" }
  /** 503: the save could not be queued; `id` is the reading it got as far as. */
  | { kind: "unavailable"; id?: string };

/**
 * The 429 quota body (src/router.ts `quotaHttp`). `limit` is the window the
 * backend named, and naming one is what makes this body the quota shape: a
 * 429 without it is the guard's, or none of ours.
 *
 * `limit` is a string, not the enum of today's three windows, for the reason
 * reading.ts keeps the backend's enums open: a window added later would
 * otherwise drop the reader to the page-replacing server error and lose the
 * URL they typed, which is the regression this refusal exists to prevent. The
 * page has a sentence for a window it does not know.
 *
 * `reset_at` is read the same way round: a reset the page cannot format is
 * worth less than the limit's name, so it is dropped rather than thrown over.
 */
const LimitedSchema = z.looseObject({
  limit: z.string().min(1),
  reset_at: z.string().min(1).optional().catch(undefined),
});

/**
 * The usage guard's own 429 (`guard_unavailable` in src/router.ts's `toHttp`,
 * declared in src/schemas/api.ts), which names no limit at all.
 */
const GUARD_UNAVAILABLE = "usage guard unavailable";

/** The fallback for a 400 whose body says nothing useful. */
const REJECTED = "That URL can't be saved.";

/**
 * What the response means. 403 and 412 are values here, as they are in
 * readingFromResponse and libraryFromResponse, so the page renders the shared
 * state and a 412 keeps the `acting_tenant` it named; 429 and 503 are values
 * for the same reason, and the form survives them. Anything left throws an
 * ApiError: a 401 through the mutation cache (auth/session.ts) becomes the
 * shell's expired-session page, anything else the retryable server error.
 */
export function submitFromResponse(status: number, body: unknown): SubmitOutcome {
  if (status === 202) {
    const parsed = SubmitAcceptedSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "save returned an unexpected body");
    return { kind: "accepted", id: parsed.data.id };
  }
  if (status === 400) return { kind: "invalid", message: messageOf(body) ?? REJECTED };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  if (status === 429) {
    if (messageOf(body) === GUARD_UNAVAILABLE) return { kind: "guard-unavailable" };
    const parsed = LimitedSchema.safeParse(body);
    // A 429 that names neither a limit nor the guard is not a refusal this
    // page can explain, so it stays the retryable server error.
    if (parsed.success) {
      return { kind: "limited", limit: parsed.data.limit, resetAt: parsed.data.reset_at };
    }
  }
  // 503 is the queue: the attempt may already exist (`id`), and then the
  // reading is worth opening even though nothing was enqueued for it.
  if (status === 503) return { kind: "unavailable", id: idOf(body) };
  // 200 is the reading that already owns this URL (its manifest), and 409 is
  // the owner still initializing, which names the same id to poll. Either way
  // the reader asked for a reading that exists, so the page opens it.
  //
  // Only the 200 carries a state to describe: a failed owner is reprocessed in
  // place and answers 202, so what comes back here is ready or pending, and a
  // ready one may have an attempt running over it. The 409 names nothing but
  // the id, and its reading's own status card says what is happening.
  if (status === 200 || status === 409) {
    const parsed = SubmitExistingSchema.safeParse(body);
    // Only the 200 carries a state to describe; the 409 names an id and
    // nothing else, so it says nothing.
    if (parsed.success) {
      return { kind: "existing", id: parsed.data.id, notice: status === 200 ? noticeFor(parsed.data) : undefined };
    }
  }
  throw new ApiError(status, messageOf(body) ?? `save returned ${status}`);
}

/**
 * What the reading says about itself on arrival. Being worked on is
 * `isProcessing` (reading.ts), the same rule the reading's own status card and
 * the library's badge read, so the notice and the card under it agree. A
 * status that is neither ready nor being processed (or missing) is nothing the
 * reader needs told.
 */
function noticeFor(manifest: z.infer<typeof SubmitExistingSchema>): SaveNotice | undefined {
  if (isProcessing(manifest)) return "still-processing";
  if (manifest.status === "ready") return "already-saved";
  return undefined;
}
