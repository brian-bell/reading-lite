// What export and import both need to agree on (reading-lite-gh348): how a
// snapshot entry parses, what PostgreSQL will hand back for it, how the
// library is summarised field by field, and which findings stop an import.
//
// Import recomputes all of this from the snapshot's data rather than trusting
// report.json, so a report edited by hand cannot unblock anything.

import { ManifestSchema, type Manifest } from "../../src/schemas/manifest";
import { EMBEDDING_DIM } from "../../src/schemas/api";
import { canonicalHash, canonicalJson, sha256Text, type LibraryEntry } from "./snapshot";
import { CONTROL_PLANE_TABLES, toPgRow } from "./control-plane-map";

export interface Discrepancy {
  code: string;
  id?: string;
  key?: string;
  detail?: string;
}

// Findings that stop `ops migrate import --execute`. `accept` names what an
// explicit `--accept <code>` does instead; a code with no `accept` cannot be
// accepted and needs the source fixed before a new export.
export const BLOCKING_CODES = {
  malformed_manifest: { accept: "the reading is skipped: it is listed in the report and not imported" },
  identity_mismatch: { accept: "the reading is imported under the key_prefix it was found at" },
  tombstoned_manifest: { accept: "the reading is skipped, as its purge intended" },
  unresolved_pending: {
    accept: "the reading is imported with its attempt summary but no job row, so nothing will run it",
  },
  unusable_vector: { accept: "the reading is imported without an embedding and is not searchable" },
  duplicate_reading_id: {},
  url_hash_mismatch: {},
  tenant_account_missing: {},
  unfinished_wipe: {},
  invalid_control_plane_row: {},
} as const satisfies Record<string, { accept?: string }>;

export type BlockingCode = keyof typeof BLOCKING_CODES;

export const ACCEPTABLE_CODES = (Object.keys(BLOCKING_CODES) as BlockingCode[]).filter(
  (code) => "accept" in BLOCKING_CODES[code],
);

export function isBlockingCode(code: string): code is BlockingCode {
  return code in BLOCKING_CODES;
}

export type ParsedEntry =
  | { ok: true; manifest: Manifest; strippedFields: string[] }
  | { ok: false; error: string };

export function parseEntry(entry: Pick<LibraryEntry, "id" | "manifest">): ParsedEntry {
  const parsed = ManifestSchema.safeParse(entry.manifest);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  if (parsed.data.id !== entry.id) return { ok: false, error: `manifest id ${parsed.data.id} differs from entry id ${entry.id}` };
  const raw = entry.manifest as Record<string, unknown>;
  const strippedFields = Object.keys(raw).filter((key) => !(key in parsed.data)).sort();
  return { ok: true, manifest: parsed.data, strippedFields };
}

/** A reading still has legacy work in flight: it is pending, or an attempt is active. */
export function isUnresolved(manifest: Manifest): boolean {
  return manifest.status === "pending" || manifest.active_attempt !== undefined;
}

export function vectorProblem(values: unknown): string | null {
  if (!Array.isArray(values)) return "values is not an array";
  if (values.length !== EMBEDDING_DIM) return `${values.length} dimensions, expected ${EMBEDDING_DIM}`;
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return "non-finite component";
  return null;
}

/** The legacy key prefix ends in the reading's own id (buildKeyPrefix, and corpus drop's guard). */
export function prefixMatchesId(keyPrefix: string, id: string): boolean {
  return keyPrefix.endsWith(id);
}

// Published-only fields: a revision carries them, and only a ready reading has
// one (manifest-rows.ts).
const PUBLISHED_FIELDS = [
  "summary_markdown",
  "usage",
  "connections",
  "connections_computed_at",
  "connections_neighbourhood_ids",
  "tensions",
  "tensions_judged",
] as const;

// Fields stored in timestamptz columns. They come back as ISO-8601 UTC with
// exactly three fraction digits, whatever spelling the manifest used (ADR
// 0005 left manifests without milliseconds to this importer: they are
// respelled, and the report lists each one). Timestamps inside jsonb columns
// (attempt summaries, errors, similarity) are stored verbatim.
const TIMESTAMP_FIELDS = ["created_at", "updated_at", "fetched_at", "connections_computed_at"] as const;

const respell = (iso: string): string => new Date(iso).toISOString();

/**
 * The manifest PostgreSQL will project for this reading once imported: what
 * the reading store's detail read must return, field for field. Every
 * difference from the source manifest is one the report names.
 */
export function expectedManifest(manifest: Manifest): Manifest {
  const out: Record<string, unknown> = { ...manifest };
  delete out.preserve_ready_manifest;
  if (manifest.status !== "ready") for (const field of PUBLISHED_FIELDS) delete out[field];
  for (const field of TIMESTAMP_FIELDS) {
    if (typeof out[field] === "string") out[field] = respell(out[field] as string);
  }
  if (Array.isArray(out.connections)) {
    out.connections = firstByTarget(out.connections as { id: string }[]);
  }
  if (Array.isArray(out.tensions)) {
    out.tensions = firstByTarget(out.tensions as { id: string; computed_at: string }[]).map((t) => ({
      ...t,
      computed_at: respell(t.computed_at),
    }));
  }
  return out as Manifest;
}

function firstByTarget<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/** Where respelling changes a stored timestamp, and whether precision is lost. */
export function respelledTimestamps(manifest: Manifest): { fields: string[]; precisionLost: boolean } {
  const fields: string[] = [];
  let precisionLost = false;
  const check = (name: string, value: string | undefined) => {
    if (value === undefined || respell(value) === value) return;
    fields.push(name);
    const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? "";
    if (/[1-9]/.test(fraction.slice(3))) precisionLost = true;
  };
  for (const field of TIMESTAMP_FIELDS) check(field, manifest[field] as string | undefined);
  (manifest.tensions ?? []).forEach((t, i) => check(`tensions[${i}].computed_at`, t.computed_at));
  return { fields, precisionLost };
}

