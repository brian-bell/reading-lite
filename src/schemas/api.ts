import { z } from "zod";
import { isDigestHourLocal, isDigestWeekday, isIanaTimeZone } from "../modules/time-zone";
import {
  ByUrlPointerSchema,
  EnrichmentDegradationSchema,
  ManifestErrorSchema,
  ManifestSchema,
  ManifestStatusSchema,
  NoveltyVerdictSchema,
  ProcessingAttemptSchema,
  ProcessingAttemptSummarySchema,
  SimilaritySnapshotSchema,
} from "./manifest";

const webUrl = () =>
  z
    .string()
    .url()
    .refine((u) => /^https?:/i.test(u), { message: "url must be http(s)" });

export const PostReadingsBodySchema = z.object({
  url: webUrl(),
  email: z.boolean().optional(),
});
export type PostReadingsBody = z.infer<typeof PostReadingsBodySchema>;

export const PostReadingsImportMarkdownBodySchema = z.object({
  source_url: webUrl(),
  title: z.string().trim().min(1).optional(),
  markdown: z.string().min(1),
  email: z.boolean().optional(),
});
export type PostReadingsImportMarkdownBody = z.infer<
  typeof PostReadingsImportMarkdownBodySchema
>;

// A reprocess may carry the content to reprocess with. Field rules mirror
// import-markdown above so the two write paths validate identically. Only
// markdown is accepted: a url reprocess is the no-source default.
export const ReprocessMarkdownSourceSchema = z.object({
  kind: z.literal("markdown"),
  markdown: z.string().min(1),
  title: z.string().trim().min(1).optional(),
});

export const PostReadingReprocessBodySchema = z
  .object({
    force: z.boolean().default(false),
    email: z.boolean().optional(),
    source: ReprocessMarkdownSourceSchema.optional(),
  })
  .default({ force: false });
export type PostReadingReprocessBody = z.infer<typeof PostReadingReprocessBodySchema>;

// GET /api/whoami: the authenticated principal's own identity, so operator
// tooling can verify which tenant a bearer token acts as before submitting
// writes through the API (reading-lite-1xk). `tenant_data_plane` reports
// whether TENANT_DATA_PLANE=1 — with the gate off every write lands on the
// pre-tenant global layout, with it on every write lands under the principal's
// tenant namespace, and the caller cannot soundly plan writes without knowing
// which.
export const GetWhoamiResponseSchema = z.object({
  tenant_id: z.string(),
  user_id: z.string(),
  principal: z.enum(["api_token", "session"]),
  tenant_data_plane: z.boolean(),
  email: z.string(),
  // Session principals only. Bearer whoami must omit this field.
  csrf_token: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type GetWhoamiResponse = z.infer<typeof GetWhoamiResponseSchema>;

export const AuthChallengeBodySchema = z.object({
  email: z.string().min(1),
  // Widget-less clients may send JSON null. Null/blank must parse as omitted
  // (never 400) so invite_only/closed ignore extras and open skips send with
  // generic {ok:true}.
  turnstile_token: z
    .string()
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
});
export type AuthChallengeBody = z.infer<typeof AuthChallengeBodySchema>;

export const AuthRedeemBodySchema = z.object({
  credential: z.string().min(1),
  redemption_id: z.string().min(1),
});
export type AuthRedeemBody = z.infer<typeof AuthRedeemBodySchema>;

export const AuthEmailChangeBodySchema = z.object({
  email: z.string().min(1),
});
export type AuthEmailChangeBody = z.infer<typeof AuthEmailChangeBodySchema>;

export const AuthLoginOptionsResponseSchema = z.object({
  turnstile_site_key: z.string().min(1).nullable(),
});
export type AuthLoginOptionsResponse = z.infer<typeof AuthLoginOptionsResponseSchema>;

export const SessionListItemSchema = z.object({
  id: z.string().min(1),
  current: z.boolean(),
  created_at_ms: z.number().int(),
  authenticated_at_ms: z.number().int(),
  last_seen_at_ms: z.number().int(),
  idle_expires_at_ms: z.number().int(),
  absolute_expires_at_ms: z.number().int(),
  revoked_at_ms: z.number().int().nullable(),
  revocation_reason: z.string().nullable(),
  user_agent_label: z.string().nullable(),
  usable: z.boolean(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionListItemSchema),
  session_cap_warning: z.string().nullable(),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const AuthSessionRevokeResponseSchema = z.object({
  ok: z.literal(true),
});
export type AuthSessionRevokeResponse = z.infer<typeof AuthSessionRevokeResponseSchema>;

// DELETE /api/account: session-only, CSRF, recent-auth. Explicit confirm is
// the string literal "delete" so a stray `{ confirm: true }` cannot fire.
// This starts suppression (status=deleting + credential revoke). It is not
// DELETE /api/readings/:id (one-reading purge) and does not wipe R2 inline
// (195b wipe is a deferred ACCOUNT_WIPE_JOBS job).
export const DeleteAccountBodySchema = z.object({
  confirm: z.literal("delete"),
});
export type DeleteAccountBody = z.infer<typeof DeleteAccountBodySchema>;

export const DeleteAccountResponseSchema = AuthSessionRevokeResponseSchema;
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;

const ApiScopeNameSchema = z.enum(["readings:read", "readings:write", "readings:import", "readings:delete"]);

export const PostAuthTokensBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(ApiScopeNameSchema).min(1),
  expires_at_ms: z.number().int().optional(),
});
export type PostAuthTokensBody = z.infer<typeof PostAuthTokensBodySchema>;

export const PostAuthTokensResponseSchema = z.object({
  token: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  scopes: z.array(ApiScopeNameSchema),
  created_at_ms: z.number().int(),
  expires_at_ms: z.number().int(),
});
export type PostAuthTokensResponse = z.infer<typeof PostAuthTokensResponseSchema>;

export const ApiTokenListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  format: z.enum(["legacy", "standard"]),
  scopes: z.array(ApiScopeNameSchema),
  created_at_ms: z.number().int(),
  expires_at_ms: z.number().int(),
  revoked_at_ms: z.number().int().nullable(),
  last_used_at_ms: z.number().int().nullable(),
  user_agent_label: z.string().nullable(),
  usable: z.boolean(),
});
export type ApiTokenListItem = z.infer<typeof ApiTokenListItemSchema>;

