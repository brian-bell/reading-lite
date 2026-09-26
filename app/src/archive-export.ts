import { z } from "zod";
import type { AccountRead, AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";
import { dateTimeOn } from "./reading-presentation";

// Full-archive export on the account page (reading-lite-mxwx.5; ADR 0004,
// "Archive export"): GET /api/exports/latest and POST /api/exports. Fetched
// in the browser only, like the sessions list (ADR 0003). The projection
// mirrors GetArchiveExportLatestResponseSchema (src/schemas/api.ts); unknown
// fields pass through, and a malformed one is the retryable "unexpected body"
// error rather than a crash in a component.
//
// The limits are the backend's: one export queued or building at a time, and
// one counted request (queued, building, or ready) per rolling day. A failed,
// expired, or cancelled export frees the day's slot. Exporting calls no AI
// provider, so it is a hosting limit and works without a provider key.

export const ArchiveExportStatusSchema = z.enum(["queued", "building", "ready", "failed", "expired", "cancelled"]);
export type ArchiveExportStatus = z.infer<typeof ArchiveExportStatusSchema>;

export const ArchiveExportSchema = z.looseObject({
  id: z.string().min(1),
  status: ArchiveExportStatusSchema,
  requested_at: z.string().min(1),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  error: z.looseObject({ code: z.string().min(1) }).nullable(),
});
export type ArchiveExport = z.infer<typeof ArchiveExportSchema>;

export const ExportLatestSchema = z.looseObject({
  export: ArchiveExportSchema.nullable(),
  next_allowed_at: z.string().min(1),
});
export interface ExportLatest {
  export: ArchiveExport | null;
  next_allowed_at: string;
}

/** Account-scoped, so sign-in and sign-out drop it (src/auth/session.ts). */
export function exportsQueryKey(userId: string): readonly unknown[] {
  return ["exports", userId];
}

export type ExportsResult = AccountRead<ExportLatest>;

export function latestExportFromResponse(status: number, body: unknown): ExportsResult {
  if (status === 200) {
    const parsed = ExportLatestSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(200, "export status returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `export status returned ${status}`);
}

/**
 * What POST /api/exports answered. `active` (409) and `limited` (429) are the
 * two limits; `unavailable` (503) is a queue that could not take the job. A
 * 403 or 412 is a value, as for every account write; a 401 and anything else
 * throw.
 */
export type ExportRequestOutcome =
  | { kind: "queued"; id: string }
  | { kind: "active" }
  | { kind: "limited"; resetAt?: string }
  | { kind: "unavailable" }
  | AccountRefusal;

const DailyLimitSchema = z.looseObject({
  limit: z.literal("daily_export"),
  // A reset the page cannot format is worth less than the refusal itself.
  reset_at: z.string().min(1).optional().catch(undefined),
});

export function exportRequestFromResponse(status: number, body: unknown): ExportRequestOutcome {
  if (status === 202) {
    const parsed = z.looseObject({ id: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new ApiError(202, "export request returned an unexpected body");
    return { kind: "queued", id: parsed.data.id };
  }
  if (status === 409) return { kind: "active" };
  if (status === 429) {
    const parsed = DailyLimitSchema.safeParse(body);
    if (parsed.success) return { kind: "limited", resetAt: parsed.data.reset_at };
  }
  if (status === 503) return { kind: "unavailable" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to request an export");
}

/** How often the page reads the status while an export is queued or building. */
export const EXPORT_POLL_MS = 10_000;

/**
 * Whether the page should keep reading the status. Only while the backend is
 * still working on it: a deliberate exception to "never poll pending
 * manifests", which is about readings (the epic's design, reading-lite-mxwx).
 */
export function exportInProgress(result: ExportsResult | undefined): boolean {
  if (result?.state !== "ready") return false;
  const status = result.value.export?.status;
  return status === "queued" || status === "building";
}

/**
 * When a new export may be requested, if not now. `next_allowed_at` is the
 * backend's own answer (now when nothing counted is inside the rolling day);
 * an unreadable one never locks the button, since the backend refuses anyway.
 */
export function nextRequestAtMs(latest: ExportLatest, nowMs: number): number | undefined {
  const ms = Date.parse(latest.next_allowed_at);
  return Number.isNaN(ms) || ms <= nowMs ? undefined : ms;
}

/** Stated with the section: the limits, and that no provider key is needed. */
export const EXPORT_LIMITS =
  "You can have one export in progress and request one a day. Exporting is a Reading Lite hosting limit, not an AI provider's, so it works without a provider key.";

/** The 409: another export is still queued or building. */
export const EXPORT_ACTIVE = "An export is already in progress. Only one can run at a time.";

/** The 429, in the words of capture's limitSentence (capture-refusal.ts). */
export function exportLimitSentence(resetAt: string | undefined): string {
  const reached = "You've reached the daily export limit.";
  const resets = dateTimeOn(resetAt);
  return resets ? `${reached} You can request another at ${resets}.` : reached;
}

/** Why the Request button is off until `nextMs`, while nothing is running. */
export function nextRequestSentence(nextMs: number): string {
  return `You can request another export at ${dateTimeOn(new Date(nextMs).toISOString())}.`;
}

/**
 * Why the last export failed, in the reader's terms. Only the ZIP32 limit is
 * worth naming: asking again builds the same too-large archive. Every other
 * failure frees the day's slot, so the reader can ask again at once.
 */
export function exportFailureSentence(code: string | undefined): string {
  if (code === "zip_limit") {
    return "Your last export failed: the library is too large for one archive (more than 65,535 files or 4 GiB). Asking again won't help yet.";
  }
  return "Your last export failed. You can request another now.";
}

/** The download for a ready export: a plain same-origin link, never a blob fetch. */
export function exportDownloadHref(id: string): string {
  return `/api/exports/${encodeURIComponent(id)}/download`;
}
