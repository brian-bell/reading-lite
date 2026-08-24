// The founder-migration plan state (reading-lite-s1k.6.1) — the durable,
// resumable ledger an --execute run writes as it copies. Each entry records
// the content sha256 computed from the bytes actually copied, which is the
// hash half of the reconciliation contract (listings supply the etag half).
// The file is checkpointed atomically (tmp + rename, like the batch sidecar)
// BEFORE progress is reported, so a crash resumes from the last checkpoint
// with putIfAbsent-free semantics: re-copying an already-copied object just
// rewrites identical bytes.
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
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n");
  await fs.rename(tmp, path);
}
