import { dateOn } from "./reading-presentation";
import type { Reading, ReadingStatus } from "./reading";

// Connections and tensions as cards (design spec, Data mapping and
// Relationship targets; acceptance matrix, Removed target and Non-ready
// target). Everything a card shows is a manifest field, a field of the
// read-time `relationship_targets` map, or a label fixed here.

export interface RelationshipTargetView {
  /** `title`, else the URL — the same rule as the reading's own heading. */
  title: string;
  url: string;
  status: ReadingStatus;
}

export interface RelationshipCard {
  id: string;
  kind: "connection" | "tension";
  /** The tension's kind label (Contradicts, …); connections carry none. */
  label?: string;
  reason: string;
  /** Absent when the id is missing from `relationship_targets`: the reading was removed. */
  target?: RelationshipTargetView;
}

export interface RelationshipCards {
  connections: RelationshipCard[];
  tensions: RelationshipCard[];
}

/** Labels read from this reading's point of view, matching the backend's TensionKind. */
const TENSION_KIND_LABELS: Record<string, string> = {
  contradicts: "Contradicts",
  supersedes: "Supersedes",
  superseded_by: "Superseded by",
  qualifies: "Qualifies",
  qualified_by: "Qualified by",
};

/** A kind added by the backend later has no wording yet; it is still a tension. */
export function tensionKindLabel(kind: string): string {
  return TENSION_KIND_LABELS[kind] ?? "Tension";
}

export function relationshipCards(reading: Reading): RelationshipCards {
  const targets = reading.relationship_targets ?? {};
  const targetOf = (id: string): RelationshipTargetView | undefined => {
    const target = targets[id];
    if (!target) return undefined;
    return { title: target.title ?? target.url, url: target.url, status: target.status };
  };
  return {
    connections: (reading.connections ?? []).map((connection) => ({
      id: connection.id,
      kind: "connection",
      reason: connection.reason,
      target: targetOf(connection.id),
    })),
    tensions: (reading.tensions ?? []).map((tension) => ({
      id: tension.id,
      kind: "tension",
      label: tensionKindLabel(tension.kind),
      reason: tension.reason,
      target: targetOf(tension.id),
    })),
  };
}

/**
 * Whether the reading has a context column at all. A ready reading with
 * nothing to show renders no column and no jump link: a sparse archive is
 * reported by the novelty panel, not by empty headings (design spec, Sparse
 * archive). Pending and failed readings have no relationships yet.
 */
export function hasRelationships(reading: Reading): boolean {
  if (reading.status !== "ready") return false;
  return (reading.connections?.length ?? 0) > 0 || (reading.tensions?.length ?? 0) > 0;
}

/** `connections_computed_at` → "Computed 8 September 2026" (design spec, Data mapping). */
export function connectionsComputedOn(reading: Reading): string | undefined {
  const formatted = dateOn(reading.connections_computed_at);
  return formatted ? `Computed ${formatted}` : undefined;
}

/** The text badge a non-ready target carries next to its link. A ready target needs none. */
export function targetStatusBadge(status: ReadingStatus): string | undefined {
  if (status === "pending") return "Processing";
  if (status === "failed") return "Failed";
  return undefined;
}