export const ListTokensResponseSchema = z.object({
  tokens: z.array(ApiTokenListItemSchema),
});
export type ListTokensResponse = z.infer<typeof ListTokensResponseSchema>;

export const AuthTokenRevokeResponseSchema = AuthSessionRevokeResponseSchema;
export type AuthTokenRevokeResponse = z.infer<typeof AuthTokenRevokeResponseSchema>;

export const DigestCadenceSchema = z.enum(["off", "daily", "weekly"]);
export type DigestCadence = z.infer<typeof DigestCadenceSchema>;

/** GET /api/auth/settings and POST 200: the caller's full `user_settings` row. */
export const UserSettingsResponseSchema = z.object({
  user_id: z.string().min(1),
  schema_version: z.number().int(),
  notify_immediate: z.boolean(),
  digest_cadence: DigestCadenceSchema,
  time_zone: z.string().min(1),
  digest_hour_local: z.number().int(),
  digest_weekday: z.number().int(),
  created_at_ms: z.number().int(),
  updated_at_ms: z.number().int(),
});
export type UserSettingsResponse = z.infer<typeof UserSettingsResponseSchema>;

const TimeZoneSchema = z.string().min(1).refine(isIanaTimeZone);
const DigestHourLocalSchema = z.number().refine(isDigestHourLocal);
const DigestWeekdaySchema = z.number().refine(isDigestWeekday);

/**
 * POST /api/auth/settings: `notify_immediate` plus optional digest schedule
 * fields. Digest opt-out is `digest_cadence: "off"`; hour, weekday, and time
 * zone are still stored when cadence is off.
 */
export const PostAuthSettingsBodySchema = z.object({
  notify_immediate: z.boolean(),
  digest_cadence: DigestCadenceSchema.optional(),
  time_zone: TimeZoneSchema.optional(),
  digest_hour_local: DigestHourLocalSchema.optional(),
  digest_weekday: DigestWeekdaySchema.optional(),
});
export type PostAuthSettingsBody = z.infer<typeof PostAuthSettingsBodySchema>;

export const SummarizationEffortSchema = z.enum(["low", "medium", "high"]);
export type SummarizationEffort = z.infer<typeof SummarizationEffortSchema>;

