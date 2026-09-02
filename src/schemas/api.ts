import { z } from "zod";
import {
  ByUrlPointerSchema,
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
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  error: ManifestErrorSchema.optional(),
  active_attempt: ProcessingAttemptSummarySchema.optional(),
  last_attempt: ProcessingAttemptSummarySchema.optional(),
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

export const SimilarItemSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string().optional(),
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
// records that a Vectorize delete was issued (deleteByIds does not report
// whether the vector existed); `by_url_released` is false when the by-url slot
// belongs to a different (surviving) reading and was deliberately left alone.
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
