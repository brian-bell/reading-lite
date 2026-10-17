import { z } from "zod";
import type { AccountRead } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";
import { DigestCadenceSchema, type DigestCadence } from "./settings";

// The digest preview from GET /api/digest/preview (reading-lite-kl7y.10): the
// readings the next digest mail would carry if it went out now, chosen by the
// mail's own rule, and when it goes out. Read in the browser by the desk's
// Next digest tile and the /digest page. The projection mirrors
// GetDigestPreviewResponseSchema (src/schemas/api.ts); unknown fields pass
// through, and a malformed one is the retryable "unexpected body" error.
// Pure, so the send time's zone is tested on its own.

const DigestItemSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  tldr: z.string().min(1),
  url: z.string().min(1),
});
export interface DigestItem {
  id: string;
  title: string;
  tldr: string;
  url: string;
}

export const DigestPreviewSchema = z.looseObject({
  cadence: DigestCadenceSchema,
  time_zone: z.string().min(1),
  next_send_at: z.string().nullable(),
  subject: z.string().nullable(),
  items: z.array(DigestItemSchema),
});
/** The fields this app reads; the schema lets the rest (the window) pass through. */
export interface DigestPreview {
  cadence: DigestCadence;
  /** The reader's digest time zone (IANA), which the send time is told in. */
  time_zone: string;
  /** Null when the digest is off, or its time zone cannot be scheduled. */
  next_send_at: string | null;
  subject: string | null;
  /** Newest first: exactly what the mail would carry now. */
  items: DigestItem[];
}

export type DigestPreviewResult = AccountRead<DigestPreview>;

/**
 * Under the desk's root, so whatever refreshes the desk (a settled attempt, a
 * save, a reprocess, a promoted inbox item) refreshes the preview too. Dropped
 * at sign-in and sign-out with every other account query (src/auth/session.ts).
 */
export const digestPreviewQueryKey = ["desk", "digest"] as const;

export function digestPreviewFromResponse(status: number, body: unknown): DigestPreviewResult {
  if (status === 200) {
    const parsed = DigestPreviewSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "digest preview returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `digest preview returned ${status}`);
}

/** What the tile and the page show: no send, or the next one and what it carries. */
export type DigestSend =
  | { kind: "off" }
  | {
      kind: "scheduled";
      cadence: Exclude<DigestCadence, "off">;
      /** "Monday 14 September at 08:00, Europe/London". */
      goesOut: string;
      subject: string;
      items: DigestItem[];
    };

export function digestSendOf(preview: DigestPreview): DigestSend {
  if (preview.cadence === "off" || preview.next_send_at === null || preview.subject === null) return { kind: "off" };
  return {
    kind: "scheduled",
    cadence: preview.cadence,
    goesOut: sendTimeIn(preview.next_send_at, preview.time_zone),
    subject: preview.subject,
    items: preview.items,
  };
}

/**
 * The send time on the reader's digest clock, not this browser's, followed by
 * the zone it is told in. A zone this browser does not know is told in UTC,
 * and says so.
 */
export function sendTimeIn(iso: string, timeZone: string): string {
  const at = new Date(iso);
  try {
    return `${localTime(at, timeZone)}, ${timeZone}`;
  } catch {
    return `${localTime(at, "UTC")}, UTC`;
  }
}

function localTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} at ${part("hour")}:${part("minute")}`;
}

export function readingsSoFar(count: number): string {
  return `${count} reading${count === 1 ? "" : "s"} so far`;
}