export const MANIFEST_FIELDS = Object.keys(ManifestSchema.shape).sort();

export interface FieldTotal {
  present: number;
  sha256: string;
}

/**
 * Per manifest field: how many readings carry it, and a hash over every
 * (id, value) pair in id order. Two libraries with equal totals hold the same
 * value in every field of every reading.
 */
export function fieldTotals(manifests: readonly Manifest[]): Record<string, FieldTotal> {
  const sorted = [...manifests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const totals: Record<string, FieldTotal> = {};
  for (const field of MANIFEST_FIELDS) {
    const pairs = sorted
      .filter((m) => (m as Record<string, unknown>)[field] !== undefined)
      .map((m) => [m.id, (m as Record<string, unknown>)[field]]);
    totals[field] = { present: pairs.length, sha256: canonicalHash(pairs) };
  }
  return totals;
}

export function sameManifest(a: Manifest, b: Manifest): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Top-level fields whose values differ, for a mismatch report line. */
export function differingFields(a: Manifest, b: Manifest): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((key) => canonicalJson((a as Record<string, unknown>)[key]) !== canonicalJson((b as Record<string, unknown>)[key]))
    .sort();
}

export function sortDiscrepancies(list: Discrepancy[]): Discrepancy[] {
  const key = (d: Discrepancy) => `${d.code}\u0000${d.id ?? ""}\u0000${d.key ?? ""}\u0000${d.detail ?? ""}`;
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function countByCode(list: readonly Discrepancy[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of list) out[d.code] = (out[d.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Every blocking finding in a snapshot, derived from its data alone. Export
 * puts these in its report; import recomputes them and refuses --execute
 * while any remain unaccepted.
 */
export function blockingIssues(
  library: { readings: readonly LibraryEntry[]; tombstones: readonly string[] },
  controlPlane: { tables: Record<string, Record<string, unknown>[]> },
  tenantId: string,
): Discrepancy[] {
  const issues: Discrepancy[] = [];
  // readings has no foreign key to users, so without this the library would
  // commit with no account behind it, outside every deletion path.
  if (!(controlPlane.tables.users ?? []).some((user) => user.id === tenantId)) {
    issues.push({ code: "tenant_account_missing", id: tenantId, detail: "no users row for the exported tenant" });
  }
  const tombstoned = new Set(library.tombstones);
  const seen = new Map<string, string>();
  for (const entry of library.readings) {
    const previous = seen.get(entry.id);
    if (previous !== undefined) {
      issues.push({ code: "duplicate_reading_id", id: entry.id, detail: `${previous} and ${entry.key_prefix}` });
    }
    seen.set(entry.id, entry.key_prefix);
    const parsed = parseEntry(entry);
    if (!parsed.ok) {
      issues.push({ code: "malformed_manifest", id: entry.id, key: entry.key_prefix, detail: parsed.error });
      continue;
    }
    const manifest = parsed.manifest;
    if (!prefixMatchesId(entry.key_prefix, entry.id)) {
      issues.push({ code: "identity_mismatch", id: entry.id, key: entry.key_prefix });
    }
    // reading_urls is keyed by this hash and lookups compute it from the URL,
    // so a wrong one imports an owner no lookup finds, and intake would claim
    // the URL a second time. A tombstoned reading is only ever skipped.
    if (!tombstoned.has(entry.id) && sha256Text(manifest.url) !== manifest.url_hash) {
      issues.push({ code: "url_hash_mismatch", id: entry.id, detail: `url_hash ${manifest.url_hash} is not sha256 of ${manifest.url}` });
    }
    if (tombstoned.has(entry.id)) issues.push({ code: "tombstoned_manifest", id: entry.id, key: entry.key_prefix });
    if (isUnresolved(manifest)) {
      issues.push({
        code: "unresolved_pending",
        id: entry.id,
        detail: `status ${manifest.status}${manifest.active_attempt ? `, active attempt ${manifest.active_attempt.id}` : ""}`,
      });
    }
    // Only a URL's owner keeps a vector, and a tombstoned reading is only
    // ever skipped, so neither needs one.
    if (manifest.status === "ready" && entry.owns_url && !tombstoned.has(entry.id)) {
      const problem = entry.embedding === null ? "no vector in the snapshot" : vectorProblem(entry.embedding.values);
      if (problem !== null) issues.push({ code: "unusable_vector", id: entry.id, detail: problem });
    }
  }
  for (const spec of CONTROL_PLANE_TABLES) {
    for (const row of controlPlane.tables[spec.table] ?? []) {
      try {
        toPgRow(spec, row);
      } catch (error) {
        issues.push({ code: "invalid_control_plane_row", key: spec.table, detail: error instanceof Error ? error.message : String(error) });
      }
      if (spec.table === "wipe_progress" && (row.completed_at_ms === null || row.completed_at_ms === undefined)) {
        issues.push({
          code: "unfinished_wipe",
          id: String(row.tenant_id),
          detail: `phase ${String(row.phase)}: only completed wipes import; let it finish (the deploy gate refuses unfinished wipes too)`,
        });
      }
    }
  }
  for (const table of Object.keys(controlPlane.tables)) {
    if (!CONTROL_PLANE_TABLES.some((spec) => spec.table === table)) {
      issues.push({ code: "invalid_control_plane_row", key: table, detail: "table has no PostgreSQL mapping" });
    }
  }
  return sortDiscrepancies(issues);
}
