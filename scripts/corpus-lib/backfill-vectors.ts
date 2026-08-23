// Pure orchestration for corpus-backfill-vectors. The list index discovers
// readings, but the parsed manifest is the authority for embedding input and
// Vectorize metadata. This module never writes R2.

import { ManifestSchema } from "../../src/schemas/manifest";
import { EMBEDDING_DIM } from "../../src/schemas/api";
import { normalizeTags } from "../../src/modules/tags";
import type { VectorizeUpsertVector } from "../lib/cf-clients";

export interface VectorBackfillRow {
  id: string;
  url: string;
  status: string;
  key_prefix: string;
  created_at: string;
}

export interface VectorBackfillTarget {
  id: string;
  keyPrefix: string;
  tldr: string;
  metadata: VectorizeUpsertVector["metadata"];
}

export interface VectorBackfillOptions {
  execute: boolean;
  only?: string[];
  limit?: number;
}

export interface VectorBackfillDeps {
  readListIndex(): Promise<VectorBackfillRow[]>;
  vectorExists(id: string): Promise<boolean>;
  readManifest(keyPrefix: string): Promise<unknown | null>;
  embedMany(inputs: string[]): Promise<{ embeddings: number[][] }>;
  upsert(vectors: VectorizeUpsertVector[]): Promise<void>;
}

export interface VectorBackfillResult {
  eligible: VectorBackfillTarget[];
  restoredIds: string[];
  problems: VectorBackfillProblem[];
  stats: VectorBackfillStats;
}

export interface VectorBackfillStats {
  corpus: number;
  considered: number;
  skippedNotReady: number;
  alreadyIndexed: number;
  raced: number;
}

export type VectorBackfillProblemKind =
  | "manifest_invalid"
  | "manifest_not_ready"
  | "missing_tldr"
  | "identity_mismatch";

export interface VectorBackfillProblem {
  id: string;
  kind: VectorBackfillProblemKind;
}

type CandidateCheck =
  | { ok: true; target: VectorBackfillTarget }
  | { ok: false; kind: VectorBackfillProblemKind };

function checkCandidate(
  row: VectorBackfillRow,
  raw: unknown,
): CandidateCheck {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, kind: "manifest_invalid" };
  const manifest = parsed.data;
  if (manifest.status !== "ready") {
    return { ok: false, kind: "manifest_not_ready" };
  }
  if (manifest.tldr === undefined) {
    return { ok: false, kind: "missing_tldr" };
  }
  if (
    manifest.id !== row.id ||
    manifest.url !== row.url ||
    manifest.created_at !== row.created_at
  ) {
    return { ok: false, kind: "identity_mismatch" };
  }

  const metadata: VectorizeUpsertVector["metadata"] = {
    url: manifest.url,
    tldr: manifest.tldr,
    created_at: manifest.created_at,
  };
  if (manifest.title !== undefined) metadata.title = manifest.title;
  if (manifest.tags !== undefined) metadata.tags = normalizeTags(manifest.tags);
  return {
    ok: true,
    target: {
      id: row.id,
      keyPrefix: row.key_prefix,
      tldr: manifest.tldr,
      metadata,
    },
  };
}

async function readCandidate(
  row: VectorBackfillRow,
  deps: Pick<VectorBackfillDeps, "readManifest">,
): Promise<CandidateCheck> {
  try {
    return checkCandidate(row, await deps.readManifest(row.key_prefix));
  } catch {
    return { ok: false, kind: "manifest_invalid" };
  }
}

export async function runVectorBackfill(
  opts: VectorBackfillOptions,
  deps: VectorBackfillDeps,
): Promise<VectorBackfillResult> {
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const rows = await deps.readListIndex();
  const eligible: VectorBackfillTarget[] = [];
  const problems: VectorBackfillProblem[] = [];
  const stats: VectorBackfillStats = {
    corpus: rows.length,
    considered: 0,
    skippedNotReady: 0,
    alreadyIndexed: 0,
    raced: 0,
  };

  for (const row of rows) {
    if (only && !only.has(row.id)) continue;
    stats.considered++;
    if (row.status !== "ready") {
      stats.skippedNotReady++;
      continue;
    }
    if (await deps.vectorExists(row.id)) {
      stats.alreadyIndexed++;
      continue;
    }

    const checked = await readCandidate(row, deps);
    if (!checked.ok) {
      problems.push({ id: row.id, kind: checked.kind });
      continue;
    }
    eligible.push(checked.target);
    if (opts.limit !== undefined && eligible.length >= opts.limit) break;
  }

  if (!opts.execute || eligible.length === 0) {
    return { eligible, restoredIds: [], problems, stats };
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const revalidated: VectorBackfillTarget[] = [];
  for (const target of eligible) {
    if (await deps.vectorExists(target.id)) {
      stats.raced++;
      continue;
    }
    const row = rowById.get(target.id)!;
    const current = await readCandidate(row, deps);
    if (current.ok) {
      revalidated.push(current.target);
    } else {
      problems.push({ id: target.id, kind: current.kind });
    }
  }
  if (revalidated.length === 0) {
    return { eligible: [], restoredIds: [], problems, stats };
  }

  const { embeddings } = await deps.embedMany(revalidated.map((target) => target.tldr));
  if (embeddings.length !== revalidated.length) {
    throw new Error(
      `embedding response count mismatch: got ${embeddings.length}, expected ${revalidated.length}`,
    );
  }
  for (let index = 0; index < embeddings.length; index++) {
    const embedding = embeddings[index]!;
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `embedding for ${revalidated[index]!.id} has ${embedding.length} dimensions, expected ${EMBEDDING_DIM}`,
      );
    }
  }
  await deps.upsert(
    revalidated.map((target, index) => ({
      id: target.id,
      values: embeddings[index]!,
      metadata: target.metadata,
    })),
  );
  return {
    eligible: revalidated,
    restoredIds: revalidated.map((target) => target.id),
    problems,
    stats,
  };
}
