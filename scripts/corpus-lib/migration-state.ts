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

const CopiedObjectSchema = z
  .object({
    from: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
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
    manifest: z
      .object({
        etag: z.string().min(1),
        id: z.string().min(1),
        url: z.string().min(1),
        status: z.string().min(1),
      })
      .strict()
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

export const MigrationStateSchema = z
  .object({
    version: z.literal(1),
    tenant: z.string().regex(/^usr_/),
    bucket: z.string().min(1),
    vectorize: z.string().min(1),
    started_at: z.string(),
    // Keyed by DESTINATION key — the object this run created.
    copies: z.record(CopiedObjectSchema),
    // Keyed by reading id.
    vectors: z.record(MigratedVectorSchema),
    // Keyed by list-row id. Optional: a pre-cache state file still loads, and
    // an absent or stale entry only costs the two reads it would have saved.
    evidence: z.record(CachedRowEvidenceSchema).optional(),
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
    return MigrationStateSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
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
