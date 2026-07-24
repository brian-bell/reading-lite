import { z } from "zod";

export const NoveltyVerdictSchema = z.enum(["novel", "familiar", "duplicate"]);
export type NoveltyVerdict = z.infer<typeof NoveltyVerdictSchema>;

export const ConnectionSchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type Connection = z.infer<typeof ConnectionSchema>;

export const ReadingSummarySchema = z
  .object({
    title: z.string().min(1).max(120),
    tldr: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1).max(6),
    keywords: z.array(z.string().min(1)).min(3).max(15),
    people: z.array(z.string().min(1)),
    orgs: z.array(z.string().min(1)),
    novelty_verdict: NoveltyVerdictSchema,
    connections: z.array(ConnectionSchema),
    summary_markdown: z.string().min(1),
  })
  .strict();
export type ReadingSummary = z.infer<typeof ReadingSummarySchema>;

export const READING_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    tldr: { type: "string", minLength: 1 },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string", minLength: 1 },
    },
    keywords: {
      type: "array",
      minItems: 3,
      maxItems: 15,
      items: { type: "string", minLength: 1 },
    },
    people: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    orgs: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    novelty_verdict: {
      type: "string",
      enum: ["novel", "familiar", "duplicate"],
    },
    connections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
        required: ["id", "reason"],
      },
    },
    summary_markdown: { type: "string", minLength: 1 },
  },
  required: [
    "title",
    "tldr",
    "tags",
    "keywords",
    "people",
    "orgs",
    "novelty_verdict",
    "connections",
    "summary_markdown",
  ],
} as const;
