// Prepares a private, content-addressed PostgreSQL context artifact. Rows are
// observations, never writes. R2 supplies captured bytes only. The v2 packet
// must be revalidated before a separately authorized staging application.
import { createHash } from "node:crypto";
import { z } from "zod";
import { applyStaleness } from "../../src/modules/staleness";
import { ManifestSchema } from "../../src/schemas/manifest";
import { parseTenantId } from "../../src/control-plane/ids";
import { manifestToRows, type ReadingRows } from "../pg-lib/manifest-rows";
import { partitionKeysByPrefix } from "../pg-lib/operator-corpus";

export type CopyObject = { body: Uint8Array; contentType: string | null };
export interface CopyReaders {
  source: { read(key: string): Promise<CopyObject | null> };
  destination: { list(prefix: string): Promise<string[]> };
  /** Consistent per-database observations; verifies staging policy/occupancy. */
  rows(ids: string[], seedIds: string[]): Promise<SourceContext[]>;
}
const ReadingId = z
  .string()
  .regex(/^rd_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CopySelectionSchema = z.object({
  ids: z
    .array(ReadingId)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate seed IDs"),
  targets: z
    .array(
      z.object({
        id: ReadingId,
        contentSha256: Hash,
        markdownSha256: Hash.optional(),
      }),
    )
    .max(200)
    .refine(
      (targets) => new Set(targets.map((t) => t.id)).size === targets.length,
      "Duplicate target IDs",
    ),
});
export type CopyInput = z.infer<typeof CopySelectionSchema> & {
  sourceTenant: string;
  destinationTenant: string;
  now: string;
};
export const SourceContextSchema = z.object({
  keyPrefix: z.string(),
  manifest: ManifestSchema,
  ownerId: z.string().nullable(),
  revisionId: z.string().nullable(),
  contentKeys: z.object({
    rawKey: z.string(),
    extractedKey: z.string().nullable(),
    contentType: z.string(),
  }),
  embedding: z.array(z.number().finite()).length(1536).nullable(),
});
export type SourceContext = z.infer<typeof SourceContextSchema>;
export const copyHash = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");

// JSONB property order is not identity; array order (relationships, vectors) is.
export function contextFingerprint(entry: SourceContext): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return copyHash(JSON.stringify(canonical(SourceContextSchema.parse(entry))));
}
function safeKey(key: string): boolean {
  return (
    key.startsWith("readings/") &&
    /^[a-zA-Z0-9_./-]+$/.test(key) &&
    key.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export async function prepareContextCopy(
  input: CopyInput,
  readers: CopyReaders,
) {
  const sourceTenant = parseTenantId(input.sourceTenant),
    destinationTenant = parseTenantId(input.destinationTenant);
  if (!sourceTenant || !destinationTenant || sourceTenant === destinationTenant)
    throw Error("Distinct canonical tenants required");
  z.iso.datetime({ offset: true }).parse(input.now);
  const selection = CopySelectionSchema.parse(input),
    ids = [...selection.ids].sort(),
    targets = selection.targets;
  const selectedIds = [
    ...new Set([...ids, ...targets.map((t) => t.id)]),
  ].sort();
  const observations = z
    .array(SourceContextSchema)
    .parse(await readers.rows(selectedIds, ids));
  const entries = new Map(
    observations.map((entry) => [entry.manifest.id, entry]),
  );
  if (
    entries.size !== observations.length ||
    entries.size !== selectedIds.length ||
    selectedIds.some((id) => !entries.has(id))
  ) {
    throw Error("Missing/duplicate source readings");
  }
  const sourceRowChecks = selectedIds.map((id) => ({
    id,
    sha256: contextFingerprint(entries.get(id)!),
    includesEmbedding: ids.includes(id),
  }));
  const destinationChecks = [] as {
    id: string;
    url: string;
    urlHash: string;
    keyPrefix: string;
    expected: "absent";
  }[];
  const prefixes: string[] = [];
  for (const id of selectedIds) {
    const entry = entries.get(id)!,
      { keyPrefix, contentKeys } = entry;
    const m = applyStaleness(entry.manifest, 900, input.now);
    if (
      m.id !== id ||
      m.status !== "ready" ||
      m.active_attempt ||
      m.preserve_ready_manifest ||
      copyHash(m.url) !== m.url_hash
    ) {
      throw Error(`Source reading identity/state mismatch ${id}`);
    }
    if (entry.ownerId !== id)
      throw Error("Source URL ownership mismatch " + id);
    if (!safeKey(keyPrefix)) throw Error("Unsafe source prefix");
    const keys = [
      contentKeys.rawKey,
      ...(contentKeys.extractedKey === null ? [] : [contentKeys.extractedKey]),
    ];
    if (
      keys.some((key) => !safeKey(key)) ||
      partitionKeysByPrefix(keys, keyPrefix).foreign.length
    )
      throw Error("Content key outside safe reading prefix");
    if (
      prefixes.some(
        (p) =>
          p === keyPrefix ||
          p.startsWith(keyPrefix + "/") ||
          keyPrefix.startsWith(p + "/"),
      )
    )
      throw Error("Overlapping source reading prefixes");
    prefixes.push(keyPrefix);
    if (
      contentKeys.contentType !== m.content_type ||
      (m.content_status !== "captured" && m.content_status !== "raw_only") ||
      (m.content_status === "captured") !== (contentKeys.extractedKey !== null)
    )
      throw Error("Unsupported context content state");
    if (ids.includes(id) && entry.embedding === null)
      throw Error("Missing source embedding " + id);
    if ((await readers.destination.list(keyPrefix + "/")).length)
      throw Error("Occupied destination reading prefix");
    destinationChecks.push({
      id,
      url: m.url,
      urlHash: m.url_hash,
      keyPrefix,
      expected: "absent",
    });
    // Historical attempt diagnostics never become staging work or references.
    const { active_attempt: _active, last_attempt: _last, ...clean } = m;
    entries.set(id, { ...entry, manifest: ManifestSchema.parse(clean) });
  }

  const blobs = new Map<string, Uint8Array>();
  const blob = (bytes: Uint8Array) => {
    const hash = copyHash(bytes);
    blobs.set(hash, bytes);
    return hash;
  };
  const sourceChecks = new Map<string, { key: string; sha256: string }>();
  const content = new Map<string, CopyObject>();
  async function sourceRead(key: string) {
    let object = content.get(key);
    if (!object) {
      object = (await readers.source.read(key)) ?? undefined;
      if (!object) throw Error("Missing source object " + key);
      content.set(key, object);
      sourceChecks.set(key, {
        key: `u/${sourceTenant}/${key}`,
        sha256: copyHash(object.body),
      });
    }
    return object;
  }
  const objects = new Map<
    string,
    {
      key: string;
      blob: string;
      contentType: string | null;
      expected: "absent";
      sourceKey: string;
      sourceSha256: string;
    }
  >();
  const rows: ReadingRows[] = [];
  for (const id of selectedIds) {
    const {
      manifest: m,
      keyPrefix,
      contentKeys,
      revisionId,
      embedding,
    } = entries.get(id)!;
    const raw = await sourceRead(contentKeys.rawKey);
    if (
      copyHash(raw.body) !== m.content_sha256 ||
      raw.body.byteLength !== m.content_bytes
    )
      throw Error("Raw content hash/size mismatch " + id);
    const markdown =
      contentKeys.extractedKey === null
        ? null
        : await sourceRead(contentKeys.extractedKey);
    if (
      markdown &&
      m.extracted_bytes !== undefined &&
      markdown.body.byteLength !== m.extracted_bytes
    )
      throw Error("Extracted size mismatch " + id);
    if (!ids.includes(id)) continue;
    const add = (key: string, object: CopyObject) =>
      objects.set(key, {
        key: `u/${destinationTenant}/${key}`,
        blob: blob(object.body),
        contentType: object.contentType,
        expected: "absent",
        sourceKey: `u/${sourceTenant}/${key}`,
        sourceSha256: copyHash(object.body),
      });
    add(contentKeys.rawKey, raw);
    if (markdown) add(contentKeys.extractedKey!, markdown);
    rows.push(
      manifestToRows(m, {
        tenantId: destinationTenant,
        keyPrefix,
        ownsUrl: true,
        embedding: embedding!,
        // Imported ready readings can have no revision row. Name the new staging
        // revision deterministically, while keeping their resolved content keys.
        revision: {
          id: revisionId ?? `rev_${id}`,
          rawKey: contentKeys.rawKey,
          extractedKey: contentKeys.extractedKey,
        },
      }),
    );
  }
  const targetRecords = [] as {
    sourceId: string;
    url: string;
    title?: string;
    contentSha256: string;
    markdownBlob: string;
    action: "reprocess" | "import";
    stagingId?: string;
  }[];
  for (const target of targets) {
    const { manifest: m, contentKeys } = entries.get(target.id)!;
    if (
      m.content_status !== "captured" ||
      m.content_sha256 !== target.contentSha256 ||
      !contentKeys.extractedKey
    )
      throw Error("Target content hash/state changed");
    const markdown = await sourceRead(contentKeys.extractedKey);
    if (
      target.markdownSha256 &&
      copyHash(markdown.body) !== target.markdownSha256
    )
      throw Error("Target Markdown hash changed");
    const seeded = ids.includes(target.id);
    targetRecords.push({
      sourceId: target.id,
      url: m.url,
      title: m.title,
      contentSha256: m.content_sha256,
      markdownBlob: blob(markdown.body),
      action: seeded ? "reprocess" : "import",
      ...(seeded ? { stagingId: target.id } : {}),
    });
  }
  return {
    format: "reading-lite-staging-context-v2" as const,
    sourceProjection:
      "applyStaleness/900s; omit historical attempts/checkpoints",
    createdAt: input.now,
    source: { bucket: "reading-lite", tenant: sourceTenant },
    destination: { bucket: "reading-lite-staging", tenant: destinationTenant },
    readingIds: ids,
    rows,
    objects: [...objects.values()].sort((a, b) => a.key.localeCompare(b.key)),
    sourceChecks: [...sourceChecks.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    sourceRowChecks,
    destinationChecks,
    targets: targetRecords,
    applyOrder: [
      "verify packet checksums; revalidate source row/embedding fingerprints and content hashes, destination absence, active tenant, disabled paid work, and sole-writer window",
      "create content with If-None-Match:*; preserve bytes and content types",
      "in one PostgreSQL transaction, recheck and lock tenant/policy and destination absence; insert readings, URL ownership, revisions, relationships and embeddings without replacing existing rows",
      "verify fixture content, reading projections, URL ownership and similarity; retain evidence on partial failure",
    ],
    blobs,
  };
}
