import { z } from "zod";
import {
  ConnectionSchema,
  NoveltyVerdictSchema,
} from "../../src/schemas/reading-summary";
import { SIMILARITY_FLOOR } from "../../src/modules/stores/similarity-store";

const RefreshFlagSchema = z.enum([
  "stale_connection",
  "connection_below_floor",
  "new_neighbour",
  "uncited_neighbour",
  "verdict_inconsistent",
]);

const ReportNeighbourSchema = z
  .object({
    id: z.string().min(1),
    score: z.number(),
    title: z.string().optional(),
    tldr: z.string().optional(),
    tags: z.array(z.string()).optional(),
    created_at: z.string().datetime().optional(),
  })
  .strict();

const ReportReadingSchema = z
  .object({
    id: z.string().min(1),
    key_prefix: z.string().min(1),
    url: z.string().url(),
    reasons: z.array(RefreshFlagSchema).min(1),
    novelty_verdict: NoveltyVerdictSchema.optional(),
    connections: z.array(ConnectionSchema),
    judged_at: z.string().datetime().optional(),
    judged_at_source: z
      .enum(["connections_computed_at", "last_attempt", "updated_at"])
      .optional(),
    current_neighbours: z.array(ReportNeighbourSchema),
  })
  .strict();

// What the tier-1 pass measured. Optional: reports written before the
// incremental scope existed carry no header. Missing is not full — pre-header
// `refresh-neighbours` already accepted positional IDs and `--limit`, so an
// absent header is unstated coverage, not the whole ready corpus.
const ReportScopeSchema = z
  .object({
    kind: z.enum(["full", "incremental"]),
    reason: z.string().min(1),
    since: z.string().datetime().optional(),
    readings_in_scope: z.number().int().nonnegative().optional(),
    narrowed_by: z.string().min(1).optional(),
  })
  .strict();

export const RefreshConnectionsReportSchema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().datetime(),
    tenant: z.string().min(1),
    floor: z.number(),
    scope: ReportScopeSchema.optional(),
    readings: z.array(ReportReadingSchema),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.floor !== SIMILARITY_FLOOR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["floor"],
        message: `expected ${SIMILARITY_FLOOR}`,
      });
    }
    const seen = new Set<string>();
    report.readings.forEach((reading, index) => {
      if (seen.has(reading.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["readings", index, "id"],
          message: "duplicate reading id",
        });
      }
      seen.add(reading.id);
    });
  });

export type RefreshConnectionsReport = z.infer<
  typeof RefreshConnectionsReportSchema
>;
export type RefreshConnectionsReportReading =
  RefreshConnectionsReport["readings"][number];

export function parseRefreshConnectionsReport(
  raw: unknown,
  expectedTenant: string,
): RefreshConnectionsReport {
  const report = RefreshConnectionsReportSchema.parse(raw);
  if (report.tenant !== expectedTenant) {
    throw new Error(
      `report tenant ${JSON.stringify(report.tenant)} does not match --tenant ${JSON.stringify(expectedTenant)}`,
    );
  }
  return report;
}

export function isJudgedForReport(
  manifest: { connections_computed_at?: unknown },
  reportGeneratedAt: string,
): boolean {
  if (typeof manifest.connections_computed_at !== "string") return false;
  const judged = Date.parse(manifest.connections_computed_at);
  const report = Date.parse(reportGeneratedAt);
  return Number.isFinite(judged) && Number.isFinite(report) && judged >= report;
}

export function liveReportNeighbours(
  reading: RefreshConnectionsReportReading,
  liveReadyIds: ReadonlySet<string>,
): RefreshConnectionsReportReading["current_neighbours"] {
  const seen = new Set<string>();
  return reading.current_neighbours.filter((neighbour) => {
    if (neighbour.id === reading.id) return false;
    if (!liveReadyIds.has(neighbour.id)) return false;
    if (seen.has(neighbour.id)) return false;
    seen.add(neighbour.id);
    return true;
  });
}

export { buildRelationshipJudgementInput, mergeRelationshipJudgement, type RelationshipMergeResult } from "../../src/modules/relationship-judgement/refresh";
