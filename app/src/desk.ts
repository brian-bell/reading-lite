import { z } from "zod";
import type { AccountRead, AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { LibraryRowSchema, type LibraryRow } from "./library";
import { actingTenantOf, messageOf } from "./reading";
import { categorize } from "./reading-failure";
import { dateOn } from "./reading-presentation";
import { failureOf, reprocessFailed } from "./reading-state";
import { forwardedFrom, type BackendReads } from "./server/backend-reads";

// The desk (reading-lite-kl7y.6, kl7y.7): at most three readings the reader
// means to read next, and the home page that shows them beside what needs the
// reader, what is processing, and what arrived since the last visit. The
// writes are POST /api/desk, DELETE /api/desk/:id and DELETE /api/desk
// (docs/api.md, Desk routes); each answers the whole desk as ids in position
// order. The read is GET /api/desk?since=, grouped and bounded by the
// backend after staleness. Pure, so every mapping is tested without a DOM;
// api/desk.ts does the requests, desk-query.ts the queries, and DeskPage.tsx
// and DeskToggle.tsx render what comes out.
//
// A reading's own place on the desk is its `desk_position`, on the list row
// and the reading detail. Whether the desk is full, and what comes next in a
// session, is what is on the desk under `onDeskQueryKey` (on-desk-query.ts):
// read from GET /api/desk wherever a toggle or the session bar is shown, and
// replaced by each write's answer.

export const DESK_CAP = 3;
export const DESK_FULL_COPY = "Three readings at a time";
export const DESK_NOT_READY_COPY = "Only ready readings can go on the desk";

/**
 * Everything the desk writes refresh; what is on the desk, the home page's
 * read and the digest preview (digest-preview.ts) sit under it.
 */
export const DESK_QUERY_ROOT = ["desk"] as const;
export const onDeskQueryKey = ["desk", "on"] as const;

/** A reading on the desk, in position order. The title names the next reading in a session. */
export interface OnDeskEntry {
  id: string;
  title?: string;
}

/**
 * The desk a write answered with, as ids in position order, named from what
 * this page already knew and the reading the write was for. The refetch the
 * write starts fills in anything else.
 */
export function onDeskAfterWrite(
  known: readonly OnDeskEntry[] | undefined,
  ids: readonly string[],
  written?: OnDeskEntry,
): OnDeskEntry[] {
  return ids.map((id) => known?.find((entry) => entry.id === id) ?? (written?.id === id ? written : { id }));
}

/** The home page's read for one visit; `visit` is the visit's `previous`, stable while it lasts. */
export function deskHomeQueryKey(visit: number): readonly unknown[] {
  return ["desk", "home", visit];
}

export const DeskReadSchema = z.looseObject({
  on_desk: z.array(LibraryRowSchema),
  needs_you: z.array(LibraryRowSchema),
  needs_you_total: z.number(),
  processing: z.array(LibraryRowSchema),
  processing_total: z.number(),
  ready_since: z.array(LibraryRowSchema),
  ready_since_total: z.number(),
});
export interface DeskRead {
  on_desk: LibraryRow[];
  needs_you: LibraryRow[];
  needs_you_total: number;
  processing: LibraryRow[];
  processing_total: number;
  ready_since: LibraryRow[];
  ready_since_total: number;
}

export type DeskResult = AccountRead<DeskRead>;

export function deskFromResponse(status: number, body: unknown): DeskResult {
  if (status === 200) {
    const parsed = DeskReadSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "desk returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `desk returned ${status}`);
}

/** Server renders: forward the incoming Cookie header and host, pinned to this render's identity. */
export async function readDeskFromBackend(
  backend: BackendReads,
  request: Request,
  since: string | undefined,
  expectedTenant: string | undefined,
): Promise<DeskResult> {
  let result;
  try {
    result = await backend.desk({
      ...forwardedFrom(request),
      ...(since === undefined ? {} : { since }),
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    });
  } catch (err) {
    throw new ApiError(0, `backend entrypoint failed: ${String(err)}`);
  }
  return deskFromResponse(result.status, result.body);
}

// The visit (design spec, The visit): "Ready since" needs the previous visit,
// kept in a first-party cookie with no identity, like the theme, so the
// server render can read it. The value is `{previous, latest}` in epoch
// milliseconds, written as "previous.latest". A gap of more than two hours
// starts a new visit, so "Ready since" holds still while the reader moves
// around. The browser writes the cookie after hydration (DeskPage.tsx).

export const VISIT_COOKIE = "rl_visit";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const VISIT_GAP_MS = 2 * HOUR_MS;
export const FIRST_VISIT_MS = 7 * DAY_MS;
export const VISIT_CAP_MS = 14 * DAY_MS;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface Visit {
  previous: number;
  latest: number;
}

/** The desk rendering at `now`: what "Ready since" covers, and the cookie to write. */
export interface VisitAt {
  since: number;
  next: Visit;
}

export function parseVisit(value: string | null | undefined): Visit | undefined {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const previous = Number(match[1]);
  const latest = Number(match[2]);
  return previous <= latest ? { previous, latest } : undefined;
}

export function visitAt(value: string | null | undefined, now: number): VisitAt {
  const stored = parseVisit(value);
  if (!stored) {
    const previous = now - FIRST_VISIT_MS;
    return { since: previous, next: { previous, latest: now } };
  }
  const previous = now - stored.latest > VISIT_GAP_MS ? stored.latest : stored.previous;
  return { since: Math.max(previous, now - VISIT_CAP_MS), next: { previous, latest: now } };
}

export function readVisitFromCookieHeader(header: string | null | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === VISIT_COOKIE) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function serializeVisitCookie(visit: Visit, { secure }: { secure: boolean }): string {
  const cookie = `${VISIT_COOKIE}=${visit.previous}.${visit.latest}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  return secure ? `${cookie}; Secure` : cookie;
}

/** What a Needs you row says: the failure's headline, prefixed when a reprocess failed over a reading still ready. */
export function needsYouLine(row: LibraryRow): string {
  const failure = failureOf(row);
  const headline = failure ? categorize(failure).headline : "Processing failed.";
  return reprocessFailed(row) ? `Reprocess failed · ${headline}` : headline;
}

/**
 * How long ago `iso` was at `now`: "just now", "12 min ago", "3 h ago",
 * "2 days ago", then the date. `now` is the visit's own render time, so the
 * server render and hydration say the same thing.
 */
export function agoLabel(iso: string | undefined, now: number): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return dateOn(iso);
}

const STAGE_LABELS: ReadonlyMap<string, "Fetching" | "Analyzing" | "Publishing"> = new Map([
  ...(["queued", "fetch_source", "prepare_markdown", "write_raw", "write_extracted"] as const).map(
    (stage) => [stage, "Fetching"] as const,
  ),
  ...(["embed_source", "query_similar", "summarize", "embed_summary"] as const).map(
    (stage) => [stage, "Analyzing"] as const,
  ),
  ...(["upsert_vector", "write_manifest", "write_indexes", "send_email"] as const).map(
    (stage) => [stage, "Publishing"] as const,
  ),
]);

/** A processing row's stage in the reader's words; a stage added later is just "Processing". */
export function stageLabel(stage: string | undefined): "Fetching" | "Analyzing" | "Publishing" | "Processing" {
  return (stage === undefined ? undefined : STAGE_LABELS.get(stage)) ?? "Processing";
}

const DeskWriteSchema = z.looseObject({ desk: z.array(z.string()).max(DESK_CAP) });

export type DeskWriteOutcome =
  | { kind: "desk"; desk: string[] }
  | { kind: "full" }
  | { kind: "not-ready" }
  | { kind: "not-found" }
  | AccountRefusal;

export function deskWriteFromResponse(status: number, body: unknown): DeskWriteOutcome {
  if (status === 200) {
    const parsed = DeskWriteSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "desk returned an unexpected body");
    return { kind: "desk", desk: parsed.data.desk };
  }
  if (status === 404) return { kind: "not-found" };
  if (status === 409) {
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    if (code === "desk_full") return { kind: "full" };
    if (code === "not_ready") return { kind: "not-ready" };
  }
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `desk returned ${status}`);
}

/** Whether a reading not already on the desk can be put there, by the last desk this page saw. */
export function deskIsFullFor(id: string, knownDesk: readonly OnDeskEntry[] | undefined): boolean {
  return knownDesk !== undefined && !knownDesk.some((entry) => entry.id === id) && knownDesk.length >= DESK_CAP;
}

/** Where a reading sits in a session, from what is on the desk: n of m, and the reading after it. */
export interface SessionPlace {
  position: number;
  count: number;
  next?: OnDeskEntry;
}

export function sessionPlaceOf(id: string, onDesk: readonly OnDeskEntry[]): SessionPlace | undefined {
  const index = onDesk.findIndex((entry) => entry.id === id);
  if (index === -1) return undefined;
  const next = onDesk[index + 1];
  return { position: index + 1, count: onDesk.length, ...(next ? { next } : {}) };
}
