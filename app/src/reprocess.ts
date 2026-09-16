import { ApiError } from "./api/errors";
import { captureRefusalOf, type CaptureRefusal } from "./capture-refusal";
import { actingTenantOf, messageOf } from "./reading";

// What POST /api/readings/:id/reprocess answered (#410): Retry on a failed
// reading and a confirmed Reprocess on a ready one. Pure, like save.ts;
// api/reprocess.ts does the request and the reading page renders the outcome.
//
// The request never carries `force` (acceptance matrix, Actions: "Force
// reprocess — never sent"), so an attempt already running is a refusal here,
// never something this app overrides.

export type ReprocessOutcome =
  /** 202 (or a 200): an attempt was written and enqueued. The reading's refetch shows it. */
  | { kind: "started" }
  /** 409: an attempt is already running over this reading. */
  | { kind: "already-processing" }
  /** 409: a Markdown reading whose stored copy is gone; Import a copy is the way on (#411). */
  | { kind: "markdown-missing" }
  /** 400: the backend refused to fetch the reading's URL, in its own words. */
  | { kind: "invalid"; message: string }
  /** 404: the reading is gone; its refetch renders the not-found state. */
  | { kind: "not-found" }
  /** 403: never a sign-out. */
  | { kind: "forbidden" }
  /** 412: the tenant pin caught another tab signing in as someone else. */
  | { kind: "account-changed"; actingTenant?: string }
  /** 429 and 503 (capture-refusal.ts). */
  | CaptureRefusal;

/** The two 409 bodies src/router.ts's `toHttp` gives a reprocess `conflict`. */
const ACTIVE_ATTEMPT = "reading already has an active attempt";
const MARKDOWN_MISSING = "markdown content not available";

/** The fallback for a 400 whose body says nothing useful. */
const REFUSED = "This reading can't be processed again.";

/**
 * What the response means. As in submitFromResponse, a 401 and anything this
 * page cannot explain throw an ApiError: the 401 through the mutation cache
 * becomes the shell's expired-session page (auth/session.ts), the rest the
 * notice's server error.
 */
export function reprocessFromResponse(status: number, body: unknown): ReprocessOutcome {
  // The body is not read: the attempt id it names is the one the reading's
  // refetch shows as `active_attempt`, and the watch keys on that.
  if (status === 202 || status === 200) return { kind: "started" };
  if (status === 400) return { kind: "invalid", message: messageOf(body) ?? REFUSED };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not-found" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  if (status === 409) {
    const message = messageOf(body);
    if (message === ACTIVE_ATTEMPT) return { kind: "already-processing" };
    if (message === MARKDOWN_MISSING) return { kind: "markdown-missing" };
  }
  const refused = captureRefusalOf(status, body);
  if (refused) return refused;
  throw new ApiError(status, messageOf(body) ?? `reprocess returned ${status}`);
}
