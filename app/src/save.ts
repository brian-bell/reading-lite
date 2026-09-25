import { z } from "zod";
import { ApiError } from "./api/errors";
import { ACTIVE_ATTEMPT, captureRefusalOf, type CaptureRefusal } from "./capture-refusal";
import { actingTenantOf, isProcessing, messageOf } from "./reading";

// Saving a URL (#431, #433, Phase 4 of #339): the rule the field applies
// before it asks, and what POST /api/readings answered. Pure, so both are
// tested without a DOM; api/save.ts does the request and SavePage.tsx renders
// the outcome. POST /api/readings/import-markdown (#408) answers with the same
// outcomes (src/router.ts `respondIntake`), so it is read here too.
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
  return webUrlProblem(raw, {
    empty: "Enter the URL of the page you want to save.",
    notWeb: "Only http and https links can be saved.",
  });
}

/**
 * The web-URL rule itself, shared with the Markdown import's source URL
 * (import-markdown.ts), which words what it asks for in its own terms.
 */
export function webUrlProblem(raw: string, words: { empty: string; notWeb: string }): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return words.empty;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full URL, like https://example.com/article.";
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return words.notWeb;
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
 * 200 (src/router.ts, the `existing` outcome). Loose for the same reason as
 * above: only what decides the notice is read here — the manifest's own
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
   * 200: this URL is already a reading, so open it. `notice` is what the
   * reading says about it once it is open — absent when the manifest's state
   * is nothing the reader needs told.
   */
  | { kind: "existing"; id: string; notice?: SaveNotice }
  /** 400: the backend rejected the URL, in its own words. */
  | { kind: "invalid"; message: string }
  /**
   * 409: an attempt is already running over the reading that owns this URL.
   * The body names no reading, so there is nothing to open.
   */
  | { kind: "already-processing" }
  /** 403: never a sign-out, and never the field's fault. */
  | { kind: "forbidden" }
  /** 412: the tenant pin caught another tab signing in as someone else. */
  | { kind: "account-changed"; actingTenant?: string }
  /** 429 and 503 (capture-refusal.ts). */
  | CaptureRefusal;

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
  // 429 and 503 are the refusals every capture write shares. A 503 is the
  // queue: the attempt may already exist (`id`), and then the reading is worth
  // opening even though nothing was enqueued for it.
  const refused = captureRefusalOf(status, body);
  if (refused) return refused;
  // 200 is the reading that already owns this URL (its manifest), so the page
  // opens it. A failed owner is reprocessed in place and answers 202, so what
  // comes back here is ready or pending, and a ready one may have an attempt
  // running over it.
  if (status === 200) {
    const parsed = SubmitExistingSchema.safeParse(body);
    if (parsed.success) return { kind: "existing", id: parsed.data.id, notice: noticeFor(parsed.data) };
  }
  // The claim commits the reading, its URL, and its attempt together, so no
  // owner is ever half-written and there is no 409 naming one to poll. What a
  // 409 means now is an attempt already running over the owner: a refusal the
  // reader waits out, with no id to open.
  if (status === 409 && messageOf(body) === ACTIVE_ATTEMPT) return { kind: "already-processing" };
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
