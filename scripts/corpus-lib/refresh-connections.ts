import { z } from "zod";
import { ManifestSchema } from "../../src/schemas/manifest";
import {
  ConnectionSchema,
  NoveltyVerdictSchema,
  type RelationshipJudgement,
} from "../../src/schemas/reading-summary";
import type { RelationshipJudgementInput } from "../../src/modules/relationship-judgement";
import { SIMILARITY_FLOOR } from "../../src/modules/stores/similarity-store";

const RefreshFlagSchema = z.enum([
  "stale_connection",
  "new_neighbour",
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

export const RefreshConnectionsReportSchema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().datetime(),
    tenant: z.string().min(1),
    floor: z.number(),
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

export function buildRelationshipJudgementInput(
  manifest: Record<string, unknown>,
  reading: RefreshConnectionsReportReading,
  neighbours: RefreshConnectionsReportReading["current_neighbours"],
): RelationshipJudgementInput {
  const title = typeof manifest.title === "string" ? manifest.title : reading.url;
  const tldr = typeof manifest.tldr === "string" ? manifest.tldr : "";
  const summary =
    typeof manifest.summary_markdown === "string"
      ? manifest.summary_markdown
      : tldr;
  if (summary.trim().length === 0) {
    throw new Error(`ready reading ${reading.id} has no stored summary text`);
  }
  return {
    reading: {
      id: reading.id,
      url: reading.url,
      title,
      tldr,
      tags: Array.isArray(manifest.tags)
        ? manifest.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      summary_markdown: summary,
    },
    similarReadings: neighbours.map((neighbour) => ({
      id: neighbour.id,
      score: neighbour.score,
      ...(neighbour.title === undefined ? {} : { title: neighbour.title }),
      ...(neighbour.tldr === undefined ? {} : { tldr: neighbour.tldr }),
      ...(neighbour.tags === undefined ? {} : { tags: neighbour.tags }),
    })),
  };
}

export type RelationshipMergeResult =
  | { ok: true; manifest: Record<string, unknown> }
  | { ok: false; error: string };

export function mergeRelationshipJudgement(
  rawManifest: unknown,
  judgement: RelationshipJudgement,
  allowedIds: ReadonlySet<string>,
  computedAt: string,
): RelationshipMergeResult {
  if (
    rawManifest === null ||
    typeof rawManifest !== "object" ||
    Array.isArray(rawManifest)
  ) {
    return { ok: false, error: "manifest is not an object" };
  }
  const raw = rawManifest as Record<string, unknown>;
  const selfId = typeof raw.id === "string" ? raw.id : "";
  const prior = new Map<string, { id: string; reason: string }>();
  if (Array.isArray(raw.connections)) {
    for (const connection of raw.connections) {
      const parsed = ConnectionSchema.safeParse(connection);
      if (parsed.success && !prior.has(parsed.data.id)) {
        prior.set(parsed.data.id, connection as { id: string; reason: string });
      }
    }
  }

  const seen = new Set<string>();
  const connections: Array<{ id: string; reason: string }> = [];
  for (const connection of judgement.connections) {
    if (connection.id === selfId) continue;
    if (!allowedIds.has(connection.id)) continue;
    if (seen.has(connection.id)) continue;
    seen.add(connection.id);
    connections.push(prior.get(connection.id) ?? connection);
  }

  const candidate: Record<string, unknown> = {
    ...raw,
    connections,
    novelty_verdict: judgement.novelty_verdict,
    connections_computed_at: computedAt,
  };
  const parsed = ManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first
        ? `${first.path.join(".") || "(root)"}: ${first.message}`
        : "failed ManifestSchema",
    };
  }
  return { ok: true, manifest: candidate };
}