export const ProviderCredentialViewSchema = z.object({
  provider: z.literal("openai"),
  last_four: z.string().length(4),
  status: z.enum(["active", "invalid"]),
  validated_at_ms: z.number().int().nullable(),
});
export type ProviderCredentialView = z.infer<typeof ProviderCredentialViewSchema>;

/**
 * GET /api/auth/provider and the write responses. `daily_spend_cap_microdollars`
 * is the reader's own cap (null when they have not lowered it). Effective spend
 * is that cap when it is set and still under the operator default, otherwise
 * the operator default. `key_required` is true when tenant provider keys are on,
 * so reading work runs only under the reader's own active key and intake
 * refuses it (409 `provider_key_required`) without one.
 */
export const ProviderSettingsResponseSchema = z.object({
  credential: ProviderCredentialViewSchema.nullable(),
  key_required: z.boolean(),
  effort: SummarizationEffortSchema,
  daily_spend_cap_microdollars: z.number().int().positive().nullable(),
  effective_daily_spend_microdollars: z.number().int().positive(),
  operator_daily_spend_microdollars: z.number().int().positive(),
});
export type ProviderSettingsResponse = z.infer<typeof ProviderSettingsResponseSchema>;

/**
 * GET /api/auth/provider/usage: today's UTC spend charged against the reader's
 * tenant budget, as the spend guard counts it. Charged includes unsettled
 * maxima and unused holds, so it is not a provider invoice, and it counts
 * operator-funded work billed to this tenant as well as the reader's own.
 */
export const ProviderUsageResponseSchema = z.object({
  day_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  charged_microdollars: z.number().int().nonnegative(),
  effective_daily_spend_microdollars: z.number().int().positive(),
  reset_at_ms: z.number().int().nonnegative(),
  observed_at_ms: z.number().int().nonnegative(),
});
export type ProviderUsageResponse = z.infer<typeof ProviderUsageResponseSchema>;

export const PostProviderKeyBodySchema = z.object({
  api_key: z.string().min(4).max(256).regex(/^\S+$/),
});
export type PostProviderKeyBody = z.infer<typeof PostProviderKeyBodySchema>;

/** A null cap clears the reader's override. */
export const PostProviderPreferencesBodySchema = z
  .object({
    effort: SummarizationEffortSchema.optional(),
    daily_spend_cap_microdollars: z.number().int().positive().nullable().optional(),
  })
  .refine((body) => body.effort !== undefined || body.daily_spend_cap_microdollars !== undefined);
export type PostProviderPreferencesBody = z.infer<typeof PostProviderPreferencesBodySchema>;

export const ProviderSettingsErrorSchema = z.object({
  error: z.string().min(1),
  code: z.enum(["invalid_key", "model_access", "provider_unavailable", "cap_above_operator_default"]),
});
export type ProviderSettingsError = z.infer<typeof ProviderSettingsErrorSchema>;

// Optional layout pin on /api/readings requests: `usr_{id}` or 'global'. A
// whoami preflight is point-in-time — the gate could flip, or a rolling deploy
// could route a later write to a different worker version. A client that sends
// this header binds its expectation to each request instead: the worker
// compares it against the layout the request would actually act on and rejects
// a mismatch with 412 before touching any store. Absent header = no pin
// (existing clients are unaffected).
export const EXPECTED_TENANT_HEADER = "x-expected-tenant";

/** Session-bound CSRF HMAC. Required on cookie POST/DELETE; bearer is exempt. */
export const CSRF_HEADER = "x-csrf-token";

export const EMBEDDING_DIM = 1536;

export const PostReadingsSimilarBodySchema = z.object({
  query_embedding: z.array(z.number()).length(EMBEDDING_DIM),
  k: z.number().int().min(1).max(50).default(10),
});
export type PostReadingsSimilarBody = z.infer<typeof PostReadingsSimilarBodySchema>;

