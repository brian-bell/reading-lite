import { z } from "zod";
import { ManifestSchema, type Manifest } from "../../src/schemas/manifest";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";

// Schema for a single row from Backlite's `readings` SQLite table. JSON-encoded
// columns are decoded before the row is passed to mapRowToManifest.
export const BacklitRowSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  url_hash: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().nullable().optional(),
  tldr: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  people: z.array(z.string()).nullable().optional(),
  orgs: z.array(z.string()).nullable().optional(),
  novelty_verdict: z
    .enum(["novel", "familiar", "duplicate"])
    .nullable()
    .optional(),
  connections: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .nullable()
    .optional(),
  summary_markdown: z.string().nullable().optional(),
  embedding: z.array(z.number()).length(1536),
  content_type: z.string().min(1),
  content_status: z.enum(["captured", "raw_only", "failed"]),
  content_bytes: z.number().int().nonnegative(),
  extracted_bytes: z.number().int().nonnegative().nullable().optional(),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fetched_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type BacklitRow = z.infer<typeof BacklitRowSchema>;

export interface PlannedReading {
  manifest: Manifest;
  keyPrefix: string;
  rawExt: string;
  embedding: number[];
}

export function mapRowToManifest(row: BacklitRow): Manifest {
  const m: Manifest = {
    id: row.id,
    url: row.url,
    url_hash: row.url_hash,
    status: "ready",
    content_type: row.content_type,
    content_status: row.content_status,
    content_bytes: row.content_bytes,
    content_sha256: row.content_sha256,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.title) m.title = row.title;
  if (row.tldr) m.tldr = row.tldr;
  if (row.tags) m.tags = row.tags;
  if (row.keywords) m.keywords = row.keywords;
  if (row.people) m.people = row.people;
  if (row.orgs) m.orgs = row.orgs;
  if (row.novelty_verdict) m.novelty_verdict = row.novelty_verdict;
  if (row.connections) m.connections = row.connections;
  if (row.summary_markdown) m.summary_markdown = row.summary_markdown;
  if (row.fetched_at) m.fetched_at = row.fetched_at;
  if (row.extracted_bytes != null) m.extracted_bytes = row.extracted_bytes;
  // Validate via the canonical schema so any drift is surfaced here.
  return ManifestSchema.parse(m);
}

export function planReading(row: BacklitRow): PlannedReading {
  const manifest = mapRowToManifest(row);
  const keyPrefix = buildKeyPrefix(row.id, row.created_at);
  const rawExt = extFromContentType(row.content_type);
  return { manifest, keyPrefix, rawExt, embedding: row.embedding };
}

export function extFromContentType(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}
