// The frozen library snapshot (reading-lite-gh348): what `ops migrate export`
// writes and `ops migrate import` reads.
//
// The snapshot is the boundary between the two halves of the migration. Export
// is the only step that touches the legacy stores (R2 manifests, D1 and
// Vectorize), and it also makes the only paid call, re-embedding a vector that
// get_by_ids did not return. Import reads nothing but this directory. So one
// snapshot imported into two empty databases produces the same rows and the
// same report, which is the property the rehearsal (#349) relies on.
//
// Layout of a snapshot directory:
//
//   snapshot.json        format, source, tenant, export time, file digests
//   library.json         one entry per manifest under the tenant's root
//   control-plane.json   every D1 control-plane row, as D1 returned it
//   report.json          the export-side reconciliation report
//
// Every file is canonical JSON (sorted keys), and snapshot.json records each
// file's sha256, so an edited or truncated snapshot is refused rather than
// imported.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const SNAPSHOT_FORMAT = "reading-lite-library-snapshot";
export const SNAPSHOT_VERSION = 1;

export const SNAPSHOT_FILES = ["library.json", "control-plane.json", "report.json"] as const;
export type SnapshotFile = (typeof SNAPSHOT_FILES)[number];

export const SourceEnvSchema = z.enum(["staging", "production"]);
export type SourceEnv = z.infer<typeof SourceEnvSchema>;

export const SnapshotMetaSchema = z
  .object({
    format: z.literal(SNAPSHOT_FORMAT),
    version: z.literal(SNAPSHOT_VERSION),
    source: z
      .object({
        env: SourceEnvSchema,
        bucket: z.string().min(1),
        d1_database: z.string().min(1),
        vectorize_index: z.string().min(1),
      })
      .strict(),
    tenant_id: z.string().min(1),
    exported_at: z.string().datetime(),
    files: z.record(z.enum(SNAPSHOT_FILES), z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

// Where the stored vector came from. `reembedded` is a get_by_ids miss that
// export restored by embedding the manifest's tldr (see export-library.ts).
export const EmbeddingSourceSchema = z.enum(["vectorize", "reembedded"]);

export const LibraryEntrySchema = z
  .object({
    id: z.string().min(1),
    key_prefix: z.string().min(1),
    // The manifest exactly as R2 held it. Import parses it; keeping it raw is
    // what lets the report name the fields ManifestSchema would strip.
    manifest: z.unknown(),
    owns_url: z.boolean(),
    // The relative raw key actually found, when it is not the legacy spelling
    // content_type implies. The imported revision addresses it instead.
    raw_key: z.string().min(1).optional(),
    // Parsed attempt logs (attempts/*.json), oldest first.
    attempts: z.array(z.unknown()),
    embedding: z
      .object({ source: EmbeddingSourceSchema, values: z.array(z.number()) })
      .strict()
      .nullable(),
  })
  .strict();
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

export const LibrarySchema = z
  .object({
    readings: z.array(LibraryEntrySchema),
    // Purge tombstones (index/deleted/{id}). Not imported as fences: they
    // fence late consumers, and the cutover drains every queue. Carried so
    // import can refuse to resurrect a purged reading whose manifest survived.
    tombstones: z.array(z.string().min(1)),
  })
  .strict();
export type Library = z.infer<typeof LibrarySchema>;

// D1 rows by table, unconverted. The control-plane mapping owns the per-column
// conversion and validates each row on the way in.
export const ControlPlaneSnapshotSchema = z
  .object({ tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) })
  .strict();
export type ControlPlaneSnapshot = z.infer<typeof ControlPlaneSnapshotSchema>;

export interface Snapshot {
  meta: SnapshotMeta;
  library: Library;
  controlPlane: ControlPlaneSnapshot;
  report: unknown;
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256Text(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

/**
 * Writes a new snapshot. Refuses a directory that already holds anything: a
 * snapshot is frozen evidence, and overwriting one would quietly replace what a
 * previous import was checked against.
 */
export function writeSnapshot(
  dir: string,
  parts: { meta: Omit<SnapshotMeta, "files">; library: Library; controlPlane: ControlPlaneSnapshot; report: unknown },
): SnapshotMeta {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`refusing to write a snapshot into non-empty directory ${dir}`);
  }
  // Owner-only: control-plane.json holds every account's emails and credential
  // HMACs, and a snapshot is kept as evidence long after the import.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bodies: Record<SnapshotFile, string> = {
    "library.json": canonicalJson(parts.library),
    "control-plane.json": canonicalJson(parts.controlPlane),
    "report.json": canonicalJson(parts.report),
  };
  const files = Object.fromEntries(
    SNAPSHOT_FILES.map((name) => [name, sha256Text(bodies[name])]),
  ) as Record<SnapshotFile, string>;
  const meta = SnapshotMetaSchema.parse({ ...parts.meta, files });
  for (const name of SNAPSHOT_FILES) writeFileSync(path.join(dir, name), bodies[name], { mode: 0o600 });
  // Last, so a crash part-way leaves a directory with no snapshot.json, which
  // readSnapshot refuses.
  writeFileSync(path.join(dir, "snapshot.json"), canonicalJson(meta), { mode: 0o600 });
  return meta;
}

export class SnapshotError extends Error {}

/** Reads and verifies a snapshot directory; throws SnapshotError on any defect. */
export function readSnapshot(dir: string): Snapshot {
  const read = (name: string): string => {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new SnapshotError(`snapshot is missing ${name} (${dir})`);
    return readFileSync(file, "utf8");
  };
  const parseJson = (name: string, text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new SnapshotError(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const metaParsed = SnapshotMetaSchema.safeParse(parseJson("snapshot.json", read("snapshot.json")));
  if (!metaParsed.success) {
    throw new SnapshotError(`snapshot.json is not a ${SNAPSHOT_FORMAT} v${SNAPSHOT_VERSION}: ${metaParsed.error.message}`);
  }
  const meta = metaParsed.data;
  const bodies = {} as Record<SnapshotFile, unknown>;
  for (const name of SNAPSHOT_FILES) {
    const text = read(name);
    const expected = meta.files[name];
    if (sha256Text(text) !== expected) {
      throw new SnapshotError(`${name} does not match the digest recorded in snapshot.json`);
    }
    bodies[name] = parseJson(name, text);
  }
  const library = LibrarySchema.safeParse(bodies["library.json"]);
  if (!library.success) throw new SnapshotError(`library.json is malformed: ${library.error.message}`);
  const controlPlane = ControlPlaneSnapshotSchema.safeParse(bodies["control-plane.json"]);
  if (!controlPlane.success) throw new SnapshotError(`control-plane.json is malformed: ${controlPlane.error.message}`);
  return { meta, library: library.data, controlPlane: controlPlane.data, report: bodies["report.json"] };
}
