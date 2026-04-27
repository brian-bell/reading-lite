import { z } from "zod";
import { ManifestSchema } from "./manifest";

const httpsUrl = () =>
  z
    .string()
    .url()
    .refine((u) => /^https?:/i.test(u), { message: "url must be http(s)" });

export const PostReadingsBodySchema = z.object({
  url: httpsUrl(),
});
export type PostReadingsBody = z.infer<typeof PostReadingsBodySchema>;

export const EMBEDDING_DIM = 1536;

export const PostReadingsSimilarBodySchema = z.object({
  query_embedding: z.array(z.number()).length(EMBEDDING_DIM),
  k: z.number().int().min(1).max(50).default(10),
});
export type PostReadingsSimilarBody = z.infer<typeof PostReadingsSimilarBodySchema>;

export const ListReadingsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "limit must be an integer" });
        return z.NEVER;
      }
      return n;
    })
    .pipe(z.number().int().min(1).max(100))
    .default(20),
});
export type ListReadingsQuery = z.infer<typeof ListReadingsQuerySchema>;

export const ListReadingsResponseSchema = z.object({
  items: z.array(ManifestSchema),
  next_cursor: z.string().optional(),
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
