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

export const RelationshipJudgementSchema = z
  .object({
    novelty_verdict: NoveltyVerdictSchema,
    connections: z.array(ConnectionSchema),
  })
  .strict();
export type RelationshipJudgement = z.infer<typeof RelationshipJudgementSchema>;

// Directional tensions are a sibling of connections: a separate, pairwise
// judgement written by `ops corpus refresh-tensions`, never by ingest. Each
// side of a judged pair stores its own entry whose `kind` reads from that
// reading's point of view, so either detail page renders the edge without a
// join. `contradicts` is symmetric; the other four come in inverse pairs.
export const TensionKindSchema = z.enum([
  "contradicts",
  "supersedes",
  "superseded_by",
  "qualifies",
  "qualified_by",
]);
export type TensionKind = z.infer<typeof TensionKindSchema>;

export const TensionSchema = z
  .object({
    id: z.string().min(1),
    kind: TensionKindSchema,
    reason: z.string().min(1),
    computed_at: z.string().datetime(),
  })
  .strict();
export type Tension = z.infer<typeof TensionSchema>;

// Memory of a pairwise judgement, positive or "none", so a stable pair is not
// re-judged nightly. Kept beside `tensions` rather than inside it because a
// "none" verdict has nothing to render.
export const TensionJudgedSchema = z
  .object({
    id: z.string().min(1),
    judged_at: z.string().datetime(),
  })
  .strict();
export type TensionJudged = z.infer<typeof TensionJudgedSchema>;

// What the pairwise judge returns for readings labelled `a` and `b`. `side`
// names which reading supersedes or qualifies the other and must be null for
// `none` and the symmetric `contradicts`. One neutral pair-level reason is
// stored on both sides so a one-sided write can be mirrored losslessly.
export const TensionVerdictSchema = z.enum([
  "none",
  "contradicts",
  "supersedes",
  "qualifies",
]);
export type TensionVerdict = z.infer<typeof TensionVerdictSchema>;

export const TensionJudgementSchema = z
  .object({
    verdict: TensionVerdictSchema,
    side: z.enum(["a", "b"]).nullable(),
    reason: z.string(),
  })
  .strict()
  .superRefine((judgement, ctx) => {
    const directional =
      judgement.verdict === "supersedes" || judgement.verdict === "qualifies";
    if (directional && judgement.side === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["side"],
        message: `${judgement.verdict} requires a side`,
      });
    }
    if (!directional && judgement.side !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["side"],
        message: `${judgement.verdict} must not name a side`,
      });
    }
    if (judgement.verdict !== "none" && judgement.reason.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "a tension needs a reason",
      });
    }
  });
export type TensionJudgement = z.infer<typeof TensionJudgementSchema>;

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

export const RELATIONSHIP_JUDGEMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
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
  },
  required: ["novelty_verdict", "connections"],
} as const;

export const TENSION_JUDGEMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["none", "contradicts", "supersedes", "qualifies"],
    },
    side: {
      type: ["string", "null"],
      enum: ["a", "b", null],
    },
    reason: { type: "string" },
  },
  required: ["verdict", "side", "reason"],
} as const;
