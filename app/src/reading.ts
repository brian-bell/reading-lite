import { z } from "zod";
import { ApiError } from "./api/errors";
import { forwardedFrom, type BackendReads } from "./server/backend-reads";
import type { Identity } from "./identity";

// Reading detail from GET /api/readings/:id, read through the backend
// entrypoint during a server render and from same-origin /api/readings/:id in
// the browser. Both paths map the response here, so they agree on what each
// status means.
//
// The response is the stored manifest plus `relationship_targets`
// (src/schemas/api.ts, GetReadingResponseSchema). The projection below
// declares the fields the frontend renders rather than restating the whole
// manifest: the backend's zod schemas stay authoritative, unknown fields pass
// through untouched, and only a malformed field this app reads fails the
// parse (#371, from the #390 review thread).
//
// Leniency is deliberate. Old manifests are missing fields by design (fixture
// `old-manifest`), and a manifest can carry `null` where a field was cleared
// (fixture `gardens`, `tensions: null`), so every optional field is also
// null-tolerant and normalised to absent. Only `id`, `url`, and `status` are
// load-bearing.

/**
 * ProcessingStageSchema in the backend's src/schemas/manifest.ts, for the
 * label maps. The projection below keeps `stage` an open string: a stage the
 * backend adds later must not fail the page (ReadingStatusCard and
 * reading-failure.ts already degrade on one they do not know).
 */
export const ProcessingStageSchema = z.enum([
  "queued",
  "fetch_source",
  "prepare_markdown",
  "write_raw",
  "write_extracted",
  "embed_source",
  "query_similar",
  "summarize",
  "embed_summary",
  "upsert_vector",
  "write_manifest",
  "write_indexes",
  "send_email",
]);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

export const ReadingStatusSchema = z.enum(["pending", "ready", "failed"]);
export type ReadingStatus = z.infer<typeof ReadingStatusSchema>;

/**
 * The declared fields of a loose schema's output, without the `[k: string]:
 * unknown` index signature `z.looseObject` adds. Unknown fields still pass
 * through at runtime; the type just keeps a misspelt property a compile error,
 * as the hand-written interfaces before this projection did.
 */
type Declared<T> = { [K in keyof T as string extends K ? never : K]: T[K] };

/**
 * An optional field that may also arrive as `null`. A cleared field reads as
 * an absent one, so components test `=== undefined` and nothing else.
 */
export function absent<T extends z.ZodType>(schema: T) {
  return schema
    .nullable()
    .transform((value) => value ?? undefined)
    .optional();
}

/** ManifestErrorSchema. `code` is the backend error class name, or a stale_* marker. */
export const ReadingErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  stage: absent(z.string()),
  failed_at: absent(z.string()),
  retryable: absent(z.boolean()),
});
export type ReadingError = Declared<z.output<typeof ReadingErrorSchema>>;

/**
 * ProcessingAttemptSummarySchema. `trigger` and `status` are closed enums in
 * the backend ("submit" | "reprocess" | "import"; "running" | "succeeded" |
 * "failed"), open here for the same reason as `stage`.
 */
export const ProcessingAttemptSchema = z.looseObject({
  id: z.string(),
  trigger: z.string(),
  status: z.string(),
  stage: absent(z.string()),
  started_at: z.string(),
  finished_at: absent(z.string()),
  error: absent(ReadingErrorSchema),
});
export type ProcessingAttempt = Declared<z.output<typeof ProcessingAttemptSchema>>;

export const SimilaritySnapshotSchema = z.looseObject({
  count: absent(z.number()),
  max: absent(z.number()),
  mean: absent(z.number()),
  computed_at: absent(z.string()),
});
export type SimilaritySnapshot = Declared<z.output<typeof SimilaritySnapshotSchema>>;

/**
 * EnrichmentDegradationSchema. Written when YouTube watch-page or transcript
 * enrichment missed and the reading became ready on the oEmbed floor. `tier`
 * is a closed enum in the backend ("watch_page" | "transcript"), kept open
 * here so a tier this app has no sentence for stays quiet rather than
 * narrowing wrongly (see `degradationNotice`).
 */
export const EnrichmentDegradationSchema = z.looseObject({
  source: absent(z.string()),
  tier: absent(z.string()),
  code: absent(z.string()),
  message: absent(z.string()),
});
export type EnrichmentDegradation = Declared<z.output<typeof EnrichmentDegradationSchema>>;

/** ConnectionSchema: a related reading and why it was suggested. */
export const ConnectionSchema = z.looseObject({
  id: z.string(),
  reason: z.string(),
});
export type Connection = Declared<z.output<typeof ConnectionSchema>>;

/**
 * TensionSchema. `kind` is a closed enum in the backend (contradicts,
 * supersedes, superseded_by, qualifies, qualified_by), kept open here so a
 * kind added later renders with a generic label instead of failing the page
 * (see `tensionKindLabel`).
 */
export const TensionSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  reason: z.string(),
  computed_at: absent(z.string()),
});
export type Tension = Declared<z.output<typeof TensionSchema>>;

/**
 * RelationshipTargetSchema: what the same tenant's list index knows about a
 * connection or tension target, computed on read. An id absent from the map
 * is removed or unavailable.
 */
export const RelationshipTargetSchema = z.looseObject({
  url: z.string(),
  title: absent(z.string()),
  status: ReadingStatusSchema,
});
export type RelationshipTarget = Declared<z.output<typeof RelationshipTargetSchema>>;

export const ReadingSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  status: ReadingStatusSchema,
  title: absent(z.string()),
  tldr: absent(z.string()),
  summary_markdown: absent(z.string()),
  tags: absent(z.array(z.string())),
  keywords: absent(z.array(z.string())),
  people: absent(z.array(z.string())),
  orgs: absent(z.array(z.string())),
  source_type: absent(z.string()),
  content_status: absent(z.string()),
  created_at: absent(z.string()),
  updated_at: absent(z.string()),
  novelty_verdict: absent(z.string()),
  similarity: absent(SimilaritySnapshotSchema),
  enrichment_degradation: absent(EnrichmentDegradationSchema),
  error: absent(ReadingErrorSchema),
  active_attempt: absent(ProcessingAttemptSchema),
  last_attempt: absent(ProcessingAttemptSchema),
  connections: absent(z.array(ConnectionSchema)),
  connections_computed_at: absent(z.string()),
  tensions: absent(z.array(TensionSchema)),
  relationship_targets: absent(z.record(z.string(), RelationshipTargetSchema)),
});
export type Reading = Declared<z.output<typeof ReadingSchema>>;

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
    const parsed = ReadingSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "reading returned an unexpected body");
    return { state: "ready", reading: parsed.data };
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

/** The backend error envelope's `error` string, when it is one. */
export function messageOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error !== "" ? error : undefined;
}

/** The `acting_tenant` a 412 names, when it names one. */
export function actingTenantOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const acting = (body as { acting_tenant?: unknown }).acting_tenant;
  return typeof acting === "string" ? acting : undefined;
}
