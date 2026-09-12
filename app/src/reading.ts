import { ApiError } from "./api/errors";
import { forwardedFrom, type BackendReads } from "./server/backend-reads";
import type { Identity } from "./identity";

// Reading detail from GET /api/readings/:id, read through the backend
// entrypoint during a server render and from same-origin /api/readings/:id in
// the browser. Both paths map the response here, so they agree on what each
// status means.
//
// The response is the stored manifest plus `relationship_targets`
// (src/schemas/api.ts, GetReadingResponseSchema). This declares the fields the
// frontend renders rather than restating the whole manifest: the backend's zod
// schemas stay authoritative, and a field this app never reads cannot fail its
// narrowing. Later slices add the fields they need — #371 relationships, #372
// source, #373 details.

/** ProcessingStageSchema in the backend's src/schemas/manifest.ts. */
export type ProcessingStage =
  | "queued"
  | "fetch_source"
  | "prepare_markdown"
  | "write_raw"
  | "write_extracted"
  | "embed_source"
  | "query_similar"
  | "summarize"
  | "embed_summary"
  | "upsert_vector"
  | "write_manifest"
  | "write_indexes"
  | "send_email";

export type ReadingStatus = "pending" | "ready" | "failed";

/** ManifestErrorSchema. `code` is the backend error class name, or a stale_* marker. */
export interface ReadingError {
  code: string;
  message: string;
  stage?: ProcessingStage;
  failed_at?: string;
  retryable?: boolean;
}

/** ProcessingAttemptSummarySchema. */
export interface ProcessingAttempt {
  id: string;
  trigger: "submit" | "reprocess" | "import";
  status: "running" | "succeeded" | "failed";
  stage?: ProcessingStage;
  started_at: string;
  finished_at?: string;
  error?: ReadingError;
}

export interface SimilaritySnapshot {
  count?: number;
  max?: number;
  mean?: number;
  computed_at?: string;
}

export interface EnrichmentDegradation {
  source?: string;
  tier?: string;
  reason?: string;
}

export interface Reading {
  id: string;
  url: string;
  status: ReadingStatus;
  title?: string;
  tldr?: string;
  summary_markdown?: string;
  tags?: string[];
  source_type?: string;
  content_status?: string;
  created_at?: string;
  updated_at?: string;
  novelty_verdict?: string;
  similarity?: SimilaritySnapshot;
  enrichment_degradation?: EnrichmentDegradation;
  error?: ReadingError;
  active_attempt?: ProcessingAttempt;
  last_attempt?: ProcessingAttempt;
}

export function readingQueryKey(id: string): readonly unknown[] {
  return ["reading", id];
}

/**
 * What a reader sees for one reading id.
 *
 * The statuses the acceptance matrix gives a page to are values, not thrown
 * errors, so they dehydrate with the rest of the cache and the browser renders
 * the server's answer without asking again. A 401 (session ended) and anything
 * unexpected throw instead: 401 drives the shell's expired-session page through
 * `isUnauthorized`, and an unexpected status is the retryable server-error
 * state, which should not be frozen into the hydrated cache.
 */
export type ReadingResult =
  | { state: "ready"; reading: Reading }
  | { state: "not-found" }
  | { state: "forbidden" }
  | { state: "account-changed"; acting_tenant?: string };

/**
 * The layout an `x-expected-tenant` pin names (backend `requireExpectedTenant`):
 * the principal's tenant with the data-plane gate on, the pre-tenant global
 * layout with it off. Pinning the read to the identity the page was rendered
 * for turns "another tab signed this browser into a different account" into a
 * 412 the reader can act on, instead of a silent render of someone else's
 * reading.
 */
export function expectedLayoutOf(identity: Identity | null | undefined): string | undefined {
  if (!identity) return undefined;
  return identity.tenant_data_plane ? identity.tenant_id : "global";
}

export function readingFromResponse(status: number, body: unknown): ReadingResult {
  if (status === 200) {
    if (!isReading(body)) throw new ApiError(status, "reading returned an unexpected body");
    return { state: "ready", reading: body };
  }
  if (status === 404) return { state: "not-found" };
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `reading returned ${status}`);
}

/** Server renders: forward the incoming Cookie header and host, pinned to this render's identity. */
export async function readReadingFromBackend(
  backend: BackendReads,
  request: Request,
  id: string,
  expectedTenant: string | undefined,
): Promise<ReadingResult> {
  let result;
  try {
    result = await backend.reading({
      ...forwardedFrom(request),
      id,
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    });
  } catch (err) {
    throw new ApiError(0, `backend entrypoint failed: ${String(err)}`);
  }
  return readingFromResponse(result.status, result.body);
}

/**
 * Only what the frontend depends on. Everything else travels untouched, so a
 * manifest field this slice does not render cannot turn a readable page into an
 * error — old manifests are missing fields by design (fixture `old-manifest`).
 */
function isReading(body: unknown): body is Reading {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Record<string, unknown>;
  return (
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    (value.status === "pending" || value.status === "ready" || value.status === "failed")
  );
}

function messageOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error !== "" ? error : undefined;
}

function actingTenantOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const acting = (body as { acting_tenant?: unknown }).acting_tenant;
  return typeof acting === "string" ? acting : undefined;
}
