// report.json inside an archive export (reading-lite-mxwx.2). The zip is the
// seam: the builder parses this before it writes the file, and a later
// restore reads the same shape. Mismatches are warnings. A few production
// readings really do disagree with their stored bytes (docs/postgres-cutover.md),
// so a mismatch does not fail the export.

import { z } from "zod";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const byteCount = z.number().int().nonnegative();

export const ArchiveMissingArtifactSchema = z
  .object({
    reading_id: z.string().min(1),
    kind: z.enum(["extracted", "raw"]),
    path: z.string().min(1),
  })
  .strict();
export type ArchiveMissingArtifact = z.infer<typeof ArchiveMissingArtifactSchema>;

export const ArchiveDanglingRelationshipSchema = z
  .object({
    reading_id: z.string().min(1),
    kind: z.enum(["connection", "tension"]),
    target_id: z.string().min(1),
  })
  .strict();
export type ArchiveDanglingRelationship = z.infer<typeof ArchiveDanglingRelationshipSchema>;

export const ArchiveContentWarningSchema = z
  .object({
    reading_id: z.string().min(1),
    code: z.enum(["content_hash_mismatch", "content_size_mismatch", "extracted_size_mismatch"]),
    path: z.string().min(1),
    expected: z.union([byteCount, sha256Hex]),
    actual: z.union([byteCount, sha256Hex]),
  })
  .strict()
  .superRefine((warning, ctx) => {
    const hash = warning.code === "content_hash_mismatch";
    if (hash !== (typeof warning.expected === "string") || hash !== (typeof warning.actual === "string")) {
      ctx.addIssue({
        code: "custom",
        message: "hash warnings carry sha256 hex; size warnings carry byte counts",
      });
    }
  });
export type ArchiveContentWarning = z.infer<typeof ArchiveContentWarningSchema>;

export const ArchiveReportSchema = z
  .object({
    format_version: z.literal(1),
    missing_artifacts: z.array(ArchiveMissingArtifactSchema),
    dangling_relationships: z.array(ArchiveDanglingRelationshipSchema),
    warnings: z.array(ArchiveContentWarningSchema),
  })
  .strict();
export type ArchiveReport = z.infer<typeof ArchiveReportSchema>;