const intParam = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be an integer` });
        return z.NEVER;
      }
      return n;
    });

export const ListReadingsQuerySchema = z.object({
  q: z.string().optional(),
  tag: z.string().optional(),
  offset: intParam("offset").pipe(z.number().int().min(0)).default(0),
  limit: intParam("limit").pipe(z.number().int().min(1).max(100)).default(20),
});
export type ListReadingsQuery = z.infer<typeof ListReadingsQuerySchema>;

export const ListIndexItemSchema = z.object({
  id: z.string().min(1),
  key_prefix: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1).optional(),
  tldr: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  status: ManifestStatusSchema,
  novelty_verdict: NoveltyVerdictSchema.optional(),
  similarity: SimilaritySnapshotSchema.optional(),
  source_date: z.string().date().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  error: ManifestErrorSchema.optional(),
  active_attempt: ProcessingAttemptSummarySchema.optional(),
  last_attempt: ProcessingAttemptSummarySchema.optional(),
  enrichment_degradation: EnrichmentDegradationSchema.optional(),
});
export type ListIndexItem = z.infer<typeof ListIndexItemSchema>;

export const ListIndexSchema = z.object({
  version: z.literal(1),
  items: z.array(ListIndexItemSchema),
});
export type ListIndex = z.infer<typeof ListIndexSchema>;

export const ListReadingsResponseSchema = z.object({
  readings: z.array(ListIndexItemSchema),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type ListReadingsResponse = z.infer<typeof ListReadingsResponseSchema>;

// Read-time enrichment on GET /api/readings/:id: each connection and tension
// target id resolved against the same tenant's list index. Response-only — the
// stored ManifestSchema never carries it. An id absent from the map is removed
// or unavailable.
export const RelationshipTargetSchema = z
  .object({
    url: z.string().url(),
    title: z.string().min(1).optional(),
    status: ManifestStatusSchema,
  })
  .strict();
export type RelationshipTarget = z.infer<typeof RelationshipTargetSchema>;

export const RelationshipTargetsSchema = z.record(z.string().min(1), RelationshipTargetSchema);
export type RelationshipTargets = z.infer<typeof RelationshipTargetsSchema>;

export const GetReadingResponseSchema = ManifestSchema.extend({
  relationship_targets: RelationshipTargetsSchema,
});
export type GetReadingResponse = z.infer<typeof GetReadingResponseSchema>;

export const SimilarItemSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string().optional(),
  tldr: z.string().optional(),
  tags: z.array(z.string()).optional(),
  created_at: z.string().datetime().optional(),
  score: z.number(),
});
export type SimilarItem = z.infer<typeof SimilarItemSchema>;

export const PostReadingsSimilarResponseSchema = z.object({
  items: z.array(SimilarItemSchema),
});
export type PostReadingsSimilarResponse = z.infer<typeof PostReadingsSimilarResponseSchema>;

export const LookupResponseSchema = z.object({
  id: z.string(),
});
export type LookupResponse = z.infer<typeof LookupResponseSchema>;

// The purge report DELETE /api/readings/:id returns. `vector_delete_requested`
// and `list_row_removed` are always true: the embedding and list row are the
// reading's own rows and go with it in one transaction. `by_url_released` is
// false when the URL belongs to a different (surviving) reading and was
// deliberately left alone.
export const DeleteReadingResponseSchema = z.object({
  id: z.string().min(1),
  vector_delete_requested: z.boolean(),
  list_row_removed: z.boolean(),
  by_url_released: z.boolean(),
  objects_deleted: z.number().int().nonnegative(),
});
export type DeleteReadingResponse = z.infer<typeof DeleteReadingResponseSchema>;

export const ReadingObjectInfoSchema = z.object({
  key: z.string().min(1),
  size: z.number().int().nonnegative(),
  uploaded: z.string().optional(),
});
export type ReadingObjectInfo = z.infer<typeof ReadingObjectInfoSchema>;

const PointerDiagnosticSchema = z.object({
  exists: z.boolean(),
  pointer: ByUrlPointerSchema.optional(),
  matches_manifest: z.boolean(),
});

export const GetReadingDiagnosticsResponseSchema = z.object({
  id: z.string().min(1),
  key_prefix: z.string().min(1),
  manifest: ManifestSchema,
  index_item: ListIndexItemSchema.nullable(),
  pointers: z.object({
    by_id: PointerDiagnosticSchema,
    by_url: PointerDiagnosticSchema,
  }),
  objects: z.array(ReadingObjectInfoSchema),
  attempts: z.array(ProcessingAttemptSchema),
});
export type GetReadingDiagnosticsResponse = z.infer<typeof GetReadingDiagnosticsResponseSchema>;

export const QuotaDeniedResponseSchema = z.object({
  error: z.string().min(1),
  code: z.enum(["rate_limited", "quota_exhausted"]),
  limit: z.enum(["request_rate", "hourly", "monthly"]),
  reset_at: z.string().datetime(),
});
export type QuotaDeniedResponse = z.infer<typeof QuotaDeniedResponseSchema>;

export const UsageGuardUnavailableResponseSchema = z.object({
  error: z.literal("usage guard unavailable"),
});
export type UsageGuardUnavailableResponse = z.infer<typeof UsageGuardUnavailableResponseSchema>;

export const ArchiveExportStatusSchema = z.enum([
  "queued",
  "building",
  "ready",
  "failed",
  "expired",
  "cancelled",
]);
export type ArchiveExportStatus = z.infer<typeof ArchiveExportStatusSchema>;

export const ArchiveExportErrorSchema = z
  .object({
    code: z.string().min(1),
  })
  .strict();
export type ArchiveExportError = z.infer<typeof ArchiveExportErrorSchema>;

export const ArchiveExportSummarySchema = z
  .object({
    id: z.string().min(1),
    status: ArchiveExportStatusSchema,
    requested_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    expires_at: z.string().datetime().nullable(),
    error: ArchiveExportErrorSchema.nullable(),
  })
  .strict();
export type ArchiveExportSummary = z.infer<typeof ArchiveExportSummarySchema>;

export const PostArchiveExportResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal("queued"),
  })
  .strict();
export type PostArchiveExportResponse = z.infer<typeof PostArchiveExportResponseSchema>;

export const ArchiveExportActiveErrorSchema = z
  .object({
    error: z.literal("export_active"),
    id: z.string().min(1),
  })
  .strict();
export type ArchiveExportActiveError = z.infer<typeof ArchiveExportActiveErrorSchema>;

export const ArchiveExportDailyLimitSchema = z
  .object({
    limit: z.literal("daily_export"),
    reset_at: z.string().datetime(),
  })
  .strict();
export type ArchiveExportDailyLimit = z.infer<typeof ArchiveExportDailyLimitSchema>;

export const GetArchiveExportLatestResponseSchema = z
  .object({
    export: ArchiveExportSummarySchema.nullable(),
    next_allowed_at: z.string().datetime(),
  })
  .strict();
export type GetArchiveExportLatestResponse = z.infer<typeof GetArchiveExportLatestResponseSchema>;

export const ArchiveExportNotReadySchema = z
  .object({
    error: z.literal("not_ready"),
  })
  .strict();
export type ArchiveExportNotReady = z.infer<typeof ArchiveExportNotReadySchema>;

// 410 from the download: the export passed expires_at and its parts are gone
// or going. The account can request a fresh one.
export const ArchiveExportExpiredSchema = z
  .object({
    error: z.literal("expired"),
  })
  .strict();
export type ArchiveExportExpired = z.infer<typeof ArchiveExportExpiredSchema>;

// export.json inside the zip. Counts are readings of every status.
export const ArchiveExportDocumentSchema = z
  .object({
    format_version: z.literal(1),
    generated_at: z.string().datetime(),
    counts: z
      .object({
        readings: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ArchiveExportDocument = z.infer<typeof ArchiveExportDocumentSchema>;

// The Markdown inbox (reading-lite-gh423). An inbox item is Markdown staged
// for a person to review before it becomes a reading; it is not in the
// library, search, similarity or /lookup until it is promoted.
//
// The byte cap is the queue envelope's: promote carries the item to the
// consumer in one Cloudflare Queues message, so an item that could not fit
// could never be promoted and stage refuses it (413). db/migrations/0008
// enforces the Markdown's outer bound; test/unit/import-markdown/app-limit.test.ts
// pins both numbers to the app's and the operator tooling's copies.
export const INBOX_MARKDOWN_MAX_BYTES = 128_000;
// What an item may cost inside that message, measured the way the app's
// Markdown import and the operator gate measure it: the JSON serialization of
// the fields promote forwards (source_url, title, markdown) in UTF-8 bytes.
// Escaping makes that more than the Markdown's length, and the reserve covers
// the envelope's fixed fields (ids, keys, the tenant).
export const INBOX_QUEUE_ENVELOPE_RESERVE = 1024;
export const INBOX_STAGE_BUDGET_BYTES = INBOX_MARKDOWN_MAX_BYTES - INBOX_QUEUE_ENVELOPE_RESERVE;
// Items per tenant. A new URL past it is refused (429 inbox_full); an
// overwrite of a staged URL never is. There is no expiry.
export const INBOX_ITEM_CAP = 200;
// A title travels in the same envelope as the Markdown, so it is bounded too:
// an unbounded one could leave an item that can never be promoted.
export const INBOX_TITLE_MAX_CHARS = 1_000;
// POST /api/inbox bodies above this are refused (413) while they are read,
// before they are parsed. Generous: JSON can spell one Markdown byte in up to
// six (`\u0001`), and the title and field names ride along.
export const INBOX_BODY_MAX_BYTES = 6 * INBOX_MARKDOWN_MAX_BYTES + 64 * 1024;

// Field rules mirror import-markdown, without `email`: whether a promote
// notifies is the promote's decision, not the stage's.
export const PostInboxBodySchema = z.object({
  source_url: webUrl(),
  title: z.string().trim().min(1).max(INBOX_TITLE_MAX_CHARS).optional(),
  markdown: z.string().min(1),
});
export type PostInboxBody = z.infer<typeof PostInboxBodySchema>;

export const InboxItemMetaSchema = z
  .object({
    id: z.string().regex(/^in_/),
    url: z.string().min(1),
    title: z.string().nullable(),
    markdown_bytes: z.number().int().positive(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type InboxItemMeta = z.infer<typeof InboxItemMetaSchema>;

export const InboxItemSchema = InboxItemMetaSchema.extend({ markdown: z.string().min(1) }).strict();
export type InboxItem = z.infer<typeof InboxItemSchema>;

// The reading that already owns the staged URL, when that owner has failed:
// promoting the item re-imports it in place.
export const InboxCorpusReadingSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal("failed"),
  })
  .strict();

// POST /api/inbox. 201 for a new item, 200 for an overwrite (`replaced`), and
// 200 `{ existing, reading }` when a ready or pending reading already owns the
// URL, in which case nothing is staged.
export const PostInboxStagedResponseSchema = z
  .object({
    inbox_item_id: z.string().regex(/^in_/),
    replaced: z.boolean(),
    corpus_reading: InboxCorpusReadingSchema.optional(),
  })
  .strict();
export type PostInboxStagedResponse = z.infer<typeof PostInboxStagedResponseSchema>;

export const PostInboxExistingResponseSchema = z
  .object({
    existing: z.literal(true),
    reading: ManifestSchema,
  })
  .strict();
export type PostInboxExistingResponse = z.infer<typeof PostInboxExistingResponseSchema>;

export const InboxMarkdownTooLargeResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.literal("markdown_too_large"),
    limit_bytes: z.literal(INBOX_STAGE_BUDGET_BYTES),
  })
  .strict();

export const InboxFullResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.literal("inbox_full"),
    limit: z.literal(INBOX_ITEM_CAP),
  })
  .strict();

export const ListInboxResponseSchema = z
  .object({
    items: z.array(InboxItemMetaSchema),
  })
  .strict();
export type ListInboxResponse = z.infer<typeof ListInboxResponseSchema>;

// POST /api/inbox/:id/promote. Whether the reading's completion notifies is
// the promote's decision; like import-markdown it defaults to silent.
export const PostInboxPromoteBodySchema = z.object({
  email: z.boolean().optional(),
});
export type PostInboxPromoteBody = z.infer<typeof PostInboxPromoteBodySchema>;

// Every promote response is the body import-markdown gives the same outcome,
// plus the item it promoted. `inbox_item_retained` appears only when the
// import succeeded but the item was re-staged meanwhile, so the newer
// Markdown stays in the inbox for review.
const InboxPromoteFields = {
  inbox_item_id: z.string().regex(/^in_/),
  inbox_item_retained: z.literal(true).optional(),
};

export const PostInboxPromoteActivatedResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal("pending"),
    poll: z.string().min(1),
    attempt_id: z.string().min(1),
    ...InboxPromoteFields,
  })
  .strict();
export type PostInboxPromoteActivatedResponse = z.infer<typeof PostInboxPromoteActivatedResponseSchema>;

export const PostInboxPromoteExistingResponseSchema = ManifestSchema.extend(InboxPromoteFields);
export type PostInboxPromoteExistingResponse = z.infer<typeof PostInboxPromoteExistingResponseSchema>;
