// Pure stored-summary input and relationship-only merge rules shared by hosted
// and operator refresh. No provider or storage effects.
import { ManifestSchema } from "../../schemas/manifest";
import { ConnectionSchema, type RelationshipJudgement } from "../../schemas/reading-summary";
import type { RelationshipJudgementInput } from "./index";
import type { RefreshReportReading } from "../refresh-neighbours";

export function buildRelationshipJudgementInput(
  manifest: Record<string, unknown>,
  reading: RefreshReportReading,
  neighbours: RefreshReportReading["current_neighbours"],
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
    connections_neighbourhood_ids: [...allowedIds],
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
