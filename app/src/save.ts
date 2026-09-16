import { z } from "zod";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// Saving a URL (#431, Phase 4 of #339): the rule the field applies before it
// asks, and what POST /api/readings answered. Pure, so both are tested without
// a DOM; api/save.ts does the request and SavePage.tsx renders the outcome.
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

export type SubmitOutcome =
  /** 202: an attempt was written and enqueued. */
  | { kind: "accepted"; id: string }
  /** 200 or 409: this URL is already a reading, so open it. */
  | { kind: "existing"; id: string }
  /** 400: the backend rejected the URL, in its own words. */
  | { kind: "invalid"; message: string }
  /** 403: never a sign-out, and never the field's fault. */
  | { kind: "forbidden" }
  /** 412: the tenant pin caught another tab signing in as someone else. */
  | { kind: "account-changed"; actingTenant?: string };

/** The fallback for a 400 whose body says nothing useful. */
const REJECTED = "That URL can't be saved.";

/**
 * What the response means. 403 and 412 are values here, as they are in
 * readingFromResponse and libraryFromResponse, so the page renders the shared
 * state and a 412 keeps the `acting_tenant` it named. Anything left throws an
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
  // 200 is the reading that already owns this URL (its manifest), and 409 is
  // the owner still initializing, which names the same id to poll. Either way
  // the reader asked for a reading that exists, so the page opens it.
  if (status === 200 || status === 409) {
    const id = idOf(body);
    if (id !== undefined) return { kind: "existing", id };
  }
  throw new ApiError(status, messageOf(body) ?? `save returned ${status}`);
}

function idOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}
