// The founder-migration plan state (reading-lite-s1k.6.1) — the durable,
// resumable ledger an --execute run writes as it copies. Each entry records
// the content sha256 computed from the bytes actually copied, which is the
// hash half of the reconciliation contract (listings supply the etag half).
// The file is checkpointed atomically (tmp + rename, like the batch sidecar)
// BEFORE progress is reported, so a crash resumes from the last checkpoint
// with putIfAbsent-free semantics: re-copying an already-copied object just
// rewrites identical bytes.
//
// It doubles as an etag-addressed cache of the per-row manifest and pointer
// content certification checks (see CachedRowEvidenceSchema), which is what
// keeps repeat plan and reconciliation passes from re-reading a corpus that
// has not moved. That cache makes the file CORPUS CONTENT rather than bare
// bookkeeping — it holds every reading's URL — so it is written 0600 and
// `*.state.json` is gitignored, the same treatment the batch sidecars get.
//
// The tenant and bucket are stamped so a resume under a different selector
// fails loudly instead of splicing two migrations together — the same
// provenance rule the batch sidecar enforces (s1k.4.3).

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { ListIndexItemSchema } from "../../src/schemas/api";

const CopiedObjectSchema = z
  .object({
    from: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    // The destination etag the sha256 describes. Certification requires it to
    // match the destination's CURRENT listing etag — the link that keeps a
    // stale entry (bytes rewritten outside this command between runs) from
    // certifying a hash of older bytes, at zero read cost. Optional only for
    // entries written before it existed; those re-plan as stale and the
    // backfill recomputes them.
    etag: z.string().min(1).optional(),
    copied_at: z.string(),
  })
  .strict();

const MigratedVectorSchema = z
  .object({
    tenant_vector_id: z.string().min(1),
    upserted_at: z.string(),
  })
  .strict();

// A read-through cache of per-row manifest/pointer CONTENT, addressed by the
// etag the content was read at. Certification reads two objects per list row;
// without this, every plan, preflight, and reconciliation pass re-reads the
// whole corpus to learn what it already knows.
//
// This caches the EVIDENCE, never the verdict. The row comparison itself is
// pure and free, so it runs live against index/list.json on every pass — a
// list row that goes stale while its manifest sits untouched is exactly the
// failure certification exists to catch, and a cached verdict would hide it.
// An etag match means "these bytes are unchanged, so this parse still holds",
// the same content identity the copy plan already trusts for size+etag.
const CachedRowEvidenceSchema = z
  .object({
    // The manifest's FULL list projection (manifestToIndexItem minus
    // key_prefix, which names where it was read from) — certification
    // compares every projected field against the row, so the cache must carry
    // them all.
    manifest: ListIndexItemSchema.omit({ key_prefix: true })
      .extend({ etag: z.string().min(1) })
      .optional(),
    pointer: z
      .object({
        etag: z.string().min(1),
        id: z.string().min(1),
        key_prefix: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CachedRowEvidence = z.infer<typeof CachedRowEvidenceSchema>;

// The by-url slot half of the evidence cache, keyed by url hash. Same rules:
// evidence, never a verdict — the slot-vs-rows comparison reruns live.
const CachedByUrlPointerSchema = z
  .object({
    etag: z.string().min(1),
    id: z.string().min(1),
    key_prefix: z.string().min(1),
  })
  .strict();

export type CachedByUrlPointer = z.infer<typeof CachedByUrlPointerSchema>;

export const MigrationStateSchema = z
  .object({
    version: z.literal(1),
    tenant: z.string().regex(/^usr_/),
    bucket: z.string().min(1),
    vectorize: z.string().min(1),
    started_at: z.string(),
    // Keyed by DESTINATION key — the object this run created.
    copies: z.record(z.string(), CopiedObjectSchema),
    // Keyed by reading id.
    vectors: z.record(z.string(), MigratedVectorSchema),
    // Keyed by list-row id. Optional: a pre-cache state file still loads, and
    // an absent or stale entry only costs the two reads it would have saved.
    evidence: z.record(z.string(), CachedRowEvidenceSchema).optional(),
    // Keyed by url hash — the by-url slot cache. Optional, same rules.
    by_url: z.record(z.string(), CachedByUrlPointerSchema).optional(),
    reconciled_at: z.string().optional(),
  })
  .strict();

export type MigrationState = z.infer<typeof MigrationStateSchema>;

export function newMigrationState(opts: {
  tenant: string;
  bucket: string;
  vectorize: string;
  startedAt: string;
}): MigrationState {
  return {
    version: 1,
    tenant: opts.tenant,
    bucket: opts.bucket,
    vectorize: opts.vectorize,
    started_at: opts.startedAt,
    copies: {},
    vectors: {},
  };
}

export async function loadMigrationState(path: string): Promise<MigrationState | null> {
  try {
    const json: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    const parsed = MigrationStateSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    // The evidence caches are an optimization, never a premise: a file whose
    // LEDGER is sound but whose cache predates a schema change (or is
    // otherwise undecodable) must still resume — dropping the cache only
    // costs the reads it would have saved. Anything else stays a hard error.
    if (typeof json === "object" && json !== null) {
      const { evidence: _evidence, by_url: _byUrl, ...rest } = json as Record<string, unknown>;
      const stripped = MigrationStateSchema.safeParse(rest);
      if (stripped.success) return stripped.data;
    }
    throw parsed.error;
  } catch (e) {
    if (typeof e === "object" && e && "code" in e && (e as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `failed to load migration state ${path}; resolve it manually before retrying: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export async function saveMigrationState(path: string, state: MigrationState): Promise<void> {
  const parsed = MigrationStateSchema.parse(state);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  // 0600, like the batch sidecars: the evidence cache carries corpus content
  // (every reading's URL and status), not just object keys and hashes. rename
  // keeps the mode, so setting it on the tmp file is enough.
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, path);
}
