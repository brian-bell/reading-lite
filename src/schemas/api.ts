import { z } from "zod";
import {
  ManifestErrorSchema,
  ManifestSchema,
  ManifestStatusSchema,
  NoveltyVerdictSchema,
} from "./manifest";

const webUrl = () =>
  z
    .string()
    .url()
    .refine((u) => /^https?:/i.test(u), { message: "url must be http(s)" });

export const PostReadingsBodySchema = z.object({
  url: webUrl(),
});
export type PostReadingsBody = z.infer<typeof PostReadingsBodySchema>;

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
  status: ManifestStatusSchema,
  novelty_verdict: NoveltyVerdictSchema.optional(),
  created_at: z.string().datetime(),
  error: ManifestErrorSchema.optional(),
});
export type ListIndexItem = z.infer<typeof ListIndexItemSchema>;

export const ListIndexSchema = z.object({
  version: z.literal(1),
  items: z.array(ListIndexItemSchema),
});
export type ListIndex = z.infer<typeof ListIndexSchema>;

export const ListReadingsResponseSchema = z.object({
  readings: z.array(ManifestSchema),
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
